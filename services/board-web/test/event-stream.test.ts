/**
 * S01.5 现场状态上屏：SSE 事件流用例。
 *
 * 覆盖的验收项（现场计划 §4.2 / §6.3）：
 * 1. **状态 ≤5s 上屏**：投影迁移 → 1Hz 广播 → 连接写出，端到端时延有界；
 * 2. **重连不丢订阅、不丢事件**：`Last-Event-ID` 落在窗口内逐帧补发，订阅数不减；
 * 3. **`Last-Event-ID` 过旧必须明确回退全量**，不得静默丢事件；
 * 4. **慢客户端背压合并**：只留每工位最新状态，内存不随客户端变慢而增长；
 * 5. 心跳保活不推进 `Last-Event-ID`；
 * 6. HTTP 端到端（真实 server）：首屏快照、续传、未注入/连接满回 503、`/health` 带流诊断。
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { after, test } from 'node:test';

import {
  BoardEventHub,
  SSE_KEEPALIVE,
  createBoardServer,
  formatSseMessage,
  parseLastEventId,
  type EventStreamSink,
} from '../src/index.js';
import { change, makeRig, reportState, type Rig } from './helpers.js';

/* ------------------------------------------------------------------ 夹具 */

/** 假出口：可开关背压、可手动触发 drain，完整记录写出的 SSE 原文 */
class FakeSink implements EventStreamSink {
  readonly chunks: string[] = [];
  blocked = false;
  ended = false;
  #drain: (() => void) | undefined;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return !this.blocked;
  }

  onDrain(listener: () => void): void {
    this.#drain = listener;
  }

  end(): void {
    this.ended = true;
  }

  /** 模拟下游把缓冲排空（背压解除） */
  drain(): void {
    this.blocked = false;
    this.#drain?.();
  }

  /** 全部已写出文本 */
  text(): string {
    return this.chunks.join('');
  }

  /** 解析出的 SSE 消息（按 `event:` 归类，按顺序返回 data） */
  events(): Array<{ id?: number; event: string; data: Record<string, unknown> }> {
    const parsed: Array<{ id?: number; event: string; data: Record<string, unknown> }> = [];
    for (const block of this.text().split('\n\n')) {
      const lines = block.split('\n').filter((line) => line !== '');
      const idLine = lines.find((line) => line.startsWith('id: '));
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (eventLine === undefined || dataLine === undefined) continue;
      const record: { id?: number; event: string; data: Record<string, unknown> } = {
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
      };
      if (idLine !== undefined) record.id = Number(idLine.slice('id: '.length));
      parsed.push(record);
    }
    return parsed;
  }
}

function hubOf(rig: Rig): BoardEventHub {
  return new BoardEventHub({
    clock: rig.clock,
    params: rig.params,
    frames: rig.channel,
    snapshot: () =>
      rig.projection.snapshot().map((record) => ({
        stationCode: record.stationCode,
        state: record.state,
        atMs: record.atMs,
        sourceKind: record.sourceKind,
      })),
  });
}

const openRigs: Rig[] = [];
const openHubs: BoardEventHub[] = [];
const openServers: Array<{ close(): Promise<void> }> = [];

function useRig(): Rig {
  const rig = makeRig();
  openRigs.push(rig);
  return rig;
}

function useHub(rig: Rig): BoardEventHub {
  const hub = hubOf(rig);
  openHubs.push(hub);
  return hub;
}

after(async () => {
  for (const server of openServers) await server.close();
  for (const hub of openHubs) hub.dispose();
  for (const rig of openRigs) rig.close();
});

/* ------------------------------------------------------------- 纯函数口径 */

test('SSE 编码：retry/id/event/data 顺序固定，空行结尾', () => {
  const message = formatSseMessage({ retryMs: 3000, id: 7, event: 'state', data: { ok: true } });
  assert.equal(message, 'retry: 3000\nid: 7\nevent: state\ndata: {"ok":true}\n\n');
});

test('Last-Event-ID 解析：只认非负整数，乱码按新连接处理', () => {
  assert.equal(parseLastEventId('12'), 12);
  assert.equal(parseLastEventId(' 12 '), 12);
  assert.equal(parseLastEventId('0'), 0);
  assert.equal(parseLastEventId(undefined), undefined);
  assert.equal(parseLastEventId('-1'), undefined);
  assert.equal(parseLastEventId('12.5'), undefined);
  assert.equal(parseLastEventId('abc'), undefined);
  // 超过安全整数（浏览器不会发，但也不能让它变成 NaN 之后的诡异行为）
  assert.equal(parseLastEventId('9007199254740993'), undefined);
});

