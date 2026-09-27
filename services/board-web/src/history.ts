/**
 * 历史状态查询（S01.3）。
 *
 * 口径：
 * - **保留窗口参数化**（`PARAM-BOARD-HISTORY-KEEP`，默认 24h）+ 条数上限
 *   （`PARAM-BOARD-HISTORY-MAX-ENTRIES`），窗口外 / 超限条目在写入与查询时被清理。
 * - 查询**按时间升序**返回；`fromMs > toMs` 抛 `GEN-1001`（空结果与"查反了"必须能区分）。
 * - `limit` 语义：取窗口内**最新** N 条（返回仍升序）——看板历史面板要的是"最近的现场"。
 *
 * 数据来源：`StationProjection.subscribe` 的迁移事件（见 {@link HistoryStore.listener}）。
 */

import { errors, isValidStationCode, labCodeOfStation, SystemClock } from '@peripheral/core';
import type { Clock } from '@peripheral/core';

import { defaultBoardParams, BOARD_PARAM, type BoardParams } from './params.js';
import {
  assertStationCode,
  parseAtMs,
  parseOptionalText,
  parseRealtimeParams,
  parseSourceKind,
  parseStationState,
  type HistoryEntry,
  type HistoryEntryInput,
  type HistoryQuery,
  type StationState,
} from './types.js';
import type { ProjectionEvent } from './projection.js';

export interface HistoryStoreDeps {
  params?: BoardParams;
  clock?: Clock;
}

export class HistoryStore {
  readonly #params: BoardParams;
  readonly #clock: Clock;
  /** 恒定按 `atMs` 升序；同刻按写入先后 */
  #entries: HistoryEntry[] = [];

  constructor(deps: HistoryStoreDeps = {}) {
    this.#params = deps.params ?? defaultBoardParams();
    this.#clock = deps.clock ?? new SystemClock();
  }

  /**
   * 追加一条历史；编码 / 状态 / 时间非法一律抛 `GEN-1001`。
   *
   * 追加后立即按保留窗口与条数上限清理（窗口外的条目不会被留下来）。
   */
  append(input: HistoryEntryInput): HistoryEntry {
    const stationCode = assertStationCode(input.stationCode);
    const state = parseStationState(input.state);
    const atMs = parseAtMs(input.atMs);
    const sourceKind = parseSourceKind(input.sourceKind);
    const params = parseRealtimeParams(input.params);
    const alarmCode = parseOptionalText(input.alarmCode, 'alarmCode');

    // 实训室一律由工位编码推导；显式传入时只允许作为"一致性声明"，对不上即拒
    const derivedLabCode = labCodeOfStation(stationCode);
    if (input.labCode !== undefined && input.labCode !== derivedLabCode) {
      throw errors.badRequest({ field: 'labCode', reason: 'lab-station-mismatch', labCode: input.labCode, stationCode });
    }
    const labCode = derivedLabCode;

    const entry: HistoryEntry = {
      stationCode,
      labCode,
      state,
      atMs,
      sourceKind,
      params,
      ...(input.campusCode !== undefined ? { campusCode: input.campusCode } : {}),
      ...(alarmCode !== undefined ? { alarmCode } : {}),
    };

    this.#insert(entry);
    this.#trim();
    return entry;
  }

  /** 查询历史（升序）；非法条件抛 `GEN-1001` */
  query(query: HistoryQuery = {}): HistoryEntry[] {
    this.#trim();

    const fromMs = query.fromMs === undefined ? undefined : parseAtMs(query.fromMs, 'fromMs');
    const toMs = query.toMs === undefined ? undefined : parseAtMs(query.toMs, 'toMs');
    if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
      throw errors.badRequest({ field: 'fromMs', reason: 'from-after-to', fromMs, toMs });
    }

    const stationCode = query.stationCode === undefined ? undefined : assertStationCode(query.stationCode);

    const limit = this.#resolveLimit(query.limit);

