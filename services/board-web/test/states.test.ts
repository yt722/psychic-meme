/**
 * S01.2 工位状态用例：四状态、判离线 / 判在线、订阅，
 * 以及验收项 A-02 的硬约束——**工位状态只做投影，绝不由资源池水位推导**。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  POOL_LEVEL_FIELDS,
  assertNoPoolLevelDerivation,
  type ProjectionEvent,
  type StationState,
} from '../src/index.js';
import { isBadRequest, makeRig, reportState } from './helpers.js';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * 去掉注释后再审计。
 *
 * 必要：本包**故意**在文档注释里写明"禁止写 `used >= capacity`"，
 * 不去注释会把"反面教材"当成违规代码。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

test('四状态写入与读取：apply 后 stateOf / recordOf / snapshot 一致', () => {
  const rig = makeRig();
  try {
    const { projection, clock, close } = rig;

    reportState(rig, 'ST-LAB01-01', 'available');
    assert.equal(projection.stateOf('ST-LAB01-01'), 'available');

    const record = projection.applyState({
      stationCode: 'ST-LAB01-01',
      state: 'occupied',
      atMs: clock.now(),
      sourceKind: 'real',
      params: { spindleSpeed: 1480, programNo: 'O1024' },
    });

    assert.equal(record.stationCode, 'ST-LAB01-01');
    assert.equal(record.labCode, 'LAB-01');
    assert.equal(record.campusCode, 'CAMPUS-01');
    assert.equal(record.state, 'occupied');
    assert.equal(record.upstreamState, 'occupied');
    assert.equal(record.sourceKind, 'real');
    assert.equal(record.judgedOffline, false);
    assert.equal(record.params['spindleSpeed'], 1480);

    assert.equal(projection.stateOf('ST-LAB01-01'), 'occupied');
    assert.equal(projection.recordOf('ST-LAB01-01')?.state, 'occupied');
    assert.equal(projection.snapshot().length, 1);

    // 契约口径的 idle 归一化为 available（只在入口归一，库里只留展示口径）
    reportState(rig, 'ST-LAB02-01', 'idle');
    assert.equal(projection.stateOf('ST-LAB02-01'), 'available');
    assert.equal(projection.recordOf('ST-LAB02-01')?.upstreamState, 'available');
  } finally {
    rig.close();
  }
});

test('未知工位 / 非法编码 / 非法状态一律拒绝（脏数据不进看板）', () => {
  const rig = makeRig();
  try {
    const { projection, clock, close } = rig;

    assert.throws(
      () => projection.applyState({ stationCode: 'ST-LAB09-01', state: 'available', atMs: clock.now(), sourceKind: 'real' }),
      isBadRequest,
    );
    assert.throws(
      () => projection.applyState({ stationCode: 'ST-A01-01', state: 'available', atMs: clock.now(), sourceKind: 'real' }),
      isBadRequest,
    );
    assert.throws(
      () =>
        projection.applyState({
          stationCode: 'ST-LAB01-01',
          state: 'running' as StationState,
          atMs: clock.now(),
          sourceKind: 'real',
        }),
      isBadRequest,
    );
    assert.throws(
      () =>
        projection.applyState({
          stationCode: 'ST-LAB01-01',
          state: 'available',
          atMs: Number.NaN,
          sourceKind: 'real',
        }),
      isBadRequest,
    );
    assert.throws(
      () =>
        projection.applyState({
          stationCode: 'ST-LAB01-01',
          state: 'available',
          atMs: clock.now(),
          sourceKind: 'satellite' as 'real',
        }),
      isBadRequest,
    );

    // 读路径同样不放过未知工位
    assert.throws(() => projection.stateOf('ST-LAB99-99'), isBadRequest);
    assert.throws(() => projection.recordOf('nope'), isBadRequest);

    // 被拒绝的载荷不得留下任何记录
    assert.deepEqual(projection.snapshot(), []);
    assert.equal(projection.stats().applied, 0);
  } finally {
    rig.close();
  }
});

test('判离线：静默超过 PARAM-OFFLINE-JUDGE 展示为 offline 并产出 no-report 迁移', () => {
  const rig = makeRig();
  try {
    const { projection, params, clock, close } = rig;
    const events: ProjectionEvent[] = [];
    projection.subscribe((event) => events.push(event));

    reportState(rig, 'ST-LAB01-01', 'occupied');
    const judgeMs = params.offlineJudgeMs();

    clock.advance(judgeMs - 1);
    assert.equal(projection.stateOf('ST-LAB01-01'), 'occupied', '未到阈值不得判离线');

    clock.advance(1);
    assert.equal(projection.stateOf('ST-LAB01-01'), 'offline');

    const offline = events.filter((event) => event.reason === 'no-report');
    assert.equal(offline.length, 1);
    assert.equal(offline[0]?.stationCode, 'ST-LAB01-01');
    assert.equal(offline[0]?.from, 'occupied');
    assert.equal(offline[0]?.to, 'offline');

    // 展示态是 offline，但设备自报的原始态仍记着 occupied（恢复时要用）
    assert.equal(projection.recordOf('ST-LAB01-01')?.upstreamState, 'occupied');
    assert.equal(projection.recordOf('ST-LAB01-01')?.judgedOffline, true);
    assert.equal(projection.isJudgedOffline('ST-LAB01-01'), true);

    // 幂等：再次推进不重复产出迁移
    assert.deepEqual(projection.evaluate(), []);
    assert.equal(events.filter((event) => event.reason === 'no-report').length, 1);
  } finally {
    rig.close();
  }
});

test('判在线恢复：必须累计满 PARAM-ONLINE-JUDGE 才回到设备自报状态', () => {
  const rig = makeRig();
  try {
    const { projection, params, clock, close } = rig;
    const events: ProjectionEvent[] = [];
    projection.subscribe((event) => events.push(event));

    const onlineJudge = params.onlineJudgeMs();
    reportState(rig, 'ST-LAB01-01', 'occupied');
    clock.advance(params.offlineJudgeMs());
    assert.equal(projection.stateOf('ST-LAB01-01'), 'offline');

    // 第一次恢复上报：记账但不立即恢复
    reportState(rig, 'ST-LAB01-01', 'occupied');
    assert.equal(projection.stateOf('ST-LAB01-01'), 'offline');

    // 持续上报但未满窗口
    clock.advance(onlineJudge / 2);
    reportState(rig, 'ST-LAB01-01', 'occupied');
    assert.equal(projection.stateOf('ST-LAB01-01'), 'offline');

    // 满窗口 → 恢复
    clock.advance(onlineJudge / 2);
    reportState(rig, 'ST-LAB01-01', 'occupied');
    assert.equal(projection.stateOf('ST-LAB01-01'), 'occupied');
    assert.equal(projection.isJudgedOffline('ST-LAB01-01'), false);

    const recovered = events.filter((event) => event.reason === 'recovered');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.from, 'offline');
    assert.equal(recovered[0]?.to, 'occupied');
  } finally {
    rig.close();
  }
});

test('恢复期内再次静默 → 恢复计时清零（不把"断续心跳"当恢复）', () => {
  const rig = makeRig();
  try {
    const { projection, params, clock, close } = rig;

    reportState(rig, 'ST-LAB01-01', 'available');
    clock.advance(params.offlineJudgeMs());
    projection.evaluate();
    assert.equal(projection.stateOf('ST-LAB01-01'), 'offline');

    reportState(rig, 'ST-LAB01-01', 'available');
    // 恢复期内又静默超过判离线窗口
    clock.advance(params.offlineJudgeMs());
    projection.evaluate();
    assert.equal(projection.stateOf('ST-LAB01-01'), 'offline');

    // 重新计时后只上报一次不够恢复
    reportState(rig, 'ST-LAB01-01', 'available');
    assert.equal(projection.stateOf('ST-LAB01-01'), 'offline');

    // 满 ONLINE-JUDGE 才恢复
    clock.advance(params.onlineJudgeMs());
    reportState(rig, 'ST-LAB01-01', 'available');
    assert.equal(projection.stateOf('ST-LAB01-01'), 'available');
  } finally {
    rig.close();
  }
});

test('A-02：资源池水位（占用数/容量）变化不改工位状态显示', () => {
  const rig = makeRig();
  try {
    const { view, projection, clock, close } = rig;

    // ① 状态源报"空闲"。资源池给一个"满池"的水位，看板不得因此改口。
    const pool = { poolId: 'RP-SEAT-LAB01', used: 4, capacity: 4 };
    reportState(rig, 'ST-LAB01-01', 'available', { params: { poolUsed: pool.used } });
    assert.equal(view.stationDetail('ST-LAB01-01').state, 'available');

    // ② 水位从满池 → 空池，再满池，反复横跳：工位状态一动不动。
    for (const [used, capacity] of [
      [0, 4],
      [4, 4],
      [2, 4],
      [4, 0],
    ] as const) {
      pool.used = used;
      pool.capacity = capacity;
      assert.equal(
        view.stationDetail('ST-LAB01-01').state,
        'available',
        `水位 ${used}/${capacity} 不得影响工位状态`,
      );
      assert.equal(view.stations({ state: 'occupied' }).length, 0, '水位不得让任何工位变成占用');
      assert.equal(projection.stateOf('ST-LAB01-01'), 'available');
    }

    // ③ 反过来：状态源报"占用"，即使池子全空，也必须是 occupied。
    pool.used = 0;
    pool.capacity = 64;
    reportState(rig, 'ST-LAB01-02', 'occupied');
    assert.equal(view.stationDetail('ST-LAB01-02').state, 'occupied');
    assert.equal(view.browse().stats.occupied, 1);

    // ④ 只给水位、不给 state 的载荷被显式拒绝（让"想推状态"的代码第一次调用就暴露）。
    assert.throws(
      () =>
        projection.applyState({
          stationCode: 'ST-LAB01-03',
          atMs: clock.now(),
          sourceKind: 'gateway',
          used: 4,
          capacity: 4,
        } as unknown as Parameters<typeof projection.applyState>[0]),
      (error: unknown) => {
        assert.ok(isBadRequest(error));
        assert.equal(
          (error as { details?: Record<string, unknown> }).details?.['reason'],
          'state-required-not-derived-from-pool-level',
        );
        assert.equal((error as { details?: Record<string, unknown> }).details?.['field'], 'state');
        return true;
      },
    );
    assert.throws(() => assertNoPoolLevelDerivation({ used: 1, capacity: 2 }), isBadRequest);
    assert.doesNotThrow(() => assertNoPoolLevelDerivation({ state: 'available', used: 1, capacity: 2 }));
    assert.ok(POOL_LEVEL_FIELDS.length >= 8);

    // ⑤ 投影对象上不存在任何"水位入参"接口（没有 API 就没有推导路径）
    const surface = new Set([
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(projection)),
      ...Object.keys(projection),
    ]);
    for (const name of surface) {
      assert.ok(
        !/pool|level|capacity|water|occupanc|used/i.test(name),
        `投影不得暴露水位相关接口：${name}`,
      );
    }
  } finally {
    rig.close();
  }
});

test('A-02：源码静态审计——不存在"水位推状态"的算术写法', () => {
  const files = readdirSync(SRC_DIR).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length >= 9, `src 下应有 9 个模块，实际 ${files.length}`);

  const forbidden: Array<{ pattern: RegExp; why: string }> = [
    { pattern: /used\s*[<>]=?\s*capacity/, why: '按占用数/容量大小关系推状态' },
    { pattern: /capacity\s*-\s*used/, why: '按剩余容量推可用性' },
    { pattern: /occupan(cy|ce)\s*[<>]=?\s*[\d.]/, why: '按占用率阈值推状态' },
    { pattern: /occupied\s*[:=]\s*(used|inUse|allocated)/, why: '把占用数直接当 occupied' },
    { pattern: /available\s*[:=]\s*(capacity|free)/, why: '把剩余容量当 available' },
    { pattern: /occupied\s*\?\?\s*/, why: '状态兜底推导' },
  ];

  for (const file of files) {
    const text = stripComments(readFileSync(join(SRC_DIR, file), 'utf8'));
    for (const { pattern, why } of forbidden) {
      assert.ok(!pattern.test(text), `${file} 命中 A-02 禁止写法（${why}）：${String(pattern)}`);
    }
  }

  // 状态的写入必须来自入参（`state` 字段）或"判离线/恢复"这两个显式来源
  const projection = stripComments(readFileSync(join(SRC_DIR, 'projection.ts'), 'utf8'));
  assert.ok(/state:\s*upstreamState/.test(projection), '状态必须取自入参 state');
  assert.ok(/state:\s*'offline'/.test(projection), '判离线是唯一允许写 offline 的地方');
  assert.ok(!/state\s*=\s*[^'"]*(weather|random|Math\.random)/i.test(projection), '不得用随机/推测值填状态');
});

