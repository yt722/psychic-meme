import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SystemClock, FakeClock, toIso, parseIso } from '../src/index.js';

describe('clock: SystemClock', () => {
  it('now() 返回毫秒时间戳', () => {
    const clock = new SystemClock();
    const t = clock.now();
    assert.equal(typeof t, 'number');
    assert.ok(t > 1_700_000_000_000);
  });

  it('iso() 返回带时区的 ISO-8601', () => {
    const clock = new SystemClock();
    assert.match(clock.iso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
  });
});

describe('clock: toIso 东八区', () => {
  it('UTC 00:00 应为东八区 08:00', () => {
    const ms = Date.parse('2026-10-12T00:00:00Z');
    assert.equal(toIso(ms), '2026-10-12T08:00:00+08:00');
  });

  it('跨日边界正确进位', () => {
    const ms = Date.parse('2026-10-12T20:00:00Z');
    assert.equal(toIso(ms), '2026-10-13T04:00:00+08:00');
  });

  it('输出格式带明确时区偏移（不产生跨时区歧义）', () => {
    assert.match(toIso(Date.now()), /\+08:00$/);
  });

  it('支持非东八区偏移', () => {
    const ms = Date.parse('2026-10-12T00:00:00Z');
    assert.equal(toIso(ms, 0), '2026-10-12T00:00:00+00:00');
    assert.equal(toIso(ms, -300), '2026-10-11T19:00:00-05:00');
  });

  it('过秒不输出毫秒（契约格式为秒级）', () => {
    const ms = Date.parse('2026-10-12T00:00:00.789Z');
    assert.equal(toIso(ms), '2026-10-12T08:00:00+08:00');
  });
});

describe('clock: parseIso', () => {
  it('解析带时区的 ISO-8601', () => {
    assert.equal(parseIso('2026-10-12T08:00:00+08:00'), Date.parse('2026-10-12T00:00:00Z'));
  });

  it('非法输入抛错（不静默兜底成当前时间）', () => {
    assert.throws(() => parseIso('not-a-date'), /无法解析/);
  });
});

describe('clock: FakeClock', () => {
  it('默认起始时间可解析', () => {
    const clock = new FakeClock();
    assert.match(clock.iso(), /^2026-10-12T09:00:00\+08:00$/);
  });

  it('advance 推进毫秒并记录', () => {
    const clock = new FakeClock('2026-10-12T09:00:00+08:00');
    clock.advance(1000);
    assert.equal(clock.iso(), '2026-10-12T09:00:01+08:00');
    assert.deepEqual(clock.advances, [1000]);
  });

  it('advanceSeconds / advanceMinutes 便捷方法', () => {
    const clock = new FakeClock('2026-10-12T09:00:00+08:00');
    clock.advanceSeconds(30);
    assert.equal(clock.iso(), '2026-10-12T09:00:30+08:00');
    clock.advanceMinutes(5);
    assert.equal(clock.iso(), '2026-10-12T09:05:30+08:00');
  });

  it('拒绝负数或非有限值（避免时间倒流）', () => {
    const clock = new FakeClock();
    assert.throws(() => clock.advance(-1), /非负有限毫秒/);
    assert.throws(() => clock.advance(Number.NaN), /非负有限毫秒/);
    assert.throws(() => clock.advance(Number.POSITIVE_INFINITY), /非负有限毫秒/);
  });

  it('set 可设定到指定时间', () => {
    const clock = new FakeClock();
    clock.set('2027-01-01T00:00:00+08:00');
    assert.equal(clock.iso(), '2027-01-01T00:00:00+08:00');
  });

  it('set 非法输入抛错', () => {
    const clock = new FakeClock();
    assert.throws(() => clock.set('bad'), /无法解析/);
  });

  it('可支撑 30 秒心跳周期判定（A-03c 场景）', () => {
    const clock = new FakeClock('2026-10-12T09:00:00+08:00');
    const start = clock.now();
    clock.advanceSeconds(30);
    assert.equal(clock.now() - start, 30_000);
  });
});
