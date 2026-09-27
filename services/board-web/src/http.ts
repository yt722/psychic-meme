/**
 * S01 只读 HTTP 端点（看板前端消费，`node:http`，零第三方依赖）。
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET | `/board/v1/tree` | 三级浏览（校区 → 实训室 → 工位），每级带状态统计 |
 * | GET | `/board/v1/labs/:labCode` | 某实训室下的工位与统计 |
 * | GET | `/board/v1/stations/:stationCode` | 工位详情（§3.4.4 的 6 个必需字段） |
 * | GET | `/board/v1/stations/:stationCode/history` | 工位历史状态（升序） |
 * | GET | `/board/v1/stats` | 按状态 / 按实训室 / 按校区统计 |
 * | GET | `/board/v1/events` | **S01.5 现场状态上屏**：SSE 事件流（长连接，见 `event-stream.ts`） |
 * | GET | `/board/v1/health` | 本服务健康（只读，恒 `ok:true`，含事件流诊断） |
 *
 * 统一约定（与 S08 `shell-gateway` 同一套）：
 * - 成功响应一律带 `serverTime`（`toIso(clock.now())`，东八区）；
 * - 失败响应一律走 `ServiceError.toResponse(...)`，不自己拼错误体；
 * - 查询参数 `campusCode` / `labCode` / `state` / `keyword` 走同一套 filter 校验
 *   （非法编码 → 400；格式合法但目录里没有 → 404）。
 *
 * **本层只读**：没有任何写路由；请求体一律忽略。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { ServiceError, errors, filterLogFields, isValidLabCode, isValidStationCode, safeErrorSummary, toIso, type ErrorClass } from '@peripheral/core';

import type { BoardView } from './board.js';
import { parseLastEventId, type BoardEventHub } from './event-stream.js';
import { normalizeFilter } from './filter-stats.js';
import { historyStateCount, type HistoryStore } from './history.js';
import { BOARD_PARAM } from './params.js';
import {
  STATION_STATES,
  normalizeStationState,
  type BoardFilter,
  type HistoryQuery,
  type StationState,
} from './types.js';

/** HTTP 状态码（协议常量，非业务参数） */
export const BOARD_HTTP_STATUS = {
  ok: 200,
  badRequest: 400,
  notFound: 404,
  methodNotAllowed: 405,
  conflict: 409,
  badGateway: 502,
  unavailable: 503,
  gatewayTimeout: 504,
  internal: 500,
} as const;

/** 通用错误码 → 状态码（只覆盖需要偏离四分类默认映射的几处） */
const STATUS_BY_ERROR_CODE: Readonly<Record<string, number>> = {
  'GEN-1001': BOARD_HTTP_STATUS.badRequest,
  'GEN-1002': BOARD_HTTP_STATUS.badRequest,
  'GEN-1003': BOARD_HTTP_STATUS.badRequest,
  'GEN-1099': BOARD_HTTP_STATUS.internal,
};

/**
 * 四类错误 → 状态码兜底映射（与 S08/网关/http-kit 同口径，保证前端一套处理逻辑）。
 *
 * `external-full` 用 409：契约规定满员**不可重试**（转入排队），
 * 用 503 会让通用重试中间件把"机位已满"当暂时故障自动重打。
 */
const STATUS_BY_ERROR_CLASS: Readonly<Record<ErrorClass, number>> = {
  'lease-invalid': BOARD_HTTP_STATUS.badRequest,
  'external-full': BOARD_HTTP_STATUS.conflict,
  'connect-timeout': BOARD_HTTP_STATUS.gatewayTimeout,
  'external-failure': BOARD_HTTP_STATUS.badGateway,
};