test('订阅：只在状态真的变化时收到迁移；退订后不再收到；监听器异常不影响看板', () => {
  const rig = makeRig();
  try {
    const { projection, params, clock, close } = rig;
    const seen: ProjectionEvent[] = [];
    // 实时通道在装配时已订阅投影，故先记基线（"订阅数 = 基线 + 自己")
    const baseline = projection.listenerCount();
    const unsubscribe = projection.subscribe((event) => seen.push(event));
    assert.equal(projection.listenerCount(), baseline + 1);

    reportState(rig, 'ST-LAB01-01', 'occupied');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.from, 'offline', '首次上报的起点是"无数据=offline"');
    assert.equal(seen[0]?.to, 'occupied');
    assert.equal(seen[0]?.reason, 'upstream');

    // 同一状态重复上报：不算变化，不产出迁移
    reportState(rig, 'ST-LAB01-01', 'occupied');
    assert.equal(seen.length, 1);

    // 参数变了但状态没变：同样不产迁移（参数由 record 携带）
    reportState(rig, 'ST-LAB01-01', 'occupied', { params: { feedRate: 320 } });
    assert.equal(seen.length, 1);
    assert.equal(projection.recordOf('ST-LAB01-01')?.params['feedRate'], 320);

    // 状态变化 → 迁移
    reportState(rig, 'ST-LAB01-01', 'maintenance');
    assert.equal(seen.length, 2);
    assert.equal(seen[1]?.from, 'occupied');
    assert.equal(seen[1]?.to, 'maintenance');

    // 退订
    unsubscribe();
    assert.equal(projection.listenerCount(), baseline);
    reportState(rig, 'ST-LAB01-01', 'available');
    assert.equal(seen.length, 2);

    // 监听器抛异常被隔离：另一个监听器照常收到，且计数留痕
    const healthy: string[] = [];
    projection.subscribe(() => {
      throw new Error('监听器内部故障');
    });
    projection.subscribe((event) => healthy.push(event.stationCode));
    reportState(rig, 'ST-LAB01-02', 'occupied');
    assert.deepEqual(healthy, ['ST-LAB01-02']);
    assert.equal(projection.stats().listenerErrors, 1);

    // 判离线也会推给订阅者（惰性判定发生在读看板时），且监听器故障不影响判定结果
    clock.advance(params.offlineJudgeMs());
    assert.equal(projection.stateOf('ST-LAB01-02'), 'offline');
    // 同一时刻 01 也已静默超窗，一次 evaluate 产出两条迁移
    assert.equal(projection.stateOf('ST-LAB01-01'), 'offline');
    assert.equal(
      projection.stats().listenerErrors,
      3,
      '1 次状态上报 + 2 次判离线迁移，每次监听器故障都被计数并隔离',
    );
  } finally {
    rig.close();
  }
});
