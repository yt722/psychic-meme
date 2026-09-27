/**
 * S01.3 筛选 / 统计 / 历史查询用例。
 *
 * 覆盖：四维筛选、非法编码拒绝、按状态/实训室/校区分布、历史保留窗口与 limit 语义。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HistoryStore,
  applyFilter,
  countByState,
  emptyStateCount,
  historyStateCount,
  normalizeFilter,
  statsOf,
  type FilterableStation,
} from '../src/index.js';
import { isBadRequest, makeRig, reportState } from './helpers.js';

const ITEMS: FilterableStation[] = [
  { stationCode: 'ST-LAB01-01', labCode: 'LAB-01', campusCode: 'CAMPUS-01', state: 'occupied', name: '装配工位1' },
  { stationCode: 'ST-LAB01-02', labCode: 'LAB-01', campusCode: 'CAMPUS-01', state: 'available', name: '装配工位2' },
  { stationCode: 'ST-LAB01-03', labCode: 'LAB-01', campusCode: 'CAMPUS-01', state: 'maintenance', name: '装配工位3' },
  { stationCode: 'ST-LAB02-01', labCode: 'LAB-02', campusCode: 'CAMPUS-01', state: 'offline', name: '包装工位1' },
  { stationCode: 'ST-LAB03-01', labCode: 'LAB-03', campusCode: 'CAMPUS-02', state: 'available', name: '物流工位1' },
];

test('四维筛选：校区 / 实训室 / 状态 / 关键词，可组合', () => {
  assert.deepEqual(
    applyFilter(ITEMS, { campusCode: 'CAMPUS-01' }).map((item) => item.stationCode),
    ['ST-LAB01-01', 'ST-LAB01-02', 'ST-LAB01-03', 'ST-LAB02-01'],
  );
  assert.deepEqual(
    applyFilter(ITEMS, { labCode: 'LAB-01' }).map((item) => item.stationCode),
    ['ST-LAB01-01', 'ST-LAB01-02', 'ST-LAB01-03'],
  );
  assert.deepEqual(
    applyFilter(ITEMS, { state: 'available' }).map((item) => item.stationCode),
    ['ST-LAB01-02', 'ST-LAB03-01'],
  );
  assert.deepEqual(
    applyFilter(ITEMS, { keyword: '物流' }).map((item) => item.stationCode),
    ['ST-LAB03-01'],
  );
  // 关键词也匹配编码（大小写不敏感）与状态字面量
  assert.deepEqual(
    applyFilter(ITEMS, { keyword: 'lab02' }).map((item) => item.stationCode),
    ['ST-LAB02-01'],
  );
  assert.equal(applyFilter(ITEMS, { keyword: 'MAINTENANCE' }).length, 1);

  // 组合：校区 + 状态
  assert.deepEqual(
    applyFilter(ITEMS, { campusCode: 'CAMPUS-01', state: 'occupied' }).map((item) => item.stationCode),
    ['ST-LAB01-01'],
  );
  assert.deepEqual(applyFilter(ITEMS, {}), ITEMS, '空筛选返回全部（且不改入参）');
  assert.deepEqual(applyFilter(ITEMS, { keyword: '  不存在  ' }), []);
});

test('非法 campusCode / labCode / state / 超长关键词一律抛 GEN-1001', () => {
  assert.throws(() => applyFilter(ITEMS, { campusCode: 'CAMPUS-1' }), isBadRequest);
  assert.throws(() => applyFilter(ITEMS, { campusCode: 'campus-01' }), isBadRequest);
  assert.throws(() => applyFilter(ITEMS, { campusCode: '东校区' }), isBadRequest);
  assert.throws(() => applyFilter(ITEMS, { labCode: 'LAB-1' }), isBadRequest);
  assert.throws(() => applyFilter(ITEMS, { labCode: 'LAB-01-01' }), isBadRequest);
  assert.throws(() => applyFilter(ITEMS, { state: 'running' as 'available' }), isBadRequest);
  assert.throws(() => applyFilter(ITEMS, { keyword: 'x'.repeat(65) }), isBadRequest);

  const details = (() => {
    try {
      normalizeFilter({ labCode: 'lab-01' });
    } catch (error) {
      return error as { errorCode?: string; details?: Record<string, unknown> };
    }
    return undefined;
  })();
  assert.equal(details?.errorCode, 'GEN-1001');
  assert.equal(details?.details?.['field'], 'labCode');

  // 契约别名 idle → available；空白关键词被丢掉
  assert.deepEqual(normalizeFilter({ state: 'idle' as 'available' }), { state: 'available' });
  assert.deepEqual(normalizeFilter({ keyword: '   ' }), {});
  assert.deepEqual(normalizeFilter({ keyword: ' 装配 ' }), { keyword: '装配' });
  assert.throws(() => normalizeFilter({ keyword: 'x'.repeat(5) }, { keywordMaxLength: 4 }), isBadRequest);
});

test('统计分布：按状态（四状态齐全）/ 按实训室 / 按校区', () => {
  const stats = statsOf(ITEMS);

  assert.equal(stats.total, 5);
  assert.deepEqual(stats.byState, { total: 5, available: 2, occupied: 1, maintenance: 1, offline: 1 });

  assert.deepEqual(
    stats.byLab.map((group) => [group.key, group.count]),
    [
      ['LAB-01', 3],
      ['LAB-02', 1],
      ['LAB-03', 1],
    ],
  );
  assert.equal(stats.byLab[0]?.campusCode, 'CAMPUS-01');
  assert.deepEqual(stats.byLab[0]?.byState, { total: 3, available: 1, occupied: 1, maintenance: 1, offline: 0 });

  assert.deepEqual(
    stats.byCampus.map((group) => [group.key, group.count]),
    [
      ['CAMPUS-01', 4],
      ['CAMPUS-02', 1],
    ],
  );
  assert.deepEqual(stats.byCampus[1]?.byState, { total: 1, available: 1, occupied: 0, maintenance: 0, offline: 0 });

  // 计数自洽：分组合计 = 总数
  const labSum = stats.byLab.reduce((sum, group) => sum + group.count, 0);
  assert.equal(labSum, stats.total);
  const campusSum = stats.byCampus.reduce((sum, group) => sum + group.count, 0);
  assert.equal(campusSum, stats.total);

  assert.deepEqual(emptyStateCount(), { total: 0, available: 0, occupied: 0, maintenance: 0, offline: 0 });
  assert.deepEqual(countByState([]), emptyStateCount());
  assert.deepEqual(statsOf([]), { total: 0, byState: emptyStateCount(), byLab: [], byCampus: [] });
  assert.throws(
    () => countByState([{ stationCode: 'ST-LAB01-01', labCode: 'LAB-01', campusCode: 'CAMPUS-01', state: 'x' as 'available' }]),
    isBadRequest,
  );
});

test('历史写入：升序返回、按工位与时间窗查询、接口参数非法即拒', () => {
  const rig = makeRig();
  try {
    const { history, clock, params, close } = rig;
    const t0 = clock.now();

    history.append({ stationCode: 'ST-LAB01-01', state: 'occupied', atMs: t0 + 3_000, sourceKind: 'real' });
    history.append({ stationCode: 'ST-LAB01-01', state: 'available', atMs: t0, sourceKind: 'real' });
    history.append({ stationCode: 'ST-LAB01-02', state: 'offline', atMs: t0 + 1_000, sourceKind: 'twin' });

    const all = history.query();
    assert.deepEqual(all.map((entry) => entry.atMs), [t0, t0 + 1_000, t0 + 3_000], '按时间升序');
    assert.equal(all[0]?.labCode, 'LAB-01', 'labCode 由工位编码推导');

    const oneStation = history.query({ stationCode: 'ST-LAB01-01' });
    assert.deepEqual(oneStation.map((entry) => entry.state), ['available', 'occupied']);

    const window = history.query({ fromMs: t0 + 500, toMs: t0 + 2_000 });
    assert.equal(window.length, 1);
    assert.equal(window[0]?.stationCode, 'ST-LAB01-02');
    assert.equal(window[0]?.sourceKind, 'twin');

    assert.throws(() => history.query({ fromMs: t0 + 10, toMs: t0 }), isBadRequest);
    assert.throws(() => history.append({ stationCode: 'XX', state: 'available', atMs: t0, sourceKind: 'real' }), isBadRequest);
    assert.throws(() => history.query({ stationCode: 'not-a-code' }), isBadRequest);
    assert.throws(() => history.append({ stationCode: 'ST-LAB01-01', state: 'x' as 'available', atMs: t0, sourceKind: 'real' }), isBadRequest);
    assert.throws(() => history.query({ limit: 0 }), isBadRequest);
    assert.throws(() => history.query({ limit: params.number('PARAM-BOARD-HISTORY-MAX-LIMIT') + 1 }), isBadRequest);
    assert.throws(
      () => history.append({ stationCode: 'ST-LAB01-01', state: 'available', atMs: t0, sourceKind: 'real', labCode: 'LAB-02' }),
      isBadRequest,
    );

    assert.equal(history.latestOf('ST-LAB01-01')?.state, 'occupied');
    assert.equal(history.latestOf('ST-LAB02-01'), undefined);
    assert.deepEqual(historyStateCount(all), { available: 1, occupied: 1, maintenance: 0, offline: 1 });
  } finally {
    rig.close();
  }
});

test('历史保留窗口与条数上限：窗口外被清理，limit 取最新 N 条', () => {
  const rig = makeRig({ own: { 'PARAM-BOARD-HISTORY-MAX-ENTRIES': 3 } });
  try {
    const { history, clock, close } = rig;
    const t0 = clock.now();

    for (let index = 0; index < 5; index += 1) {
      history.append({ stationCode: 'ST-LAB01-01', state: 'occupied', atMs: t0 + index, sourceKind: 'real' });
    }
    assert.equal(history.size(), 3, '超出条数上限丢最旧');
    assert.deepEqual(history.query().map((entry) => entry.atMs), [t0 + 2, t0 + 3, t0 + 4]);

    // limit：取最新 N 条，但仍升序
    assert.deepEqual(history.query({ limit: 2 }).map((entry) => entry.atMs), [t0 + 3, t0 + 4]);
    assert.equal(history.query({ limit: 1 })[0]?.atMs, t0 + 4);

    // 保留窗口：默认 24h，超过即清理
    assert.equal(history.retentionMs(), 24 * 60 * 60 * 1000);
    clock.advance(24 * 60 * 60 * 1000 + 1_000);
    history.append({ stationCode: 'ST-LAB02-01', state: 'available', atMs: clock.now(), sourceKind: 'real' });
    const remaining = history.query();
    assert.equal(remaining.length, 1, '窗口外条目被清理');
    assert.equal(remaining[0]?.stationCode, 'ST-LAB02-01');
    assert.equal(history.stats().entries, 1);
    assert.equal(history.stats().stations, 1);

    // 窗口参数化
    const shortWindow = makeRig({ own: { 'PARAM-BOARD-HISTORY-KEEP': 1_000 } });
    try {
      shortWindow.history.append({
        stationCode: 'ST-LAB01-01',
        state: 'available',
        atMs: shortWindow.clock.now(),
        sourceKind: 'real',
      });
      shortWindow.clock.advance(1_001);
      shortWindow.history.append({
        stationCode: 'ST-LAB01-01',
        state: 'occupied',
        atMs: shortWindow.clock.now(),
        sourceKind: 'real',
      });
      assert.equal(shortWindow.history.size(), 1);
      assert.equal(shortWindow.history.retentionMs(), 1_000);
      shortWindow.history.clear();
      assert.equal(shortWindow.history.size(), 0);
    } finally {
      shortWindow.close();
    }
  } finally {
    rig.close();
  }
});

test('历史接投影：状态迁移自动落库（含来源与校区）', () => {
  const rig = makeRig();
  try {
    const { projection, history, clock, close } = rig;
    projection.subscribe(history.listener());

    reportState(rig, 'ST-LAB01-01', 'occupied', { sourceKind: 'real' });
    reportState(rig, 'ST-LAB01-01', 'occupied', { params: { feedRate: 300 } });
    clock.advance(1_000);
    reportState(rig, 'ST-LAB01-01', 'maintenance', { sourceKind: 'twin', alarmCode: 'ALM-1001' });

    const entries = history.query({ stationCode: 'ST-LAB01-01' });
    assert.equal(entries.length, 2, '同状态重复上报不落历史');
    assert.deepEqual(entries.map((entry) => entry.state), ['occupied', 'maintenance']);
    assert.equal(entries[0]?.campusCode, 'CAMPUS-01');
    assert.equal(entries[1]?.sourceKind, 'twin');
    assert.equal(entries[1]?.alarmCode, 'ALM-1001');

    // 从未上报的工位没有历史
    assert.equal(history.query({ stationCode: 'ST-LAB03-02' }).length, 0);
  } finally {
    rig.close();
  }
});

test('看板统计与筛选统计口径一致（同一批数据两处算法得到同一结果）', () => {
  const rig = makeRig();
  try {
    const { view, close } = rig;

    reportState(rig, 'ST-LAB01-01', 'occupied');
    reportState(rig, 'ST-LAB01-02', 'occupied');
    reportState(rig, 'ST-LAB02-01', 'available');

    const boardStats = view.stats();
    assert.equal(boardStats.total, 9);
    assert.equal(boardStats.byState.occupied, 2);
    assert.equal(boardStats.byState.available, 1);
    assert.equal(boardStats.byState.offline, 6);

    const filtered = view.stats({ campusCode: 'CAMPUS-02', state: 'offline' });
    assert.equal(filtered.total, 2);
    assert.deepEqual(filtered.byLab.map((group) => group.key), ['LAB-03']);

    assert.deepEqual(statsOf(view.stations()), boardStats);
    assert.throws(() => view.stats({ campusCode: 'CAMPUS-9' }), isBadRequest);
  } finally {
    rig.close();
  }
});

test('HistoryStore 可独立构造（默认系统时钟 + 默认参数容器）', () => {
  const store = new HistoryStore();
  assert.equal(store.size(), 0);
  assert.equal(store.retentionMs(), 24 * 60 * 60 * 1000);
  assert.equal(store.maxEntries(), 20_000);
  assert.deepEqual(store.query(), []);

  const entry = store.append({ stationCode: 'ST-LAB01-07', state: 'available', atMs: Date.now(), sourceKind: 'manual' });
  assert.equal(entry.labCode, 'LAB-01');
  assert.equal(store.query().length, 1);
});
