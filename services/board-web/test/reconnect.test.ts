/**
 * S01.4 断线恢复用例：窗口内不丢订阅 + 补发断线期间变更；超窗 degraded + 强制全量刷新。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock } from '@peripheral/core';

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

test('窗口内重连：订阅不丢，补发断线期间的状态变更', () => {
  const { clock, channel } = makeChannel();
  const t0 = clock.now();
  const frames: RealtimeFrame[] = [];
  const listener = (frame: RealtimeFrame): void => {
    frames.push(frame);
  };
  channel.subscribe(listener);

  // 断线前已有一条未下发的变更 → 断线时一并转入 backlog
  channel.publish(change('ST-LAB01-01', 'occupied', t0));
  channel.disconnect(t0);

  assert.equal(channel.isConnected(), false);
  assert.equal(channel.tick(t0 + 1000), undefined, '断线期间不下发任何帧');

  channel.publish(change('ST-LAB01-02', 'maintenance', t0 + 2000));
  channel.publish(change('ST-LAB01-03', 'offline', t0 + 3000));
  assert.equal(channel.stats().backloggedChanges, 3);
  assert.equal(frames.length, 0);

  clock.advance(4_000);
  const result = channel.reconnect(clock.now());

  assert.equal(result.withinWindow, true);
  assert.equal(result.offlineMs, 4_000);
  assert.equal(result.degraded, false);
  assert.equal(result.replayedChanges, 3);
  assert.equal(result.subscriptions, 1, '重连后原订阅仍在');
  assert.equal(channel.subscriptionCount(), 1);
  assert.equal(channel.isConnected(), true);
  assert.equal(channel.isDegraded(), false);

  const frame = result.frame;
  assert.ok(frame !== undefined);
  assert.equal(frame.reason, 'reconnect');
  assert.equal(frame.full, false, '窗口内不强制全量');
  assert.equal(frame.changes.length, 3);
  assert.equal(frames.length, 1, '补发帧直接推给订阅者');
  assert.equal(frames[0]?.reason, 'reconnect');

  // 原订阅继续收到后续广播帧
  channel.publish(change('ST-LAB01-04', 'available', clock.now()));
  const next = channel.tick(clock.now() + 1000);
  assert.equal(next?.reason, 'broadcast');
  assert.equal(frames.length, 2);
  assert.equal(channel.stats().reconnects, 1);
});

test('超窗重连：标记 degraded 并强制全量刷新（增量已不可信）', () => {
  const { clock, channel } = makeChannel();
  const t0 = clock.now();
  const frames: RealtimeFrame[] = [];
  channel.subscribe((frame) => frames.push(frame));

  channel.disconnect(t0);
  channel.publish(change('ST-LAB02-01', 'occupied', t0 + 1000));
  assert.equal(channel.stats().backloggedChanges, 1);

  // 超过 PARAM-RECONNECT-RESTORE（10s）
  clock.advance(10_001);
  const result = channel.reconnect(clock.now());

  assert.equal(result.withinWindow, false);
  assert.equal(result.offlineMs, 10_001);
  assert.equal(result.degraded, true);
  assert.equal(result.replayedChanges, 0, '超窗不补发增量');

  const frame = result.frame;
  assert.ok(frame !== undefined);
  assert.equal(frame.full, true, '超窗必须全量刷新');
  assert.equal(frame.degraded, true);
  assert.equal(frame.reason, 'reconnect');

  assert.equal(channel.stats().forcedFullRefreshes, 1);
  assert.equal(channel.isDegraded(), false, '强制刷新完成后降级态解除');
  assert.equal(channel.stats().lastReconnect?.degraded, true, '降级已留痕');
  assert.equal(frames.length, 1);

  // 边界：恰好等于恢复窗口仍算"窗口内"
  const edge = makeChannel();
  edge.channel.disconnect(edge.clock.now());
  edge.clock.advance(10_000);
  const edgeResult = edge.channel.reconnect(edge.clock.now());
  assert.equal(edgeResult.withinWindow, true);
  assert.equal(edgeResult.frame?.full, false);
});

test('断线期间缓冲有上限：超限丢最旧并计数（不无声膨胀内存）', () => {
  const { clock, channel } = makeChannel({ own: { 'PARAM-BOARD-RECONNECT-BACKLOG-MAX': 3 } });
  const t0 = clock.now();

  channel.disconnect(t0);
  for (let index = 1; index <= 5; index += 1) {
    channel.publish(change(`ST-LAB01-0${index}`, 'occupied', t0 + index));
  }

  assert.equal(channel.stats().backloggedChanges, 3);
  assert.equal(channel.stats().backlogDropped, 2);

  const result = channel.reconnect(t0 + 1_000);
  assert.equal(result.replayedChanges, 3);
  assert.deepEqual(
    result.frame?.changes.map((item) => item.stationCode),
    ['ST-LAB01-03', 'ST-LAB01-04', 'ST-LAB01-05'],
    '保留最新三条',
  );
});

test('disconnect 幂等、已连接时 reconnect 为无操作', () => {
  const { clock, channel } = makeChannel();
  const t0 = clock.now();

  const idle = channel.reconnect(t0 + 5_000);
  assert.equal(idle.offlineMs, 0);
  assert.equal(idle.withinWindow, true);
  assert.equal(idle.degraded, false);
  assert.equal(idle.frame, undefined);
  assert.equal(channel.stats().reconnects, 0, '未断线不算一次重连');

  channel.disconnect(t0);
  channel.disconnect(t0 + 9_000); // 重复断线不重置计时，否则恢复窗口会被无限续期
  clock.advance(15_000);

  const result = channel.reconnect(clock.now());
  assert.equal(result.withinWindow, false, '计时从第一次断线开始');
  assert.equal(result.offlineMs, 15_000);
});

test('与投影联动的断线恢复：补发的正是断线期间的迁移事件', () => {
  const rig = makeRig();
  try {
    const { channel, clock, close } = rig;
    const frames: RealtimeFrame[] = [];
    channel.subscribe((frame) => frames.push(frame));

    reportState(rig, 'ST-LAB01-01', 'occupied');
    const first = channel.tick(clock.now() + 1_000);
    assert.equal(first?.changes.length, 1);

    channel.disconnect(clock.now());
    reportState(rig, 'ST-LAB01-01', 'maintenance');
    reportState(rig, 'ST-LAB01-02', 'available');
    assert.equal(frames.length, 1, '断线期间不再推帧');

    clock.advance(2_000);
    const result = channel.reconnect(clock.now());
    assert.equal(result.replayedChanges, 2);
    assert.deepEqual(
      result.frame?.changes.map((item) => `${item.stationCode}:${item.state}`),
      ['ST-LAB01-01:maintenance', 'ST-LAB01-02:available'],
    );
    assert.equal(frames.length, 2);

    // 超窗重连后是全量帧，内容为投影快照（可用于整体替换前端视图）
    channel.disconnect(clock.now());
    clock.advance(30_000);
    const full = channel.reconnect(clock.now());
    assert.equal(full.frame?.full, true);
    assert.deepEqual(
      full.frame?.changes.map((item) => item.stationCode).sort(),
      ['ST-LAB01-01', 'ST-LAB01-02'],
    );
  } finally {
    rig.close();
  }
});