/* ------------------------------------------------- 1. 首屏与 ≤5s 上屏 */

test('S01.5：新连接先拿 retry+hello+全量快照，状态变更 ≤5s 上屏', () => {
  const rig = useRig();
  const hub = useHub(rig);
  reportState(rig, 'ST-LAB01-01', 'occupied');

  const sink = new FakeSink();
  hub.open(undefined, sink);

  const first = sink.events();
  assert.match(sink.text(), /^retry: 3000\n/, '首行必须是重连退避提示');
  assert.equal(first[0]?.event, 'hello');
  assert.equal(first[0]?.data.resumed, false);
  assert.equal(first[1]?.event, 'snapshot');
  assert.equal(first[1]?.data.full, true);
  const snapshotChanges = first[1]?.data.changes as Array<{ stationCode: string }>;
  assert.equal(snapshotChanges.length, 1);
  assert.equal(snapshotChanges[0]?.stationCode, 'ST-LAB01-01');

  // 1Hz 广播：投影迁移 → 通道 tick → 连接写出
  const before = sink.events().length;
  rig.clock.advance(1000);
  reportState(rig, 'ST-LAB01-01', 'available');
  const frame = rig.channel.tick();
  assert.ok(frame !== undefined, '1Hz 广播应产生一帧');

  const state = sink.events().slice(before).find((message) => message.event === 'state');
  assert.ok(state !== undefined, '状态变更应作为 state 事件下发');
  const changes = state.data.changes as Array<{ stationCode: string; state: string }>;
  assert.equal(changes[0]?.state, 'available');
  assert.equal(state.data.sequence, frame.sequence);

  // 端到端时延：帧产生时刻与"上屏时刻"之差 ≤ 5s（1Hz 广播下实际 0ms）
  const onScreenAtMs = rig.clock.now();
  const latencyMs = onScreenAtMs - (state.data.atMs as number);
  assert.ok(latencyMs >= 0 && latencyMs <= 5000, `上屏时延 ${latencyMs}ms 应落在 [0,5000]`);
});

/* --------------------------------------- 2. 重连：不丢订阅、不丢事件 */

test('S01.5：断线期间的事件在重连时逐帧补发，订阅数不减', () => {
  const rig = useRig();
  const hub = useHub(rig);

  const first = new FakeSink();
  const handle = hub.open(undefined, first);

  // 断线前拿到 3 帧
  for (const state of ['occupied', 'available', 'maintenance'] as const) {
    rig.clock.advance(1000);
    reportState(rig, 'ST-LAB01-01', state);
    rig.channel.tick();
  }
  const before = first.events().filter((message) => message.event === 'state');
  assert.equal(before.length, 3);
  const lastEventId = before.at(-1)?.id as number;
  assert.equal(lastEventId, hub.latestSequence());

  handle.close();
  assert.equal(first.ended, true);
  assert.equal(hub.stats().connections, 0);
  // 断线不影响订阅：通道上的订阅仍在（"重连不丢订阅"的观测点）
  assert.equal(rig.channel.subscriptionCount(), 1);

  // 断线期间继续产生 2 帧
  for (const state of ['occupied', 'offline'] as const) {
    rig.clock.advance(1000);
    reportState(rig, 'ST-LAB01-01', state);
    rig.channel.tick();
  }

  const again = new FakeSink();
  hub.open(lastEventId, again);
  const messages = again.events();
  assert.equal(messages[0]?.event, 'hello');
  assert.equal(messages[0]?.data.resumed, true, '窗口内重连应标记为续传');
  assert.equal(messages[0]?.data.replayed, 2);

  const replayed = messages.filter((message) => message.event === 'state');
  assert.equal(replayed.length, 2, '断线期间的 2 帧必须逐帧补发，不得合并掉');
  assert.deepEqual(
    replayed.map((message) => message.id),
    [lastEventId + 1, lastEventId + 2],
    '补发帧序号必须连续',
  );
  assert.equal(hub.stats().replayedEvents, 2);
  assert.equal(hub.stats().fullResends, 0);
  assert.equal(rig.channel.subscriptionCount(), 1);
});