export interface BoardServerDeps {
  /** 看板视图（含目录、投影、时钟、参数） */
  view: BoardView;
  /** 历史查询（`/history` 端点用）；未注入时该端点返回 503 */
  history?: HistoryStore;
  /** 实时事件流（`/events` 端点用）；未注入时该端点返回 503 */
  eventStream?: BoardEventHub;
  /** 结构化日志出口（字段已过 `filterLogFields` 白名单） */
  logger?: (record: Record<string, unknown>) => void;
}

export interface BoardServer {
  server: Server;
  close(): Promise<void>;
}

/** 需要显式携带 HTTP 状态码的封装（错误体仍由 `ServiceError.toResponse` 生成） */
class BoardHttpError extends Error {
  readonly status: number;
  readonly serviceError: ServiceError;

  constructor(status: number, serviceError: ServiceError) {
    super(serviceError.message);
    this.name = 'BoardHttpError';
    this.status = status;
    this.serviceError = serviceError;
  }
}

export function createBoardServer(deps: BoardServerDeps): BoardServer {
  const view = deps.view;
  const clock = view.clock;
  const history = deps.history;
  const eventStream = deps.eventStream;
  const keywordMaxLength = view.params.number(BOARD_PARAM.KEYWORD_MAX_LENGTH);

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = clock.now();
    let requestId = 'req-view';
    let method = 'GET';
    let pathname = '/';

    try {
      requestId = headerOf(req, 'x-request-id') ?? 'req-view';
      method = (req.method ?? 'GET').toUpperCase();
      const url = parseUrl(req.url);
      pathname = url.pathname;

      // S01.5：事件流是长连接，不进 JSON 分发（否则 `handle` 一返回就会被当成响应结束）
      if (method === 'GET' && pathname === '/board/v1/events') {
        openEventStream(req, res, requestId);
        return;
      }

      const payload = dispatch(method, url);
      const serverTime = toIso(clock.now());
      sendJson(res, BOARD_HTTP_STATUS.ok, { ok: true, serverTime, ...payload });
      log({ requestId, serverTime, ok: true, action: `${method} ${pathname}`, durationMs: clock.now() - startedAt });
    } catch (error) {
      const serverTime = toIso(clock.now());
      const serviceError =
        error instanceof BoardHttpError
          ? error.serviceError
          : error instanceof ServiceError
            ? error
            : errors.internal(safeErrorSummary(error));

      sendJson(
        res,
        error instanceof BoardHttpError ? error.status : statusFor(serviceError),
        serviceError.toResponse(serverTime, requestId),
      );
      log({
        requestId,
        serverTime,
        ok: false,
        action: `${method} ${pathname}`,
        errorClass: serviceError.errorClass,
        errorCode: serviceError.errorCode,
        message: serviceError.message,
        retryable: serviceError.retryable,
        durationMs: clock.now() - startedAt,
      });
    }
  }

  function dispatch(method: string, url: URL): Record<string, unknown> {
    if (method !== 'GET') {
      throw new BoardHttpError(
        BOARD_HTTP_STATUS.methodNotAllowed,
        errors.badRequest({ reason: 'method-not-allowed', allowed: 'GET' }),
      );
    }

    const segments = url.pathname.split('/').filter((segment) => segment !== '');
    // 形如 /board/v1/<resource>[/<id>[/<sub>]]
    const isBoardRoute = segments.length >= 3 && segments[1] === 'v1';
    if (!isBoardRoute) throw notFound({ reason: 'route-not-found', path: url.pathname });

    const resource = segments[2];

    if (segments.length === 3 && resource === 'tree') {
      const filter = readFilter(url);
      const browse = view.browse(filter);
      return { filter, campuses: browse.campuses, stats: browse.stats };
    }

    if (segments.length === 3 && resource === 'stats') {
      const filter = readFilter(url);
      return { filter, stats: view.stats(filter) };
    }

    if (segments.length === 3 && resource === 'health') {
      return {
        size: view.size(),
        projection: view.projection.stats(),
        ...(eventStream !== undefined ? { eventStream: eventStream.stats() } : {}),
      };
    }

    if (segments.length === 4 && resource === 'labs') {
      const labCode = decodeSegment(segments[3] ?? '');
      // 格式非法 → 400（客户端写错了）；格式对但目录里没有 → 404（东西不存在）
      if (!isValidLabCode(labCode)) {
        throw errors.badRequest({ field: 'labCode', expected: 'LAB-<2位>', actual: labCode });
      }
      const filter = readFilter(url);
      if (filter.labCode !== undefined && filter.labCode !== labCode) {
        throw errors.badRequest({ field: 'labCode', reason: 'path-query-mismatch', path: labCode, query: filter.labCode });
      }
      if (!view.catalog.hasLab(labCode)) throw notFound({ reason: 'unknown-lab', labCode });

      const campus = view.catalog.campusOfLab(labCode);
      const labNode = campus.labs.find((node) => node.labCode === labCode);
      const scoped: BoardFilter = { ...filter, labCode };
      const stations = view.stations(scoped);
      return {
        filter: scoped,
        lab: { labCode, campusCode: campus.campusCode, name: labNode?.name ?? '' },
        stations,
        stats: view.stats(scoped).byState,
      };
    }

    if (segments.length >= 4 && resource === 'stations') {
      const stationCode = decodeSegment(segments[3] ?? '');
      if (!isValidStationCode(stationCode)) {
        throw errors.badRequest({
          field: 'stationCode',
          expected: 'ST-LAB<2位>-<2位>',
          actual: stationCode,
        });
      }
      if (!view.catalog.hasStation(stationCode)) {
        throw notFound({ reason: 'unknown-station', stationCode });
      }

      if (segments.length === 4) {
        return { station: view.stationDetail(stationCode) };
      }

      if (segments.length === 5 && segments[4] === 'history') {
        if (history === undefined) {
          throw new BoardHttpError(
            BOARD_HTTP_STATUS.unavailable,
            errors.internal({ reason: 'history-not-configured' }),
          );
        }
        const query = readHistoryQuery(url, stationCode);
        const entries = history.query(query);
        return {
          stationCode,
          query,
          count: entries.length,
          byState: historyStateCount(entries),
          entries,
        };
      }
    }

    throw notFound({ reason: 'route-not-found', path: url.pathname });
  }

  /** 解析并**校验**筛选条件（与业务层共用 `normalizeFilter`，口径不会漂） */
  function readFilter(url: URL): BoardFilter {
    const filter: BoardFilter = {};

    const campusCode = url.searchParams.get('campusCode');
    if (campusCode !== null) filter.campusCode = campusCode;
    const labCode = url.searchParams.get('labCode');
    if (labCode !== null) filter.labCode = labCode;
    const state = url.searchParams.get('state');
    if (state !== null) {
      const normalized: StationState | undefined = normalizeStationState(state);
      if (normalized === undefined) {
        throw errors.badRequest({ field: 'state', allowed: STATION_STATES.join('|'), actual: state });
      }
      filter.state = normalized;
    }
    const keyword = url.searchParams.get('keyword');
    if (keyword !== null) filter.keyword = keyword;

    return normalizeFilter(filter, { keywordMaxLength });
  }

  function readHistoryQuery(url: URL, stationCode: string): HistoryQuery {
    const query: HistoryQuery = { stationCode };
    const fromMs = readNumber(url, 'fromMs');
    if (fromMs !== undefined) query.fromMs = fromMs;
    const toMs = readNumber(url, 'toMs');
    if (toMs !== undefined) query.toMs = toMs;
    const limit = readNumber(url, 'limit');
    if (limit !== undefined) query.limit = limit;
    return query;
  }

  function readNumber(url: URL, name: string): number | undefined {
    const raw = url.searchParams.get(name);
    if (raw === null || raw.trim() === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw errors.badRequest({ field: name, expected: 'number', actual: raw });
    }
    return value;
  }

  function sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-length', String(Buffer.byteLength(body, 'utf8')));
    res.end(body);
  }

  function log(fields: Record<string, unknown>): void {
    if (deps.logger === undefined) return;
    deps.logger(filterLogFields(fields));
  }

  /**
   * 打开 S01.5 事件流（长连接）。
   *
   * 三个刻意的选择：
   * - 能力未注入或连接满 → 走统一错误体回 **503**（不是假装推流、也不是空 200）；
   * - 响应头先写、再交给 `BoardEventHub.open`，这样"连接满"的拒绝仍能给出正确状态码；
   * - 对端断开即 `close()`，连接与订阅一起回收，避免看板被僵尸连接拖住。
   */
  function openEventStream(req: IncomingMessage, res: ServerResponse, requestId: string): void {
    if (eventStream === undefined) {
      throw new BoardHttpError(
        BOARD_HTTP_STATUS.unavailable,
        errors.internal({ reason: 'event-stream-not-configured' }),
      );
    }
    if (!eventStream.canOpen()) {
      eventStream.noteRejected();
      throw new BoardHttpError(
        BOARD_HTTP_STATUS.unavailable,
        errors.internal({ reason: 'event-stream-full', max: eventStream.stats().connections }),
      );
    }

    const lastEventId = parseLastEventId(headerOf(req, 'last-event-id'));
    const openedAtMs = clock.now();
    res.writeHead(BOARD_HTTP_STATUS.ok, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // 告诉可能存在的反向代理/中间层：这条流不能被缓冲
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();

    const handle = eventStream.open(lastEventId, {
      write: (chunk) => res.write(chunk),
      onDrain: (listener) => {
        res.once('drain', listener);
      },
      end: () => {
        res.end();
      },
    });

    log({
      requestId,
      ok: true,
      outcome: 'stream-open',
      action: 'GET /board/v1/events',
      method: 'GET',
      status: BOARD_HTTP_STATUS.ok,
      ...(lastEventId !== undefined ? { reason: `resume-from-${lastEventId}` } : {}),
    });

    req.on('close', () => {
      handle.close();
      log({
        requestId,
        ok: true,
        outcome: 'stream-close',
        action: 'GET /board/v1/events',
        method: 'GET',
        status: BOARD_HTTP_STATUS.ok,
        count: handle.stats().sentEvents,
        durationMs: clock.now() - openedAtMs,
      });
    });
  }

  function close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // 开着的推流连接必须先断，否则 `server.close()` 会一直等客户端超时
      eventStream?.closeConnections();
      if (!server.listening) {
        resolve();
        return;
      }
      // 先断空闲 keep-alive 连接，否则 close 会等到客户端超时
      server.closeIdleConnections();
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  return { server, close };
}

/** 错误 → HTTP 状态码（先看错误码，再按四分类兜底） */
export function statusFor(error: ServiceError): number {
  return STATUS_BY_ERROR_CODE[error.errorCode] ?? STATUS_BY_ERROR_CLASS[error.errorClass];
}

function notFound(details: Record<string, unknown>): BoardHttpError {
  return new BoardHttpError(BOARD_HTTP_STATUS.notFound, errors.badRequest(details));
}

function parseUrl(rawUrl: string | undefined): URL {
  try {
    return new URL(rawUrl ?? '/', 'http://board.local');
  } catch {
    throw new BoardHttpError(BOARD_HTTP_STATUS.badRequest, errors.badRequest({ reason: 'malformed-request-url' }));
  }
}

function decodeSegment(segment: string): string {
  if (segment === '') {
    throw new BoardHttpError(BOARD_HTTP_STATUS.badRequest, errors.badRequest({ reason: 'empty-path-param' }));
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new BoardHttpError(BOARD_HTTP_STATUS.badRequest, errors.badRequest({ reason: 'malformed-path-escape' }));
  }
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value.trim() === '' ? undefined : value;
}
