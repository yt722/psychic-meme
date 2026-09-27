/**
 * S01.5 现场状态上屏：SSE 事件流（`node:http`，零第三方依赖）。
 *
 * 为什么用 SSE 而不是 WebSocket：看板是**单向只读**的，SSE 由浏览器原生
 * `EventSource` 消费，自带断线重连、`retry:` 退避提示与 `Last-Event-ID`
 * 续传头——这三样恰好就是 S01.5 的验收项，不需要引任何库。
 *
 * | 机制 | 参数 | 行为 |
 * |---|---|---|
 * | 重连退避提示 | `PARAM-BOARD-EVENT-STREAM-RETRY` | 每条连接的 `retry:` 行 |
 * | 心跳保活 | `PARAM-BOARD-EVENT-STREAM-KEEPALIVE` | 空闲时发 `: keepalive` 注释行 |
 * | 背压合并 | `PARAM-BOARD-EVENT-STREAM-COALESCE-MAX` | 慢客户端只留**每工位最新**状态 |
 * | 续传窗口 | `PARAM-BOARD-EVENT-STREAM-REPLAY-MAX` | 环形缓冲保留最近 N 帧供 `Last-Event-ID` 补发 |
 * | 连接上限 | `PARAM-BOARD-EVENT-STREAM-MAX-CONNECTIONS` | 超出即拒（503），保护看板本身 |
 *
 * 三条不可退让的口径：
 * 1. **不静默丢事件**：`Last-Event-ID` 落在续传窗口内 → 逐帧补发；落在窗口外
 *    （过旧/未知/超前）→ 发 `event: notice` 说明原因 **并**整体重发全量快照，
 *    绝不让客户端停在一个拼不回去的视图上。
 * 2. **不无限缓冲**：慢客户端不会让内存增长——待下发变更按 `stationCode` 合并，
 *    同工位**后到的覆盖先到的**（状态是"最新值"，不是流水），合并条数另行计数。
 * 3. **只搬运**：本模块不产生、不推导、不修改任何工位状态。
 */

import { toIso, type Clock } from '@peripheral/core';

import { BOARD_PARAM, defaultBoardParams, type BoardParams } from './params.js';
import type { FrameChange, FrameListener, RealtimeFrame } from './types.js';

/* ------------------------------------------------------------------ 契约 */

/** 可写出口：真实连接是 `ServerResponse`，测试用假 sink 复现背压 */
export interface EventStreamSink {
  /** 返回 `false` 表示下游背压（本次已尽力写出，不要再灌） */
  write(chunk: string): boolean;
  /** 背压解除时回调（每次转阻塞只注册一次） */
  onDrain(listener: () => void): void;
  /** 连接结束 */
  end(): void;
}

/** 帧来源（看板实时通道），只要 `subscribe` 这一件事，便于替换数据源 */
export interface FrameSource {
  subscribe(listener: FrameListener): () => void;
}

export interface EventStreamDeps {
  params?: BoardParams;
  clock: Clock;
  /** 帧来源：看板的 `RealtimeChannel` */
  frames: FrameSource;
  /** 全量状态提供者；缺省时用本模块已见到的"每工位最新值"兜底 */
  snapshot?: () => FrameChange[];
}

/** 单条连接的诊断快照（不含凭据） */
export interface EventStreamConnectionStats {
  lastEventId?: number;
  sentEvents: number;
  coalescedChanges: number;
  droppedChanges: number;
  slowClient: boolean;
  openMs: number;
}

/** 事件流总诊断快照（不含凭据） */
export interface EventStreamStats {
  connections: number;
  opened: number;
  closed: number;
  rejected: number;
  sentEvents: number;
  coalescedChanges: number;
  droppedChanges: number;
  replayedEvents: number;
  fullResends: number;
  slowClients: number;
  keepalives: number;
  lastEventId: number;
  recentFrames: number;
  recentCapacity: number;
}

/** 一条已打开的连接 */
export interface EventStreamHandle {
  close(): void;
  stats(): EventStreamConnectionStats;
}

/** `Last-Event-ID` 的处置结论 */
export interface ResumeDecision {
  kind: 'fresh' | 'replay' | 'resync';
  /** 需要补发的历史帧（`resync` 时为空，改发全量快照） */
  frames: RealtimeFrame[];
  reason?: string;
  requestedId?: number;
  oldestId?: number;
}