/* --------------------------- 3. Last-Event-ID 过旧：明确回退全量 */

test('S01.5：Last-Event-ID 过旧 → notice 说明原因 + 全量快照，不静默丢事件', () => {
  const rig = useRig();
  const hub = new BoardEventHub({
    clock: rig.clock,
    params: rig.params,
    frames: rig.channel,
    // 续传窗口只留 2 帧，制造"过旧"
    snapshot: () =>
      rig.projection.snapshot().map((record) => ({
        stationCode: record.stationCode,
        state: record.state,
        atMs: record.atMs,
        sourceKind: record.sourceKind,
      })),
  });
  openHubs.push(hub);

  for (let index = 0; index < 5; index += 1) {
    rig.clock.advance(1000);
    reportState(rig, 'ST-LAB01-01', index % 2 === 0 ? 'occupied' : 'available');
    rig.channel.tick();
  }
  const stats = hub.stats();
  assert.equal(stats.recentFrames, 5);
  assert.equal(stats.recentCapacity, 512);

  // 换一个容量只有 2 的 hub，复现"缓冲已把旧帧挤掉"
  const tight = new BoardEventHub({
    clock: rig.clock,
    params: rig.params,
    frames: rig.channel,
  });
  openHubs.push(tight);
  tight.ingest({
    sequence: 1,
    atMs: rig.clock.now(),
    iso: '',
    reason: 'broadcast',
    full: false,
    degraded: false,
    changes: [change('ST-LAB01-01', 'occupied', rig.clock.now())],
  });
  tight.ingest({
    sequence: 2,
    atMs: rig.clock.now(),
    iso: '',
    reason: 'broadcast',
    full: false,
    degraded: false,
    changes: [change('ST-LAB01-01', 'available', rig.clock.now())],
  });

  const decision = tight.decideResume(0);
  assert.equal(decision.kind, 'resync');
  assert.equal(decision.reason, 'last-event-id-too-old');
  assert.equal(decision.requestedId, 0);
  assert.equal(decision.oldestId, 1, '必须回报"最早可补发的序号"，便于排查');

  const sink = new FakeSink();
  tight.open(0, sink);
  const messages = sink.events();
  assert.equal(messages[0]?.event, 'hello');
  assert.equal(messages[1]?.event, 'notice');
  assert.equal(messages[1]?.data.reason, 'last-event-id-too-old');
  assert.equal(messages[1]?.data.requestedId, 0);
  assert.equal(messages[2]?.event, 'snapshot', '过旧必须整体重发全量，而不是不响应');
  assert.equal(messages[2]?.data.degraded, true);
  assert.equal(tight.stats().fullResends, 1);
});

test('S01.5：Last-Event-ID 超前/未知同样回退全量并说明原因', () => {
  const rig = useRig();
  const hub = useHub(rig);
  rig.clock.advance(1000);
  reportState(rig, 'ST-LAB01-01', 'occupied');
  rig.channel.tick();

  const ahead = hub.decideResume(hub.latestSequence() + 99);
  assert.equal(ahead.kind, 'resync');
  assert.equal(ahead.reason, 'last-event-id-ahead');

  const unknown = hub.decideResume(hub.latestSequence() - 1 >= 1 ? 1 : 0);
  assert.equal(unknown.kind, 'resync');

  const current = hub.decideResume(hub.latestSequence());
  assert.equal(current.kind, 'replay');
  assert.equal(current.frames.length, 0, '序号正好对齐时无需补发');
});

/* --------------------------------- 4. 慢客户端：背压合并，不无限缓冲 */

