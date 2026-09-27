import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock } from '../src/index.js';
import {
  createEnvelope,
  isValidEnvelope,
  EventDeduplicator,
  evaluateOrdering,
  type EventType,
} from '../src/index.js';

describe('envelope: 构造', () => {
  it('产出符合契约的完整信封', () => {
    const clock = new FakeClock('2026-10-12T09:00:00+08:00');
    const env = createEnvelope(clock, {
      type: 'station.status',
      source: 'device-adapter',
      eventId: 'evt-001',
      data: { stationCode: 'ST-LAB01-07', state: 'available' },
    });

    assert.equal(env.specversion, '1.0');
    assert.equal(env.id, 'event-evt-001');
    assert.equal(env.type, 'station.status');
    assert.equal(env.source, 'device-adapter');
    assert.equal(env.time, '2026-10-12T09:00:00+08:00');
    assert.equal(env.traceId, 'trace-evt-001');
    assert.equal(env.eventId, 'evt-001');
    assert.deepEqual(env.data, { stationCode: 'ST-LAB01-07', state: 'available' });
    assert.equal(isValidEnvelope(env), true);
  });

  it('eventId 缺失必须抛错（它是幂等键，不允许为空）', () => {
    const clock = new FakeClock();
    assert.throws(
      () => createEnvelope(clock, { type: 'alarm', source: 's', eventId: '', data: {} }),
      /eventId 必填/,
    );
    assert.throws(
      () => createEnvelope(clock, { type: 'alarm', source: 's', eventId: '   ', data: {} }),
      /eventId 必填/,
    );
  });

  it('可显式指定 traceId 与 time', () => {
    const clock = new FakeClock();
    const env = createEnvelope(clock, {
      type: 'alarm',
      source: 'alarm-svc',
      eventId: 'evt-002',
      traceId: 'trace-custom',
      time: '2026-01-01T00:00:00+08:00',
      data: {},
    });
    assert.equal(env.traceId, 'trace-custom');
    assert.equal(env.time, '2026-01-01T00:00:00+08:00');
  });

  it('六类事件类型均可用', () => {
    const clock = new FakeClock();
    const types: EventType[] = [
      'alarm',
      'station.status',
      'task.training',
      'learning.event',
      'scheduler.lease',
      'control.command',
    ];
    for (const type of types) {
      const env = createEnvelope(clock, { type, source: 's', eventId: `e-${type}`, data: {} });
      assert.equal(env.type, type);
    }
  });
});

describe('envelope: 结构校验', () => {
  it('拒绝缺字段的对象', () => {
    assert.equal(isValidEnvelope(null), false);
    assert.equal(isValidEnvelope(undefined), false);
    assert.equal(isValidEnvelope('string'), false);
    assert.equal(isValidEnvelope({}), false);
  });

  it('拒绝 specversion 不符', () => {
    const clock = new FakeClock();
    const env = createEnvelope(clock, { type: 'alarm', source: 's', eventId: 'e1', data: {} });
    assert.equal(isValidEnvelope({ ...env, specversion: '2.0' }), false);
  });

  it('拒绝空 eventId', () => {
    const clock = new FakeClock();
    const env = createEnvelope(clock, { type: 'alarm', source: 's', eventId: 'e1', data: {} });
    assert.equal(isValidEnvelope({ ...env, eventId: '' }), false);
  });

  it('拒绝 data 非对象', () => {
    const clock = new FakeClock();
    const env = createEnvelope(clock, { type: 'alarm', source: 's', eventId: 'e1', data: {} });
    assert.equal(isValidEnvelope({ ...env, data: null }), false);
  });
});

describe('envelope: 去重（DEV-2001）', () => {
  it('首次接受，重复拒绝（幂等命中不是错误）', () => {
    const clock = new FakeClock();
    const dedup = new EventDeduplicator(clock, 24 * 60 * 60 * 1000);

    assert.equal(dedup.accept('evt-1').accepted, true);

    const second = dedup.accept('evt-1');
    assert.equal(second.accepted, false);
    assert.equal(typeof second.firstSeenAt, 'number');
  });

  it('不同 eventId 各自接受', () => {
    const clock = new FakeClock();
    const dedup = new EventDeduplicator(clock);
    assert.equal(dedup.accept('evt-1').accepted, true);
    assert.equal(dedup.accept('evt-2').accepted, true);
  });

  it('窗口内去重、窗口外重新接受', () => {
    const clock = new FakeClock();
    const dedup = new EventDeduplicator(clock, 60_000);

    assert.equal(dedup.accept('evt-1').accepted, true);
    clock.advance(59_000);
    assert.equal(dedup.accept('evt-1').accepted, false);

    clock.advance(1000); // 累计 60000，刚好过期
    assert.equal(dedup.accept('evt-1').accepted, true);
  });

  it('空 eventId 抛错（不静默放行）', () => {
    const clock = new FakeClock();
    const dedup = new EventDeduplicator(clock);
    assert.throws(() => dedup.accept(''), /eventId 不能为空/);
  });

  it('size 反映有效条目数并清理过期项', () => {
    const clock = new FakeClock();
    const dedup = new EventDeduplicator(clock, 1000);
    dedup.accept('a');
    dedup.accept('b');
    assert.equal(dedup.size(), 2);
    clock.advance(1000);
    assert.equal(dedup.size(), 0);
  });

  it('clear 清空', () => {
    const clock = new FakeClock();
    const dedup = new EventDeduplicator(clock);
    dedup.accept('a');
    dedup.clear();
    assert.equal(dedup.size(), 0);
  });
});

describe('envelope: 乱序处理', () => {
  it('时序正常 → process', () => {
    const r = evaluateOrdering(2000, 1000);
    assert.equal(r.outOfOrder, false);
    assert.equal(r.action, 'process');
  });

  it('首个事件（无基准）→ process', () => {
    const r = evaluateOrdering(2000, undefined);
    assert.equal(r.outOfOrder, false);
    assert.equal(r.action, 'process');
  });

  it('乱序 → 保留并告警，绝不静默丢弃', () => {
    const r = evaluateOrdering(500, 1000);
    assert.equal(r.outOfOrder, true);
    assert.equal(r.action, 'process-and-warn');
  });

  it('相同时间戳不算乱序', () => {
    const r = evaluateOrdering(1000, 1000);
    assert.equal(r.outOfOrder, false);
  });
});