/* --------------------------------------------------------------- SSE 编码 */

/** 一条 SSE 消息（`id:` + `event:` + `data:` + 空行），字段顺序固定便于比对 */
export function formatSseMessage(input: {
  id?: number;
  event: string;
  data: unknown;
  retryMs?: number;
}): string {
  const lines: string[] = [];
  if (input.retryMs !== undefined) lines.push(`retry: ${input.retryMs}`);
  if (input.id !== undefined) lines.push(`id: ${input.id}`);
  lines.push(`event: ${input.event}`);
  lines.push(`data: ${JSON.stringify(input.data)}`);
  return `${lines.join('\n')}\n\n`;
}

/** 心跳注释行（收到即证明通道还活着，但**不推进 `Last-Event-ID`**） */
export const SSE_KEEPALIVE = ': keepalive\n\n';

/** 解析 `Last-Event-ID` 请求头：非负整数才认，其余按"新连接"处理 */
export function parseLastEventId(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

/* ------------------------------------------------------------ 连接实现 */

class Connection implements EventStreamHandle {
  readonly #hub: BoardEventHub;
  readonly #clock: Clock;
  readonly #sink: EventStreamSink;
  readonly #openedAtMs: number;
  /** 待下发变更：同工位只留最新（插入顺序 = 首次出现顺序） */
  readonly #outbox = new Map<string, FrameChange>();
  /** 本批待下发帧里"最新一帧"的元信息 */
  #meta: RealtimeFrame | undefined;
  #anyFull = false;
  #blocked = false;
  #closed = false;
  #lastWriteAtMs: number;
  #lastEventId: number | undefined;
  #sentEvents = 0;
  #coalesced = 0;
  #dropped = 0;
  #slowClient = false;

  constructor(hub: BoardEventHub, clock: Clock, sink: EventStreamSink) {
    this.#hub = hub;
    this.#clock = clock;
    this.#sink = sink;
    this.#openedAtMs = clock.now();
    this.#lastWriteAtMs = this.#openedAtMs;
    this.#sink.onDrain(() => {
      this.#blocked = false;
      this.flush();
    });
  }

  /** 连接建立：先给重连提示与续传结论（这一步失败即视为连不上，直接结束） */
  open(lastEventId: number | undefined): ResumeDecision {
    const decision = this.#hub.decideResume(lastEventId);
    const retryMs = this.#hub.retryMs();
    const hello = formatSseMessage({
      retryMs,
      event: 'hello',
      data: {
        serverTime: toIso(this.#clock.now()),
        sequence: this.#hub.latestSequence(),
        retryMs,
        resumed: decision.kind === 'replay',
        resumedFrom: decision.requestedId ?? null,
        replayed: decision.frames.length,
      },
    });

    if (decision.kind === 'replay') {
      // 逐帧补发：顺序与线上一致，客户端按 `id` 去重即可
      const chunks = decision.frames.map((frame) => this.#encodeFrame(frame));
      this.#write(hello + chunks.join(''));
      this.#lastEventId = this.#hub.latestSequence();
      return decision;
    }

    if (decision.kind === 'resync') {
      this.#hub.noteFullResend();
      const notice = formatSseMessage({
        event: 'notice',
        data: {
          reason: decision.reason ?? 'last-event-id-unknown',
          requestedId: decision.requestedId ?? null,
          oldestId: decision.oldestId ?? null,
          latestId: this.#hub.latestSequence(),
          serverTime: toIso(this.#clock.now()),
        },
      });
      const snapshot = this.#snapshotMessage(decision.reason ?? 'last-event-id-unknown', decision);
      this.#write(hello + notice + snapshot);
      this.#lastEventId = this.#hub.latestSequence();
      return decision;
    }

    // 新连接：直接给一份全量快照，前端首屏不必再多打一次 HTTP
    const snapshot = this.#snapshotMessage('connect');
    this.#write(hello + snapshot);
    this.#lastEventId = this.#hub.latestSequence();
    return decision;
  }

  /** 收到一帧：入待发队列（合并），必要时立即下发 */
  ingest(frame: RealtimeFrame): void {
    if (this.#closed) return;
    if (frame.changes.length === 0 && !frame.full) return;

    const cap = this.#hub.coalesceMax();
    for (const change of frame.changes) {
      if (!this.#outbox.has(change.stationCode) && this.#outbox.size >= cap) {
        // 超出容量只丢**最旧**的那条，并计数——绝不让内存跟着客户端慢下去
        const oldest = this.#outbox.keys().next();
        if (!oldest.done) {
          this.#outbox.delete(oldest.value as string);
          this.#dropped += 1;
          this.#hub.noteDropped();
        }
      }
      if (this.#outbox.has(change.stationCode)) {
        this.#coalesced += 1;
        this.#hub.noteCoalesced();
      }
      this.#outbox.set(change.stationCode, change);
    }

    this.#meta = frame;
    if (frame.full) this.#anyFull = true;
    this.flush();
  }

  /** 把待发队列打成一条 SSE 帧下发（阻塞时只累积不写） */
  flush(): void {
    if (this.#closed || this.#blocked) return;
    if (this.#outbox.size === 0) return;

    const meta = this.#meta;
    const changes = [...this.#outbox.values()];
    const full = this.#anyFull || meta?.full === true;
    this.#outbox.clear();
    this.#anyFull = false;

    const sequence = meta?.sequence ?? this.#lastEventId ?? 0;
    const chunk = formatSseMessage({
      id: sequence,
      event: 'state',
      data: {
        sequence,
        atMs: meta?.atMs ?? this.#clock.now(),
        iso: meta?.iso ?? toIso(meta?.atMs ?? this.#clock.now()),
        reason: meta?.reason ?? 'broadcast',
        full,
        degraded: meta?.degraded ?? false,
        merged: this.#coalesced,
        count: changes.length,
        changes,
      },
    });
    this.#lastEventId = sequence;
    this.#write(chunk);
  }

  /** 空闲保活；`Last-Event-ID` 不被心跳推进 */
  keepalive(nowMs: number): void {
    if (this.#closed || this.#blocked) return;
    if (nowMs - this.#lastWriteAtMs < this.#hub.keepaliveMs()) return;
    this.#write(SSE_KEEPALIVE);
    this.#hub.noteKeepalive();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#outbox.clear();
    try {
      this.#sink.end();
    } catch {
      // 对端已断开时 `end()` 可能抛错；连接已经关了，不再向上暴露
    }
    this.#hub.noteClosed(this);
  }

  stats(): EventStreamConnectionStats {
    return {
      ...(this.#lastEventId !== undefined ? { lastEventId: this.#lastEventId } : {}),
      sentEvents: this.#sentEvents,
      coalescedChanges: this.#coalesced,
      droppedChanges: this.#dropped,
      slowClient: this.#slowClient,
      openMs: this.#clock.now() - this.#openedAtMs,
    };
  }

  /** 是否处于背压阻塞（供 hub 统计与测试断言） */
  isBlocked(): boolean {
    return this.#blocked;
  }

  /* ------------------------------------------------------------ 内部 */

  #snapshotMessage(reason: string, decision?: ResumeDecision): string {
    const changes = this.#hub.snapshotChanges();
    const sequence = this.#hub.latestSequence();
    this.#lastEventId = sequence;
    return formatSseMessage({
      id: sequence,
      event: 'snapshot',
      data: {
        sequence,
        atMs: this.#clock.now(),
        iso: toIso(this.#clock.now()),
        reason,
        full: true,
        degraded: decision?.kind === 'resync',
        count: changes.length,
        changes,
      },
    });
  }

  #encodeFrame(frame: RealtimeFrame): string {
    return formatSseMessage({
      id: frame.sequence,
      event: 'state',
      data: {
        sequence: frame.sequence,
        atMs: frame.atMs,
        iso: frame.iso,
        reason: frame.reason,
        full: frame.full,
        degraded: frame.degraded,
        replayed: true,
        count: frame.changes.length,
        changes: frame.changes,
      },
    });
  }

  #write(chunk: string): void {
    if (this.#closed) return;
    let ok = true;
    try {
      ok = this.#sink.write(chunk) !== false;
    } catch {
      // 写失败等价于对端断开：立刻关连接，不把异常抛进采集/广播路径
      this.close();
      return;
    }
    this.#lastWriteAtMs = this.#clock.now();
    this.#sentEvents += 1;
    this.#hub.noteSent(chunk.length);
    if (!ok) {
      this.#blocked = true;
      if (!this.#slowClient) {
        this.#slowClient = true;
        this.#hub.noteSlowClient();
      }
    }
  }
}

/* ------------------------------------------------------------------ 中枢 */

export class BoardEventHub {
  readonly #params: BoardParams;
  readonly #clock: Clock;
  readonly #snapshotProvider: (() => FrameChange[]) | undefined;
  readonly #connections = new Set<Connection>();
  readonly #recent: RealtimeFrame[] = [];
  /** 每工位最新状态（`snapshot` 未注入时的兜底全量源） */
  readonly #latest = new Map<string, FrameChange>();
  #unsubscribe: (() => void) | undefined;
  #latestSequence = 0;
  #opened = 0;
  #closed = 0;
  #rejected = 0;
  #sentEvents = 0;
  #sentBytes = 0;
  #coalesced = 0;
  #dropped = 0;
  #replayed = 0;
  #fullResends = 0;
  #slowClients = 0;
  #keepalives = 0;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: EventStreamDeps) {
    this.#params = deps.params ?? defaultBoardParams();
    this.#clock = deps.clock;
    this.#snapshotProvider = deps.snapshot;
    this.#unsubscribe = deps.frames.subscribe((frame) => {
      this.ingest(frame);
    });
  }

  /** 连接容量检查（先判再写响应头，避免已发 200 之后才发现拒连） */
  canOpen(): boolean {
    return this.#connections.size < this.maxConnections();
  }

  /** 打开一条连接：容量满时抛错（调用方应回 503） */
  open(lastEventId: number | undefined, sink: EventStreamSink): EventStreamHandle {
    if (!this.canOpen()) {
      this.#rejected += 1;
      throw new Error(`event-stream-full: 连接数已达上限 ${this.maxConnections()}`);
    }
    const connection = new Connection(this, this.#clock, sink);
    this.#connections.add(connection);
    this.#opened += 1;
    this.#ensureTimer();
    const decision = connection.open(lastEventId);
    if (decision.kind === 'replay') this.#replayed += decision.frames.length;
    return connection;
  }

  /** 帧入库：环形缓冲 + 每工位最新值 + 广播给所有连接 */
  ingest(frame: RealtimeFrame): void {
    if (frame.sequence > this.#latestSequence) this.#latestSequence = frame.sequence;
    this.#recent.push(frame);
    const capacity = this.recentCapacity();
    if (this.#recent.length > capacity) this.#recent.splice(0, this.#recent.length - capacity);
    for (const change of frame.changes) this.#latest.set(change.stationCode, change);
    for (const connection of [...this.#connections]) connection.ingest(frame);
  }

  /**
   * `Last-Event-ID` 续传判定（本模块"不静默丢事件"的唯一实现处）。
   *
   * - 无 id：新连接 → 全量快照；
   * - id 正好是当前序号：没有缺口；
   * - id 在环形缓冲内：补发其后所有帧（逐帧、不合并）；
   * - id 过旧 / 未知 / 超前：**明确回退为全量重发**，并带 `notice` 说明原因。
   */
  decideResume(lastEventId: number | undefined): ResumeDecision {
    if (lastEventId === undefined) return { kind: 'fresh', frames: [] };
    // 序号正好对齐：无论有没有历史帧，都说明客户端没有缺口（不算降级）
    if (lastEventId === this.#latestSequence) {
      return { kind: 'replay', frames: [], requestedId: lastEventId };
    }
    if (this.#recent.length === 0) {
      // 一帧都还没产生过：没有任何可补发的东西，只能全量
      return { kind: 'resync', frames: [], reason: 'no-history-yet', requestedId: lastEventId };
    }

    const oldest = this.#recent[0] as RealtimeFrame;
    if (lastEventId > this.#latestSequence) {
      return { kind: 'resync', frames: [], reason: 'last-event-id-ahead', requestedId: lastEventId, oldestId: oldest.sequence };
    }
    if (lastEventId < oldest.sequence) {
      return { kind: 'resync', frames: [], reason: 'last-event-id-too-old', requestedId: lastEventId, oldestId: oldest.sequence };
    }

    const index = this.#recent.findIndex((frame) => frame.sequence === lastEventId);
    if (index < 0) {
      return { kind: 'resync', frames: [], reason: 'last-event-id-unknown', requestedId: lastEventId, oldestId: oldest.sequence };
    }
    return {
      kind: 'replay',
      frames: this.#recent.slice(index + 1),
      reason: 'replayed',
      requestedId: lastEventId,
      oldestId: oldest.sequence,
    };
  }

  /** 推进保活与滞留下发（由构造时的定时器或测试显式调用驱动） */
  tick(nowMs: number = this.#clock.now()): void {
    for (const connection of [...this.#connections]) {
      connection.flush();
      connection.keepalive(nowMs);
    }
  }

  latestSequence(): number {
    return this.#latestSequence;
  }

  /** 全量状态：优先用注入的提供者（真实投影），否则用已见到的每工位最新值 */
  snapshotChanges(): FrameChange[] {
    const provided = this.#snapshotProvider?.();
    if (provided !== undefined) return provided;
    return [...this.#latest.values()];
  }

  stats(): EventStreamStats {
    return {
      connections: this.#connections.size,
      opened: this.#opened,
      closed: this.#closed,
      rejected: this.#rejected,
      sentEvents: this.#sentEvents,
      coalescedChanges: this.#coalesced,
      droppedChanges: this.#dropped,
      replayedEvents: this.#replayed,
      fullResends: this.#fullResends,
      slowClients: this.#slowClients,
      keepalives: this.#keepalives,
      lastEventId: this.#latestSequence,
      recentFrames: this.#recent.length,
      recentCapacity: this.recentCapacity(),
    };
  }

  /** 已写出字节数（诊断用，不进 `stats()` 的对外字段，避免口径漂移） */
  sentBytes(): number {
    return this.#sentBytes;
  }

  dispose(): void {
    this.closeConnections();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /** 断开全部推流连接（服务关停用）；订阅与环形缓冲保留，便于重启前诊断 */
  closeConnections(): void {
    for (const connection of [...this.#connections]) connection.close();
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /* ------------------------------------------------------------ 内部 */

  retryMs(): number {
    return this.#params.number(BOARD_PARAM.EVENT_STREAM_RETRY_MS);
  }

  keepaliveMs(): number {
    return this.#params.number(BOARD_PARAM.EVENT_STREAM_KEEPALIVE_MS);
  }

  coalesceMax(): number {
    return this.#params.number(BOARD_PARAM.EVENT_STREAM_COALESCE_MAX);
  }

  recentCapacity(): number {
    return this.#params.number(BOARD_PARAM.EVENT_STREAM_REPLAY_MAX);
  }

  maxConnections(): number {
    return this.#params.number(BOARD_PARAM.EVENT_STREAM_MAX_CONNECTIONS);
  }

  noteSent(bytes: number): void {
    this.#sentEvents += 1;
    this.#sentBytes += bytes;
  }

  noteSlowClient(): void {
    this.#slowClients += 1;
  }

  noteCoalesced(): void {
    this.#coalesced += 1;
  }

  noteDropped(): void {
    this.#dropped += 1;
  }

  /** 因连接数上限被拒（由 HTTP 层在写响应头之前调用） */
  noteRejected(): void {
    this.#rejected += 1;
  }

  noteFullResend(): void {
    this.#fullResends += 1;
  }

  noteKeepalive(): void {
    this.#keepalives += 1;
  }

  noteClosed(connection: Connection): void {
    this.#connections.delete(connection);
    this.#closed += 1;
    if (this.#connections.size === 0 && this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** 首个连接打开时启动保活定时器；无连接即停（不空转） */
  #ensureTimer(): void {
    if (this.#timer !== undefined) return;
    const periodMs = Math.max(1, Math.floor(this.keepaliveMs() / 2));
    this.#timer = setInterval(() => {
      this.tick();
    }, periodMs);
    this.#timer.unref?.();
  }
}