    const matched = this.#entries.filter((entry) => {
      if (stationCode !== undefined && entry.stationCode !== stationCode) return false;
      if (fromMs !== undefined && entry.atMs < fromMs) return false;
      if (toMs !== undefined && entry.atMs > toMs) return false;
      return true;
    });

    // limit：取最新 N 条，但仍以升序返回
    return matched.length <= limit ? matched : matched.slice(matched.length - limit);
  }

  /** 某工位的最新一条历史 */
  latestOf(stationCode: string): HistoryEntry | undefined {
    const code = assertStationCode(stationCode);
    this.#trim();
    for (let i = this.#entries.length - 1; i >= 0; i -= 1) {
      const entry = this.#entries[i];
      if (entry !== undefined && entry.stationCode === code) return entry;
    }
    return undefined;
  }

  size(): number {
    this.#trim();
    return this.#entries.length;
  }

  /** 保留窗口（毫秒） */
  retentionMs(): number {
    return this.#params.number(BOARD_PARAM.HISTORY_KEEP);
  }

  /** 条数上限 */
  maxEntries(): number {
    return this.#params.number(BOARD_PARAM.HISTORY_MAX_ENTRIES);
  }

  clear(): void {
    this.#entries = [];
  }

  /**
   * 把投影迁移事件直接接进历史（返回可直接交给 `projection.subscribe` 的监听器）。
   *
   * 迁移事件里没有"状态值没变但参数变了"的信息，因此历史只记**状态迁移**；
   * 若要全量轨迹，应改为订阅上行入口而不是投影事件。
   */
  listener(): (event: ProjectionEvent) => void {
    return (event: ProjectionEvent) => {
      this.append({
        stationCode: event.stationCode,
        state: event.to,
        atMs: event.atMs,
        sourceKind: event.record.sourceKind,
        campusCode: event.record.campusCode,
        ...(event.record.alarmCode !== undefined ? { alarmCode: event.record.alarmCode } : {}),
        params: event.record.params,
      });
    };
  }

  /** 诊断快照 */
  stats(): { entries: number; retentionMs: number; maxEntries: number; stations: number } {
    this.#trim();
    return {
      entries: this.#entries.length,
      retentionMs: this.retentionMs(),
      maxEntries: this.maxEntries(),
      stations: new Set(this.#entries.map((entry) => entry.stationCode)).size,
    };
  }

  /* ------------------------------------------------------------ 内部 */

  #resolveLimit(limit: number | undefined): number {
    if (limit === undefined) return this.#params.number(BOARD_PARAM.HISTORY_DEFAULT_LIMIT);
    if (typeof limit !== 'number' || !Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
      throw errors.badRequest({ field: 'limit', reason: 'positive-integer-required', actual: String(limit) });
    }
    const max = this.#params.number(BOARD_PARAM.HISTORY_MAX_LIMIT);
    if (limit > max) {
      throw errors.badRequest({ field: 'limit', reason: 'exceeds-max', max });
    }
    return limit;
  }

  /** 二分插入，保持升序（同刻后写者在后） */
  #insert(entry: HistoryEntry): void {
    let lo = 0;
    let hi = this.#entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const current = this.#entries[mid];
      if (current !== undefined && current.atMs <= entry.atMs) lo = mid + 1;
      else hi = mid;
    }
    this.#entries.splice(lo, 0, entry);
  }

  /** 窗口外与超限清理（写入与查询都会触发） */
  #trim(): void {
    const now = this.#clock.now();
    const oldestAllowed = now - this.retentionMs();
    if (this.#entries.length > 0 && (this.#entries[0]?.atMs ?? now) < oldestAllowed) {
      this.#entries = this.#entries.filter((entry) => entry.atMs >= oldestAllowed);
    }

    const max = this.maxEntries();
    if (this.#entries.length > max) {
      this.#entries = this.#entries.slice(this.#entries.length - max);
    }
  }
}

/**
 * 历史统计（按状态分布），供 `/board/v1/stations/:code/history` 的摘要使用。
 * 与 `filter-stats.statsOf` 分开：这里输入的是历史条目（无 `name`，同一状态可能重复出现）。
 */
export function historyStateCount(entries: readonly HistoryEntry[]): Record<StationState, number> {
  const count: Record<StationState, number> = { available: 0, occupied: 0, maintenance: 0, offline: 0 };
  for (const entry of entries) {
    // 条目允许由外部构造，故此处再校验一次状态（不信任 `HistoryEntry` 的静态类型）
    const state = parseStationState(entry.state, 'state');
    count[state] += 1;
  }
  return count;
}
