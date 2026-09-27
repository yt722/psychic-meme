/**
 * S01.4 实时刷新用例：1Hz 广播、6s 兜底全量、参数化节拍、帧不重不漏。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock, PARAM } from '@peripheral/core';

import { RealtimeChannel, createBoardParams, type RealtimeFrame } from '../src/index.js';
import { START_ISO, change, makeRig, reportState } from './helpers.js';

function makeChannel(overrides: Parameters<typeof createBoardParams>[0] = {}): {
  clock: FakeClock;
  params: ReturnType<typeof createBoardParams>;
  channel: RealtimeChannel;
} {
  const clock = new FakeClock(START_ISO);
  const params = createBoardParams(overrides);
  const channel = new RealtimeChannel({ params, clock });
  return { clock, params, channel };
}

test('广播节奏 1Hz：到点才发增量帧，未到点不发', () => {
  const { clock, channel } = makeChannel();
  const t0 = clock.now();

  channel.publish(change('ST-LAB01-01', 'occupied', t0));

  assert.equal(channel.tick(t0 + 999), undefined, '未到广播周期不得下发');

  const frame = channel.tick(t0 + 1000);
  assert.ok(frame !== undefined);
  assert.equal(frame.reason, 'broadcast');
  assert.equal(frame.full, false);
  assert.equal(frame.sequence, 1);
  assert.equal(frame.changes.length, 1);
  assert.equal(frame.changes[0]?.stationCode, 'ST-LAB01-01');
  assert.equal(frame.changes[0]?.state, 'occupied');
  assert.equal(frame.atMs, t0 + 1000);
  assert.equal(frame.iso, '2026-10-12T09:00:01+08:00');
  assert.equal(frame.degraded, false);
});

test('兜底轮询 6s：广播断层即全量拉一次（防止变更静默丢失）', () => {
  const { clock, channel } = makeChannel();
  const t0 = clock.now();

  assert.equal(channel.shouldFallback(t0 + 5_999), false);
  assert.equal(channel.shouldFallback(t0 + 6_000), true);

  assert.equal(channel.tick(t0 + 5_999), undefined);
  const frame = channel.tick(t0 + 6_000);
  assert.ok(frame !== undefined);
  assert.equal(frame.reason, 'fallback');
  assert.equal(frame.full, true);
  assert.deepEqual(frame.changes, []);

  // 兜底之后节拍重置：紧接着的下一拍不再全量
  assert.equal(channel.shouldFallback(t0 + 6_000), false);
  assert.equal(channel.tick(t0 + 6_500), undefined);
});

test('广播正常时兜底永不触发（判据是"距上次成功广播"，不是"距上次兜底"）', () => {
  const { clock, channel } = makeChannel();
  const t0 = clock.now();

  for (let second = 1; second <= 5; second += 1) {
    channel.publish(change('ST-LAB01-01', 'occupied', t0 + second * 1000));
    const frame = channel.tick(t0 + second * 1000);
    assert.equal(frame?.reason, 'broadcast', `第 ${second} 秒应为广播帧`);
    assert.equal(channel.shouldFallback(t0 + second * 1000), false);
  }
});

test('节拍参数化：改 PARAM-MAP-BROADCAST / PARAM-MAP-FALLBACK 即改节奏，逻辑不动', () => {
  const { clock, channel } = makeChannel({
    core: { [PARAM.MAP_BROADCAST]: 2, [PARAM.MAP_FALLBACK]: 3000 },
  });
  const t0 = clock.now();

  assert.deepEqual(channel.intervalMs(), { broadcast: 500, fallback: 3_000, restore: 10_000 });

  channel.publish(change('ST-LAB02-01', 'maintenance', t0));
  assert.equal(channel.tick(t0 + 499), undefined);
  assert.equal(channel.tick(t0 + 500)?.reason, 'broadcast');

  // 兜底周期同步变短；判据是"距上次成功广播"，广播成功即重新计时
  assert.equal(channel.shouldFallback(t0 + 3_499), false);
  assert.equal(channel.shouldFallback(t0 + 3_500), true);
  assert.equal(channel.tick(t0 + 3_000), undefined, '无变更时到点也不发空帧');

  const fallbackFrame = channel.tick(t0 + 3_500);
  assert.equal(fallbackFrame?.full, true);
  assert.equal(fallbackFrame?.reason, 'fallback');

  // 非法参数不允许静默兜底：启动期自检即失败
  assert.throws(() => createBoardParams({ core: { [PARAM.MAP_BROADCAST]: 0 } }));
  assert.throws(() => createBoardParams({ core: { [PARAM.MAP_FALLBACK]: -1 } }));
});

test('无变更不下发空帧；已下发的变更不会被重复下发', () => {
  const { clock, channel } = makeChannel();
  const t0 = clock.now();

  assert.equal(channel.tick(t0 + 1000), undefined, '没有变更不发空帧');

  channel.publish([change('ST-LAB01-01', 'occupied', t0), change('ST-LAB01-02', 'available', t0)]);
  assert.equal(channel.bufferedCount(), 2);

  const first = channel.tick(t0 + 1000);
  assert.equal(first?.changes.length, 2);
  assert.equal(channel.bufferedCount(), 0);

  // 节拍未到 → 不发；到点但队列空 → 仍不发
  assert.equal(channel.tick(t0 + 1500), undefined);
  assert.equal(channel.tick(t0 + 2000), undefined, '同一批变更不得重复下发');

  channel.publish(change('ST-LAB01-03', 'offline', t0));
  const second = channel.tick(t0 + 3000);
  assert.equal(second?.sequence, 2);
  assert.equal(second?.changes.length, 1);
});

test('订阅与投影接线：状态源一报状态，下一拍就有帧；全量帧覆盖全部已投影工位', () => {
  const rig = makeRig();
  try {
    const { channel, clock, close } = rig;
    const frames: RealtimeFrame[] = [];
    const unsubscribe = channel.subscribe((frame) => frames.push(frame));

    reportState(rig, 'ST-LAB01-01', 'occupied');
    reportState(rig, 'ST-LAB01-02', 'maintenance');
    assert.equal(channel.subscriptionCount(), 1);

    const delta = channel.tick(clock.now() + 1000);
    assert.ok(delta !== undefined);
    assert.equal(delta.reason, 'broadcast');
    assert.equal(delta.changes.length, 2);
    assert.deepEqual(
      delta.changes.map((item) => item.stationCode).sort(),
      ['ST-LAB01-01', 'ST-LAB01-02'],
    );
    assert.equal(frames.length, 1);

    // 全量帧来自投影快照
    const full = channel.poll(clock.now() + 1000);
    assert.equal(full.full, true);
    assert.equal(full.changes.length, 2);
    assert.deepEqual(
      full.changes.map((item) => item.state).sort(),
      ['maintenance', 'occupied'],
    );
    const framesAfterPoll = frames.length;
    assert.equal(framesAfterPoll, 2, 'poll 也会推给订阅者');

    unsubscribe();
    assert.equal(channel.subscriptionCount(), 0);
    channel.publish(change('ST-LAB01-03', 'occupied', clock.now()));
    assert.equal(channel.tick(clock.now() + 2000)?.reason, 'broadcast');
    assert.equal(frames.length, framesAfterPoll, '退订后不再收到帧');

    channel.dispose();
    assert.equal(channel.stats().subscriptions, 0);
  } finally {
    rig.close();
  }
});
