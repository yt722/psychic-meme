/**
 * S01.3 工位详情用例：说明书 §3.4.4 的 6 个必需字段、报警、来源可区分、参数合并。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseIso } from '@peripheral/core';

import { REQUIRED_DETAIL_FIELDS } from '../src/index.js';
import { ISO_RE, isBadRequest, makeRig, reportState } from './helpers.js';

test('工位详情包含 6 个必需字段，且取值与状态源一致', () => {
  const rig = makeRig();
  try {
    const { view, clock, close } = rig;

    reportState(rig, 'ST-LAB02-03', 'occupied', {
      sourceKind: 'real',
      sourceId: 'SRC-PLC-LAB02',
      params: { spindleSpeed: 1480, programNo: 'O1024', coolantTemp: 26.4 },
    });

    const detail = view.stationDetail('ST-LAB02-03');

    for (const field of REQUIRED_DETAIL_FIELDS) {
      assert.ok(field in detail, `详情缺必需字段：${field}`);
    }
    assert.deepEqual(
      [...REQUIRED_DETAIL_FIELDS].sort(),
      ['labCode', 'params', 'sourceKind', 'state', 'stationCode', 'updatedAt'].sort(),
    );

    assert.equal(detail.stationCode, 'ST-LAB02-03');
    assert.equal(detail.labCode, 'LAB-02');
    assert.equal(detail.campusCode, 'CAMPUS-01');
    assert.equal(detail.state, 'occupied');
    assert.equal(detail.sourceKind, 'real');
    assert.equal(detail.sourceId, 'SRC-PLC-LAB02');
    assert.equal(detail.sourceLabel, '真机');
    assert.equal(detail.updatedAtMs, clock.now());
    assert.equal(detail.updatedAt, '2026-10-12T09:00:00+08:00');
    assert.match(String(detail.updatedAt), ISO_RE);
    assert.equal(parseIso(String(detail.updatedAt)), clock.now());
    assert.deepEqual(detail.params, { spindleSpeed: 1480, programNo: 'O1024', coolantTemp: 26.4 });
    assert.equal(detail.judgedOffline, false);
    assert.equal(detail.name, '包装工位3');
  } finally {
    rig.close();
  }
});

test('真机与孪生数据来源必须可区分（IF-01 §7）', () => {
  const rig = makeRig();
  try {
    const { view, close } = rig;

    reportState(rig, 'ST-LAB01-01', 'available', { sourceKind: 'real' });
    reportState(rig, 'ST-LAB01-02', 'available', { sourceKind: 'twin' });
    reportState(rig, 'ST-LAB01-03', 'available', { sourceKind: 'gateway' });
    reportState(rig, 'ST-LAB01-04', 'available', { sourceKind: 'manual' });

    assert.equal(view.stationDetail('ST-LAB01-01').sourceKind, 'real');
    assert.equal(view.stationDetail('ST-LAB01-01').sourceLabel, '真机');
    assert.equal(view.stationDetail('ST-LAB01-02').sourceKind, 'twin');
    assert.equal(view.stationDetail('ST-LAB01-02').sourceLabel, '数字孪生');
    assert.equal(view.stationDetail('ST-LAB01-03').sourceLabel, '工业网关');
    assert.equal(view.stationDetail('ST-LAB01-04').sourceLabel, '人工录入');

    // 来源标签可经参数覆盖（不硬编码在逻辑里）
    const custom = makeRig({ own: { 'PARAM-BOARD-SOURCE-LABEL-TWIN': '孪生替身' } });
    try {
      reportState(custom, 'ST-LAB01-01', 'available', { sourceKind: 'twin' });
      assert.equal(custom.view.stationDetail('ST-LAB01-01').sourceLabel, '孪生替身');
    } finally {
      custom.close();
    }
  } finally {
    rig.close();
  }
});

test('报警码与等级：上报即带出，未上报则不出现该字段', () => {
  const rig = makeRig();
  try {
    const { view, close } = rig;

    reportState(rig, 'ST-LAB01-01', 'maintenance', { alarmCode: 'ALM-2201', alarmLevel: 'fault' });
    const withAlarm = view.stationDetail('ST-LAB01-01');
    assert.equal(withAlarm.alarmCode, 'ALM-2201');
    assert.equal(withAlarm.alarmLevel, 'fault');

    reportState(rig, 'ST-LAB01-02', 'available');
    const withoutAlarm = view.stationDetail('ST-LAB01-02');
    assert.ok(!('alarmCode' in withoutAlarm) || withoutAlarm.alarmCode === undefined);
    assert.equal(withoutAlarm.alarmCode, undefined);

    // 报警码为 null / 空串视为"无报警"
    reportState(rig, 'ST-LAB01-03', 'available', { alarmCode: '   ' });
    assert.equal(view.stationDetail('ST-LAB01-03').alarmCode, undefined);

    // 非法报警等级被拒
    assert.throws(
      () => reportState(rig, 'ST-LAB01-04', 'available', { alarmLevel: 'critical' as 'fault' }),
      isBadRequest,
    );
  } finally {
    rig.close();
  }
});

test('从未上报的工位：6 个字段仍齐全，状态更新时间与来源标为"无数据"', () => {
  const rig = makeRig();
  try {
    const { view, close } = rig;

    const detail = view.stationDetail('ST-LAB03-02');
    for (const field of REQUIRED_DETAIL_FIELDS) assert.ok(field in detail);
    assert.equal(detail.state, 'offline');
    assert.equal(detail.updatedAt, null);
    assert.equal(detail.updatedAtMs, null);
    assert.equal(detail.sourceLabel, '无状态源数据');
    assert.deepEqual(detail.params, {});
    assert.equal(detail.judgedOffline, false);
  } finally {
    rig.close();
  }
});

test('实时参数是"最近已知值"：新键合并、旧键保留、同名覆盖', () => {
  const rig = makeRig();
  try {
    const { view, clock, close } = rig;

    reportState(rig, 'ST-LAB01-01', 'occupied', { params: { spindleSpeed: 1480, programNo: 'O1024' } });
    clock.advance(5_000);
    reportState(rig, 'ST-LAB01-01', 'occupied', { params: { spindleSpeed: 1520, feedRate: 320 } });

    const detail = view.stationDetail('ST-LAB01-01');
    assert.deepEqual(detail.params, { spindleSpeed: 1520, programNo: 'O1024', feedRate: 320 });
    assert.equal(detail.updatedAt, '2026-10-12T09:00:05+08:00');

    // 非法参数（数组 / 嵌套对象）被拒
    assert.throws(
      () =>
        rig.projection.applyState({
          stationCode: 'ST-LAB01-01',
          state: 'occupied',
          atMs: clock.now(),
          sourceKind: 'real',
          params: { nested: { a: 1 } as unknown as number },
        }),
      isBadRequest,
    );
  } finally {
    rig.close();
  }
});

test('详情查不到就是查不到：未知工位与非法编码一律抛 GEN-1001', () => {
  const rig = makeRig();
  try {
    const { view, close } = rig;

    assert.throws(() => view.stationDetail('ST-LAB09-01'), isBadRequest);
    assert.throws(() => view.stationDetail('ST-LAB01-99'), isBadRequest);
    assert.throws(() => view.stationDetail('ST-A01-01'), isBadRequest);
    assert.throws(() => view.stationDetail(''), isBadRequest);

    const unknown = (() => {
      try {
        view.stationDetail('ST-LAB09-01');
      } catch (error) {
        return error as { details?: Record<string, unknown>; errorCode?: string };
      }
      return undefined;
    })();
    assert.equal(unknown?.errorCode, 'GEN-1001');
    assert.equal(unknown?.details?.['reason'], 'unknown-station');
  } finally {
    rig.close();
  }
});
