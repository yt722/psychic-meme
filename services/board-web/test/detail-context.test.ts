/**
 * S01.3 工位详情的上下文三项：任务 / 租约 / 脱敏占用人员
 * ============================================================
 * 现场接入前的缺口（计划 §3.2）：`board-web/src` 里**找不到**这三项的实现，
 * 工位详情只有状态源带来的 6 个字段。S01.3 明确要求"工位详情、任务、租约及脱敏占用人员展示"。
 *
 * 三条必须证明的事：
 *   1. **原始学号绝不进详情**——详情响应会被前端缓存、被截图、被浏览器历史留存；
 *   2. **"没有人"与"查不到"必须可区分**——否则页面会把数据源故障渲染成"工位空着"；
 *   3. **数据源报错不能让详情 500**——状态字段是看板的核心，缺上下文照样要能看。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_PARAM, BoardView, REQUIRED_DETAIL_FIELDS, S01_3_CONTEXT_FIELDS } from '../src/index.js';
import type { StationContextLookup } from '../src/index.js';
import { isBadRequest, makeRig, reportState, type Rig } from './helpers.js';

const STATION = 'ST-LAB01-01';

function viewWith(rig: Rig, context?: StationContextLookup): BoardView {
  return new BoardView({
    catalog: rig.catalog,
    projection: rig.projection,
    clock: rig.clock,
    params: rig.params,
    ...(context !== undefined ? { context } : {}),
  });
}

const FULL_CONTEXT: StationContextLookup = {
  contextOf: (stationCode: string) => {
    if (stationCode !== STATION) return {};
    return {
      task: { taskId: 'TASK-1', title: '减速机装配', startedAtMs: 1_700_000_000_000 },
      lease: {
        leaseId: 'lease-1',
        kind: 'offline-checked-in',
        state: 'active',
        expiresAtMs: 1_700_003_600_000,
        operatorId: '20230101',
      },
      occupants: [
        { userId: '20230101', taskId: 'TASK-1', sinceMs: 1_700_000_000_000 },
        { userId: '20230102' },
      ],
    };
  },
};

test('未注入数据源：显式标注 not-configured，而不是装作"没有人"', (t) => {
  const rig = makeRig();
  t.after(() => rig.close());
  reportState(rig, STATION, 'available');

  const detail = viewWith(rig).stationDetail(STATION);
  assert.equal(detail.contextSource, 'not-configured');
  assert.equal(detail.task, null);
  assert.equal(detail.lease, null);
  assert.deepEqual(detail.occupants, []);
  assert.equal(detail.state, 'available', '状态字段不受上下文影响');
});

test('★ 正常上下文：三项齐全，且**原始学号绝不出现在响应里**', (t) => {
  const rig = makeRig();
  t.after(() => rig.close());
  reportState(rig, STATION, 'occupied', { params: { spindle: 1200 } });

  const detail = viewWith(rig, FULL_CONTEXT).stationDetail(STATION);

  assert.equal(detail.contextSource, 'ok');
  assert.deepEqual(detail.task, {
    taskId: 'TASK-1',
    title: '减速机装配',
    startedAtMs: 1_700_000_000_000,
  });
  assert.equal(detail.lease?.leaseId, 'lease-1');
  assert.equal(detail.lease?.kind, 'offline-checked-in');
  assert.equal(detail.lease?.expiresAtMs, 1_700_003_600_000);
  assert.equal(detail.lease?.operatorIdMasked, '20****01', '租约操作者同样脱敏');

  assert.equal(detail.occupants.length, 2);
  assert.deepEqual(
    detail.occupants.map((o) => o.userIdMasked),
    ['20****01', '20****02'],
  );
  assert.equal(detail.occupants[0]?.taskId, 'TASK-1');

  // ★ 最关键的一条：整份响应里不得出现任何原始学号
  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes('20230101'), false, '★ 原始学号绝不能进详情响应');
  assert.equal(serialized.includes('20230102'), false);
  assert.match(serialized, /20\*\*\*\*01/);
});

test('★ 数据源报错：详情不 500，但必须说清"这是查不到"', (t) => {
  const rig = makeRig();
  t.after(() => rig.close());
  reportState(rig, STATION, 'available', { params: { spindle: 900 } });
  reportState(rig, STATION, 'occupied');

  const broken: StationContextLookup = {
    contextOf: () => {
      throw new Error('scheduler service down');
    },
  };
  const detail = viewWith(rig, broken).stationDetail(STATION);

  assert.equal(detail.contextSource, 'unavailable');
  assert.equal(detail.task, null);
  assert.deepEqual(detail.occupants, []);
  // 状态字段必须完好：这正是不让上下文故障拖垮详情的原因
  assert.equal(detail.state, 'occupied');
  assert.equal(detail.params['spindle'], 900);
  assert.ok(detail.updatedAt !== null);
});

test('占用人员有上界：超出 PARAM-BOARD-DETAIL-MAX-OCCUPANTS 即截断', (t) => {
  const rig = makeRig({ own: { [BOARD_PARAM.DETAIL_MAX_OCCUPANTS]: 2 } });
  t.after(() => rig.close());
  reportState(rig, STATION, 'occupied');

  const many: StationContextLookup = {
    contextOf: () => ({
      occupants: [
        { userId: '20230101' },
        { userId: '20230102' },
        { userId: '20230103' },
        { userId: '20230104' },
      ],
    }),
  };
  const detail = viewWith(rig, many).stationDetail(STATION);

  assert.equal(detail.occupants.length, 2, '上限必须生效，防异常数据源把响应撑大');
  assert.deepEqual(
    detail.occupants.map((o) => o.userIdMasked),
    ['20****01', '20****02'],
  );
});

test('脏上下文不产出脏字段：空学号跳过、空 taskId 视为无任务、缺 leaseId 视为无租约', (t) => {
  const rig = makeRig();
  t.after(() => rig.close());
  reportState(rig, STATION, 'available');

  const messy: StationContextLookup = {
    contextOf: () => ({
      task: { taskId: '   ' },
      lease: { leaseId: '', kind: 'in-class', state: 'ready' },
      occupants: [{ userId: '   ' }, { userId: '20230109' }, { userId: '20230110' }],
    }),
  };
  const detail = viewWith(rig, messy).stationDetail(STATION);

  assert.equal(detail.task, null, '空 taskId 不当作有任务');
  assert.equal(detail.lease, null, '空 leaseId 不当作有租约');
  assert.deepEqual(
    detail.occupants.map((o) => o.userIdMasked),
    ['20****09', '20****10'],
    '空学号既不产出占位，也不静默丢掉真实占用',
  );
  assert.equal(detail.contextSource, 'ok', '数据源本身可用（只是内容不完整）');
});

test('租约与任务的边界值：缺 expiresAtMs 记 null；缺 operatorId 不出现该字段', (t) => {
  const rig = makeRig();
  t.after(() => rig.close());
  reportState(rig, STATION, 'available');

  const partial: StationContextLookup = {
    contextOf: () => ({
      task: { taskId: 'TASK-9' },
      lease: { leaseId: 'lease-9', kind: 'online', state: 'ready' },
    }),
  };
  const detail = viewWith(rig, partial).stationDetail(STATION);

  assert.equal(detail.lease?.expiresAtMs, null, '到期时刻未知必须是 null，不能猜一个值');
  assert.equal(Object.hasOwn(detail.lease ?? {}, 'operatorIdMasked'), false);
  assert.deepEqual(detail.task, { taskId: 'TASK-9' });
});

test('字段清单：§3.4.4 的 6 项与 S01.3 的上下文 3 项都在详情里', (t) => {
  const rig = makeRig();
  t.after(() => rig.close());
  reportState(rig, STATION, 'available');

  const detail = viewWith(rig, FULL_CONTEXT).stationDetail(STATION) as unknown as Record<string, unknown>;

  assert.equal(REQUIRED_DETAIL_FIELDS.length, 6, '说明书 §3.4.4 是 6 个必需字段');
  for (const field of REQUIRED_DETAIL_FIELDS) {
    assert.ok(Object.hasOwn(detail, field), `必需字段缺失：${field}`);
  }
  assert.deepEqual([...S01_3_CONTEXT_FIELDS], ['task', 'lease', 'occupants']);
  for (const field of S01_3_CONTEXT_FIELDS) {
    assert.ok(Object.hasOwn(detail, field), `S01.3 字段缺失：${field}`);
  }
  assert.ok(Object.hasOwn(detail, 'contextSource'), '必须能区分"没有人"与"查不到"');
});

test('上下文不影响工位校验：未知工位仍按 GEN-1001 拒绝', (t) => {
  const rig = makeRig();
  t.after(() => rig.close());

  const view = viewWith(rig, FULL_CONTEXT);
  assert.throws(() => view.stationDetail('ST-LAB09-99'), isBadRequest);
  assert.throws(() => view.stationDetail('nope'), isBadRequest);
});