test('S01.5：慢客户端只留每工位最新状态（背压合并且计数）', () => {
  const rig = useRig();
  const hub = useHub(rig);
  const sink = new FakeSink();
  hub.open(undefined, sink);

  const atMs = rig.clock.now();
  const push = (changes: Array<{ stationCode: string; state: string }>, full = false): void => {
    hub.ingest({
      sequence: hub.latestSequence() + 1,
      atMs,
      iso: '',
      reason: full ? 'fallback' : 'broadcast',
      full,
      degraded: false,
      changes: changes.map((item) => change(item.stationCode, item.state as never, atMs)),
    });
  };

  // 下游写不动了：写一次才会发现背压，因此第一条必然先出去（这是刻意的，不是丢数据）
  sink.blocked = true;
  push([{ stationCode: 'ST-LAB01-01', state: 'occupied' }]);
  const warmup = sink.events().filter((message) => message.event === 'state');
  assert.equal(warmup.length, 1);

  // 阻塞窗口内的所有变更：同工位后者覆盖前者，不同工位各自保留
  push([{ stationCode: 'ST-LAB01-01', state: 'available' }]);
  push([{ stationCode: 'ST-LAB01-01', state: 'maintenance' }]);
  push([{ stationCode: 'ST-LAB01-01', state: 'offline' }]);
  assert.equal(sink.events().filter((message) => message.event === 'state').length, 1, '阻塞期间不得继续灌数据');

  push([
    { stationCode: 'ST-LAB01-02', state: 'occupied' },
    { stationCode: 'ST-LAB01-03', state: 'available' },
  ]);
  push([{ stationCode: 'ST-LAB01-02', state: 'maintenance' }]);
  // 合并批里混进全量帧：下发必须仍是全量，否则前端会停在拼不回去的视图上
  push([{ stationCode: 'ST-LAB01-04', state: 'offline' }], true);

  sink.drain();
  const states = sink.events().filter((message) => message.event === 'state');
  assert.equal(states.length, 2, '整段阻塞窗口应只补发一帧');
  const merged = states[1];
  const changes = merged?.data.changes as Array<{ stationCode: string; state: string }>;
  assert.deepEqual(
    changes.map((item) => `${item.stationCode}=${item.state}`),
    ['ST-LAB01-01=offline', 'ST-LAB01-02=maintenance', 'ST-LAB01-03=available', 'ST-LAB01-04=offline'],
    '合并按首次出现顺序，同工位取最新',
  );
  assert.equal(merged?.data.merged, 3, '被合并掉的条数要计数，便于观测');
  assert.equal(merged?.data.full, true, '合并批里只要有一帧是全量，下发就必须是全量');
  assert.equal(merged?.data.count, 4);
  assert.equal(hub.stats().slowClients, 1);
});

test('S01.5：待发队列容量上限生效——超出只丢最旧并计数', () => {
  const rig = makeRig({ own: { 'PARAM-BOARD-EVENT-STREAM-COALESCE-MAX': 2 } });
  openRigs.push(rig);
  const hub = useHub(rig);
  const sink = new FakeSink();
  hub.open(undefined, sink);
  sink.blocked = true;

  const atMs = rig.clock.now();
  for (const stationCode of ['ST-LAB01-01', 'ST-LAB01-02', 'ST-LAB01-03', 'ST-LAB01-04']) {
    hub.ingest({
      sequence: hub.latestSequence() + 1,
      atMs,
      iso: '',
      reason: 'broadcast',
      full: false,
      degraded: false,
      changes: [change(stationCode, 'occupied', atMs)],
    });
  }
  sink.drain();
  const states = sink.events().filter((message) => message.event === 'state');
  const changes = states.at(-1)?.data.changes as Array<{ stationCode: string }>;
  assert.equal(changes.length, 2, '容量 2 时最多保留 2 个工位');
  assert.deepEqual(changes.map((item) => item.stationCode), ['ST-LAB01-03', 'ST-LAB01-04'], '丢的必须是最旧的');
  assert.equal(hub.stats().droppedChanges, 1, '丢弃必须计数，不能静默');
});

/* ------------------------------------------- 5. 心跳保活语义 */

test('S01.5：空闲超过保活周期发注释行，且心跳不推进 Last-Event-ID', () => {
  const rig = makeRig({ own: { 'PARAM-BOARD-EVENT-STREAM-KEEPALIVE': 60_000 } });
  openRigs.push(rig);
  const hub = useHub(rig);
  const sink = new FakeSink();
  const handle = hub.open(undefined, sink);

  const idBefore = hub.latestSequence();
  rig.clock.advance(30_000);
  hub.tick();
  assert.equal(sink.text().includes(SSE_KEEPALIVE), false, '未到保活周期不该发心跳');

  rig.clock.advance(31_000);
  hub.tick();
  assert.equal(sink.text().includes(SSE_KEEPALIVE), true);
  assert.equal(hub.stats().keepalives, 1);
  assert.equal(hub.latestSequence(), idBefore, '心跳不产生新序号');
  assert.equal(handle.stats().lastEventId, idBefore);
});

