/**
 * 只读 HTTP 端点用例：真实 `node:http` 监听（`listen(0)` 动态端口）+ 全局 `fetch` 调用。
 *
 * 覆盖：5 个端点、统一 `serverTime`、错误统一走 `ServiceError.toResponse`、
 * 400/404/405 的边界（格式非法 vs 目录里没有）、查询参数筛选、日志白名单。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { GEN } from '@peripheral/core';

import {
  BOARD_HTTP_STATUS,
  REQUIRED_DETAIL_FIELDS,
  createBoardServer,
  type BoardServer,
  type HistoryStore,
  type BoardView,
} from '../src/index.js';
import { ISO_RE, makeRig, reportState } from './helpers.js';

interface CallResult {
  status: number;
  body: Record<string, unknown>;
}

interface Harness {
  base: string;
  close: () => Promise<void>;
  rig: ReturnType<typeof makeRig>;
  logs: Record<string, unknown>[];
}

async function startHarness(options: { history?: boolean; withHistoryStore?: HistoryStore } = {}): Promise<Harness> {
  const rig = makeRig();
  const logs: Record<string, unknown>[] = [];
  const deps: Parameters<typeof createBoardServer>[0] = {
    view: rig.view as BoardView,
    logger: (record) => logs.push(record),
  };
  if (options.history !== false) deps.history = options.withHistoryStore ?? rig.history;

  const server: BoardServer = createBoardServer(deps);
  await new Promise<void>((resolve) => {
    server.server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.server.address();
  if (address === null || typeof address === 'string') throw new Error('未取得监听地址');
  const { port } = address as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    rig,
    logs,
    close: async () => {
      await server.close();
      rig.close();
    },
  };
}

async function get(base: string, path: string): Promise<CallResult> {
  const response = await fetch(`${base}${path}`, { method: 'GET' });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function assertErrorBody(body: Record<string, unknown>, errorCode: string): void {
  assert.equal(body['ok'], false);
  assert.equal(body['errorCode'], errorCode);
  assert.equal(body['retryable'], false);
  assert.match(String(body['serverTime']), ISO_RE);
  assert.ok(typeof body['message'] === 'string' && String(body['message']).length > 0);
}

test('GET /board/v1/tree：三级结构 + 每级统计 + 统一 serverTime', async () => {
  const harness = await startHarness();
  try {
    reportState(harness.rig, 'ST-LAB01-01', 'occupied');
    reportState(harness.rig, 'ST-LAB02-01', 'available');

    const result = await get(harness.base, '/board/v1/tree');
    assert.equal(result.status, BOARD_HTTP_STATUS.ok);
    assert.equal(result.body['ok'], true);
    assert.match(String(result.body['serverTime']), ISO_RE);

    const campuses = result.body['campuses'] as Array<Record<string, unknown>>;
    assert.equal(campuses.length, 2);
    const campus1 = campuses[0];
    assert.ok(campus1 !== undefined);
    assert.equal(campus1['campusCode'], 'CAMPUS-01');
    const labs = campus1['labs'] as Array<Record<string, unknown>>;
    assert.deepEqual(
      labs.map((lab) => lab['labCode']),
      ['LAB-01', 'LAB-02'],
    );
    const stations = labs[0]?.['stations'] as Array<Record<string, unknown>>;
    assert.equal(stations.length, 4);
    assert.deepEqual(labs[0]?.['stats'], { total: 4, available: 0, occupied: 1, maintenance: 0, offline: 3 });
    assert.deepEqual(result.body['stats'], { total: 9, available: 1, occupied: 1, maintenance: 0, offline: 7 });
    assert.deepEqual(result.body['filter'], {});
  } finally {
    await harness.close();
  }
});

test('查询参数走同一套 filter：合法即筛，非法编码/状态 400', async () => {
  const harness = await startHarness();
  try {
    reportState(harness.rig, 'ST-LAB01-01', 'occupied');
    reportState(harness.rig, 'ST-LAB02-01', 'occupied');

    const filtered = await get(harness.base, '/board/v1/tree?campusCode=CAMPUS-01&state=occupied');
    assert.equal(filtered.status, BOARD_HTTP_STATUS.ok);
    assert.deepEqual(filtered.body['filter'], { campusCode: 'CAMPUS-01', state: 'occupied' });
    assert.deepEqual(filtered.body['stats'], { total: 2, available: 0, occupied: 2, maintenance: 0, offline: 0 });
    const campuses = filtered.body['campuses'] as Array<Record<string, unknown>>;
    assert.equal(campuses.length, 1);

    const keyword = await get(harness.base, '/board/v1/tree?keyword=%E7%89%A9%E6%B5%81');
    assert.equal(keyword.status, BOARD_HTTP_STATUS.ok);
    assert.deepEqual(keyword.body['stats'], { total: 2, available: 0, occupied: 0, maintenance: 0, offline: 2 });

    // 契约别名 idle → available
    const alias = await get(harness.base, '/board/v1/tree?state=idle');
    assert.equal(alias.status, BOARD_HTTP_STATUS.ok);
    assert.deepEqual(alias.body['filter'], { state: 'available' });

    const badState = await get(harness.base, '/board/v1/tree?state=running');
    assert.equal(badState.status, BOARD_HTTP_STATUS.badRequest);
    assertErrorBody(badState.body, GEN.badRequest);

    const badCampus = await get(harness.base, '/board/v1/tree?campusCode=CAMPUS-1');
    assert.equal(badCampus.status, BOARD_HTTP_STATUS.badRequest);
    assert.equal((badCampus.body['details'] as Record<string, unknown>)['field'], 'campusCode');

    const badKeyword = await get(harness.base, `/board/v1/tree?keyword=${'x'.repeat(65)}`);
    assert.equal(badKeyword.status, BOARD_HTTP_STATUS.badRequest);
    assert.equal((badKeyword.body['details'] as Record<string, unknown>)['reason'], 'too-long');
  } finally {
    await harness.close();
  }
});

test('GET /board/v1/labs/:labCode：实训室工位与统计；未知 404、非法 400', async () => {
  const harness = await startHarness();
  try {
    reportState(harness.rig, 'ST-LAB01-02', 'maintenance');

    const ok = await get(harness.base, '/board/v1/labs/LAB-01');
    assert.equal(ok.status, BOARD_HTTP_STATUS.ok);
    assert.deepEqual(ok.body['lab'], { labCode: 'LAB-01', campusCode: 'CAMPUS-01', name: '智能装配实训室' });
    assert.equal((ok.body['stations'] as unknown[]).length, 4);
    assert.deepEqual(ok.body['stats'], { total: 4, available: 0, occupied: 0, maintenance: 1, offline: 3 });
    assert.deepEqual(ok.body['filter'], { labCode: 'LAB-01' });

    const scoped = await get(harness.base, '/board/v1/labs/LAB-01?state=maintenance');
    assert.equal((scoped.body['stations'] as unknown[]).length, 1);

    const mismatch = await get(harness.base, '/board/v1/labs/LAB-01?labCode=LAB-02');
    assert.equal(mismatch.status, BOARD_HTTP_STATUS.badRequest);
    assert.equal((mismatch.body['details'] as Record<string, unknown>)['reason'], 'path-query-mismatch');

    const unknown = await get(harness.base, '/board/v1/labs/LAB-09');
    assert.equal(unknown.status, BOARD_HTTP_STATUS.notFound);
    assert.equal((unknown.body['details'] as Record<string, unknown>)['reason'], 'unknown-lab');
    assertErrorBody(unknown.body, GEN.badRequest);

    const malformed = await get(harness.base, '/board/v1/labs/lab-01');
    assert.equal(malformed.status, BOARD_HTTP_STATUS.badRequest);
  } finally {
    await harness.close();
  }
});

test('GET /board/v1/stations/:stationCode：详情 6 字段齐全；未知 404、非法 400', async () => {
  const harness = await startHarness();
  try {
    reportState(harness.rig, 'ST-LAB03-01', 'occupied', {
      sourceKind: 'twin',
      params: { programNo: 'O1024' },
      alarmCode: 'ALM-1001',
    });

    const ok = await get(harness.base, '/board/v1/stations/ST-LAB03-01');
    assert.equal(ok.status, BOARD_HTTP_STATUS.ok);
    const station = ok.body['station'] as Record<string, unknown>;
    for (const field of REQUIRED_DETAIL_FIELDS) assert.ok(field in station, `缺字段 ${field}`);
    assert.equal(station['stationCode'], 'ST-LAB03-01');
    assert.equal(station['labCode'], 'LAB-03');
    assert.equal(station['state'], 'occupied');
    assert.match(String(station['updatedAt']), ISO_RE);
    assert.equal(station['sourceKind'], 'twin');
    assert.deepEqual(station['params'], { programNo: 'O1024' });
    assert.equal(station['alarmCode'], 'ALM-1001');
    assert.match(String(ok.body['serverTime']), ISO_RE);

    const unknown = await get(harness.base, '/board/v1/stations/ST-LAB09-01');
    assert.equal(unknown.status, BOARD_HTTP_STATUS.notFound);
    assert.equal((unknown.body['details'] as Record<string, unknown>)['reason'], 'unknown-station');

    const malformed = await get(harness.base, '/board/v1/stations/ST-A01-01');
    assert.equal(malformed.status, BOARD_HTTP_STATUS.badRequest);
    assert.equal((malformed.body['details'] as Record<string, unknown>)['expected'], 'ST-LAB<2位>-<2位>');

    // 路径层级不对 → 404（不是把 /stations 当成别的路由）
    const wrongDepth = await get(harness.base, '/board/v1/stations/ST-LAB01-01/nope');
    assert.equal(wrongDepth.status, BOARD_HTTP_STATUS.notFound);
    assert.equal((wrongDepth.body['details'] as Record<string, unknown>)['reason'], 'route-not-found');
  } finally {
    await harness.close();
  }
});

test('GET /board/v1/stations/:stationCode/history：升序历史；缺历史存储 503；条件非法 400', async () => {
  const harness = await startHarness();
  try {
    const { history, clock } = harness.rig;
    const t0 = clock.now();
    history.append({ stationCode: 'ST-LAB01-01', state: 'occupied', atMs: t0, sourceKind: 'real' });
    history.append({ stationCode: 'ST-LAB01-01', state: 'available', atMs: t0 + 60_000, sourceKind: 'real' });
    history.append({ stationCode: 'ST-LAB01-02', state: 'offline', atMs: t0 + 30_000, sourceKind: 'twin' });

    const ok = await get(harness.base, '/board/v1/stations/ST-LAB01-01/history');
    assert.equal(ok.status, BOARD_HTTP_STATUS.ok);
    assert.equal(ok.body['count'], 2);
    assert.deepEqual(ok.body['byState'], { available: 1, occupied: 1, maintenance: 0, offline: 0 });
    const entries = ok.body['entries'] as Array<Record<string, unknown>>;
    assert.deepEqual(entries.map((entry) => entry['state']), ['occupied', 'available']);
    assert.equal(entries[0]?.['labCode'], 'LAB-01');
    assert.match(String(ok.body['serverTime']), ISO_RE);

    const windowed = await get(
      harness.base,
      `/board/v1/stations/ST-LAB01-01/history?fromMs=${t0 + 1}&limit=1`,
    );
    assert.equal(windowed.body['count'], 1);
    assert.equal((windowed.body['entries'] as Array<Record<string, unknown>>)[0]?.['state'], 'available');

    const reversed = await get(harness.base, `/board/v1/stations/ST-LAB01-01/history?fromMs=100&toMs=10`);
    assert.equal(reversed.status, BOARD_HTTP_STATUS.badRequest);
    assert.equal((reversed.body['details'] as Record<string, unknown>)['reason'], 'from-after-to');

    const badLimit = await get(harness.base, '/board/v1/stations/ST-LAB01-01/history?limit=abc');
    assert.equal(badLimit.status, BOARD_HTTP_STATUS.badRequest);
    assert.equal((badLimit.body['details'] as Record<string, unknown>)['field'], 'limit');

    const unknown = await get(harness.base, '/board/v1/stations/ST-LAB09-01/history');
    assert.equal(unknown.status, BOARD_HTTP_STATUS.notFound);
  } finally {
    await harness.close();
  }

  // 未注入历史存储 → 503（可读的其他端点不受影响）
  const noHistory = await startHarness({ history: false });
  try {
    const legacy = await get(noHistory.base, '/board/v1/stations/ST-LAB01-01/history');
    assert.equal(legacy.status, BOARD_HTTP_STATUS.unavailable);
    assert.equal((legacy.body['details'] as Record<string, unknown>)['reason'], 'history-not-configured');
    assert.equal((await get(noHistory.base, '/board/v1/tree')).status, BOARD_HTTP_STATUS.ok);
  } finally {
    await noHistory.close();
  }
});

test('GET /board/v1/stats 与只读纪律：方法不符 405、未知路由 404、日志走白名单', async () => {
  const harness = await startHarness();
  try {
    reportState(harness.rig, 'ST-LAB01-01', 'occupied');
    reportState(harness.rig, 'ST-LAB01-02', 'maintenance');

    const stats = await get(harness.base, '/board/v1/stats');
    assert.equal(stats.status, BOARD_HTTP_STATUS.ok);
    const breakdown = stats.body['stats'] as Record<string, unknown>;
    assert.equal(breakdown['total'], 9);
    assert.deepEqual((breakdown['byState'] as Record<string, number>)['occupied'], 1);
    assert.deepEqual((breakdown['byState'] as Record<string, number>)['maintenance'], 1);
    assert.deepEqual(
      (breakdown['byCampus'] as Array<Record<string, unknown>>).map((group) => group['key']),
      ['CAMPUS-01', 'CAMPUS-02'],
    );

    const scopedStats = await get(harness.base, '/board/v1/stats?labCode=LAB-01');
    assert.equal((scopedStats.body['stats'] as Record<string, unknown>)['total'], 4);

    // 只读：任何写方法一律 405（没有写路由可绕过）
    const posted = await fetch(`${harness.base}/board/v1/tree`, { method: 'POST', body: '{}' });
    assert.equal(posted.status, BOARD_HTTP_STATUS.methodNotAllowed);
    const postedBody = (await posted.json()) as Record<string, unknown>;
    assert.equal((postedBody['details'] as Record<string, unknown>)['allowed'], 'GET');

    const deleted = await fetch(`${harness.base}/board/v1/stations/ST-LAB01-01`, { method: 'DELETE' });
    assert.equal(deleted.status, BOARD_HTTP_STATUS.methodNotAllowed);

    const notFound = await get(harness.base, '/board/v1/nope');
    assert.equal(notFound.status, BOARD_HTTP_STATUS.notFound);
    assert.equal((notFound.body['details'] as Record<string, unknown>)['reason'], 'route-not-found');

    const outsideBoard = await get(harness.base, '/shell/health');
    assert.equal(outsideBoard.status, BOARD_HTTP_STATUS.notFound);

    const health = await get(harness.base, '/board/v1/health');
    assert.equal(health.status, BOARD_HTTP_STATUS.ok);
    assert.equal(health.body['ok'], true);

    // 日志白名单：不出现任何凭据形态字段
    assert.ok(harness.logs.length >= 5);
    for (const record of harness.logs) {
      for (const key of Object.keys(record)) {
        assert.ok(!/token|ticket|credential|authorization|password/i.test(key), `日志出现敏感字段 ${key}`);
      }
    }
    assert.ok(harness.logs.some((record) => record['ok'] === false));
  } finally {
    await harness.close();
  }
});