/* --------------------------------------------- 6. HTTP 端到端（真实 server） */

interface StreamClient {
  status: number;
  contentType: string | undefined;
  body: string;
  request: ReturnType<typeof request>;
}

/** 打开一条 SSE 连接、收满 `expectMs` 毫秒后主动断开，返回收到的文本 */
function readStream(
  port: number,
  path: string,
  options: { lastEventId?: number; expectMs?: number } = {},
): Promise<StreamClient> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: options.lastEventId !== undefined ? { 'last-event-id': String(options.lastEventId) } : {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        const finish = (): void => {
          res.destroy();
          resolve({ status: res.statusCode ?? 0, contentType: res.headers['content-type'], body, request: req });
        };
        if (options.expectMs === undefined) {
          res.on('end', finish);
          return;
        }
        setTimeout(finish, options.expectMs);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('HTTP /board/v1/events：首屏快照 + 续传 + /health 诊断（真实 server）', async () => {
  const rig = useRig();
  const hub = useHub(rig);
  reportState(rig, 'ST-LAB01-01', 'occupied');
  reportState(rig, 'ST-LAB01-02', 'available');

  const board = createBoardServer({ view: rig.view, history: rig.history, eventStream: hub });
  openServers.push(board);
  board.server.listen(0, '127.0.0.1');
  await once(board.server, 'listening');
  const address = board.server.address();
  assert.ok(address !== null && typeof address === 'object');
  const port = address.port;

  const first = await readStream(port, '/board/v1/events', { expectMs: 120 });
  assert.equal(first.status, 200);
  assert.match(first.contentType ?? '', /^text\/event-stream/);
  assert.match(first.body, /^retry: 3000\n/);
  assert.match(first.body, /event: hello/);
  assert.match(first.body, /event: snapshot/);
  assert.match(first.body, /ST-LAB01-01/);

  // 续传：带 Last-Event-ID 重连（窗口内 → 有 hello，无 notice）
  const resumed = await readStream(port, '/board/v1/events', { lastEventId: 0, expectMs: 120 });
  assert.match(resumed.body, /event: hello/);
  assert.doesNotMatch(resumed.body, /event: notice/, '窗口内重连不该出现降级通知');

  // 未注入事件流 → 503（与 /history 同口径，不假装推流）
  const bare = createBoardServer({ view: rig.view });
  openServers.push(bare);
  bare.server.listen(0, '127.0.0.1');
  await once(bare.server, 'listening');
  const bareAddress = bare.server.address();
  assert.ok(bareAddress !== null && typeof bareAddress === 'object');
  const bareResult = await readStream(bareAddress.port, '/board/v1/events', { expectMs: 60 });
  assert.equal(bareResult.status, 503);
  assert.match(bareResult.body, /event-stream-not-configured/);

  // /health 暴露事件流诊断（不含凭据）
  const health = await new Promise<string>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/board/v1/health', method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
  const healthJson = JSON.parse(health) as { eventStream?: { opened: number; connections: number } };
  assert.ok(healthJson.eventStream !== undefined);
  assert.ok((healthJson.eventStream?.opened ?? 0) >= 2);
});

test('HTTP /board/v1/events：连接满时回 503 并计数', async () => {
  const rig = makeRig({ own: { 'PARAM-BOARD-EVENT-STREAM-MAX-CONNECTIONS': 1 } });
  openRigs.push(rig);
  const hub = useHub(rig);
  const board = createBoardServer({ view: rig.view, eventStream: hub });
  openServers.push(board);
  board.server.listen(0, '127.0.0.1');
  await once(board.server, 'listening');
  const address = board.server.address();
  assert.ok(address !== null && typeof address === 'object');

  const held = readStream(address.port, '/board/v1/events', { expectMs: 400 });
  await new Promise((resolve) => setTimeout(resolve, 80));

  const rejected = await readStream(address.port, '/board/v1/events', { expectMs: 80 });
  assert.equal(rejected.status, 503);
  assert.match(rejected.body, /event-stream-full/);

  await held;
  assert.equal(hub.stats().rejected, 1);
});
