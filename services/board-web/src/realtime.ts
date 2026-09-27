/**
 * 实时刷新与断线恢复（S01.4）。
 *
 * | 机制 | 参数 | 行为 |
 * |---|---|---|
 * | 广播节奏 | `PARAM-MAP-BROADCAST`（1Hz） | 到点把累积的增量变更打成帧下发 |
 * | 兜底轮询 | `PARAM-MAP-FALLBACK`（6s） | **广播断层**（超过该周期没成功广播）即全量拉一次 |
 * | 断线重连 | `PARAM-RECONNECT-RESTORE`（10s） | 窗口内重连**不丢订阅**并补发断线期间的变更；超窗标记 `degraded` 并**强制全量刷新** |
 *
 * 为什么要有兜底：广播是"变化驱动"的，网关抖动会让变更静默丢失而**看板看起来正常**——
 * 这比看板报错更危险。兜底周期到点就全量对齐一次，把"少了一条变更"从静默错误变成自愈。
 *
 * 为什么重连要限窗口：断开太久后本地累积的增量已不可信（可能跨了状态源重启/换班），
 * 补发增量会让前端停在一个**拼不回去**的状态上，因此超窗必须整体替换（全量帧）。
 *
 * 本模块**只负责搬运帧**，不产生也不推导任何工位状态。
 */

import { toIso } from '@peripheral/core';
import type { Clock } from '@peripheral/core';

import { defaultBoardParams, BOARD_PARAM, type BoardParams } from './params.js';
import type { ProjectionEvent, StationProjection } from './projection.js';
import type {
  FrameChange,
  FrameListener,
  FrameReason,
  RealtimeFrame,
  RealtimeStats,
  ReconnectResult,
} from './types.js';

export interface RealtimeChannelDeps {
  params?: BoardParams;
  clock: Clock;
  /**
   * 就地订阅状态投影：投影迁移会自动进入待下发队列。
   * 不注入时通道仍可用（由调用方自行 `publish`），便于单测与替换数据源。
   */
  projection?: StationProjection;
}

export class RealtimeChannel {
  readonly #params: BoardParams;
  readonly #clock: Clock;
  readonly #listeners = new Set<FrameListener>();
  /** 已产生但还没下发的变更 */
  #pending: FrameChange[] = [];
  /** 断线期间缓冲的变更（重连时补发或丢弃） */
  #backlog: FrameChange[] = [];
  #backlogDropped = 0;
  #connected = true;
  #disconnectedAtMs: number | undefined;
  #degraded = false;
  #sequence = 0;
  #reconnects = 0;
  #forcedFullRefreshes = 0;
  #lastBroadcastAtMs: number;
  #lastReconnect: ReconnectResult | undefined;
  readonly #projection: StationProjection | undefined;
  #unsubscribeProjection: (() => void) | undefined;
  #listenerErrors = 0;

  constructor(deps: RealtimeChannelDeps) {
    this.#params = deps.params ?? defaultBoardParams();
    this.#clock = deps.clock;
    this.#lastBroadcastAtMs = deps.clock.now();
    this.#projection = deps.projection;

    if (deps.projection !== undefined) {
      this.#unsubscribeProjection = deps.projection.subscribe((event) => {
        this.publish(toChange(event));
      });
    }
  }

  /* ------------------------------------------------------------- 订阅 */

  /** 订阅下发帧；返回退订函数。**断线不会清空订阅**（重连后原订阅仍在） */
  subscribe(listener: FrameListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  subscriptionCount(): number {
    return this.#listeners.size;
  }

  /* ------------------------------------------------------------- 变更入队 */

  /** 记录一条（或一批）变更。断线期间进入 backlog，不再直接下发。 */
  publish(delta: FrameChange | readonly FrameChange[]): void {
    const changes: FrameChange[] = Array.isArray(delta)
      ? (delta as FrameChange[]).slice()
      : [delta as FrameChange];
    if (changes.length === 0) return;

    if (!this.#connected) {
      this.#backlog.push(...changes);
      this.#trimBacklog();
      return;
    }
    this.#pending.push(...changes);
  }

  /* ------------------------------------------------------------- 节奏 */

  /**
   * 是否应当走兜底全量：**距上次成功广播**已超过 `PARAM-MAP-FALLBACK`。
   *
   * 判据刻意用"上次广播时间"而不是"上次兜底时间"：
   * 只要 1Hz 广播还在正常工作，兜底永远不该触发；一旦广播断层，兜底立刻接手。
   */
  shouldFallback(nowMs: number): boolean {
    return nowMs - this.#lastBroadcastAtMs >= this.#params.fallbackPeriodMs();
  }

  /**
   * 推进一次刷新节奏，返回**本次要下发的帧**（无内容可发时返回 undefined）。
   *
   * 顺序：断线 → 不发；广播断层 → 全量帧（`fallback`）；到广播周期且有变更 → 增量帧（`broadcast`）。
   */
  tick(nowMs?: number): RealtimeFrame | undefined {
    const now = nowMs ?? this.#clock.now();
    if (!this.#connected) return undefined;

    if (this.shouldFallback(now)) return this.#emit('fallback', now, true);

    const period = this.#params.broadcastPeriodMs();
    if (now - this.#lastBroadcastAtMs >= period && this.#pending.length > 0) {
      return this.#emit('broadcast', now, false);
    }
    return undefined;
  }

  /** 立即全量拉取一帧并下发（兜底 / 重连 / 手工对齐用） */
  poll(nowMs?: number): RealtimeFrame {
    return this.#emit('fallback', nowMs ?? this.#clock.now(), true);
  }

  /* --------------------------------------------------------- 断线重连 */

  /**
   * 断开（订阅保留）。
   *
   * 幂等：已断开时重复调用不会重置断线时刻（否则恢复窗口会被无限续期）。
   */
  disconnect(atMs?: number): void {
    if (!this.#connected) return;
    const now = atMs ?? this.#clock.now();
    this.#connected = false;
    this.#disconnectedAtMs = now;
    // 未下发的增量转入 backlog：重连时一并补发
    if (this.#pending.length > 0) {
      this.#backlog.push(...this.#pending);
      this.#pending = [];
      this.#trimBacklog();
    }
  }

  /**
   * 重连。
   *
   * - 在 `PARAM-RECONNECT-RESTORE` 窗口内：**订阅不丢**，把断线期间缓冲的变更补发为一个
   *   `reconnect` 帧（可能为空帧，表示"通道已恢复、无需补发"）。
   * - 超过窗口：标记 `degraded` 并**强制全量刷新**（`full: true`），
   *   因为本地增量已不可信。强制刷新完成后 `degraded` 清零，计数留痕在 {@link stats}。
   */
  reconnect(atMs?: number): ReconnectResult {
    if (this.#connected) {
      return {
        reconnectedAtMs: atMs ?? this.#clock.now(),
        offlineMs: 0,
        withinWindow: true,
        degraded: false,
        replayedChanges: 0,
        subscriptions: this.#listeners.size,
      };
    }

    const now = atMs ?? this.#clock.now();
    const disconnectedAt = this.#disconnectedAtMs ?? now;
    const offlineMs = Math.max(0, now - disconnectedAt);
    const restoreMs = this.#params.reconnectRestoreMs();
    const withinWindow = offlineMs <= restoreMs;

    this.#connected = true;
    this.#disconnectedAtMs = undefined;
    this.#reconnects += 1;

    const replay = [...this.#backlog, ...this.#pending];
    this.#backlog = [];
    this.#pending = [];

    if (!withinWindow) this.#degraded = true;

    let frame: RealtimeFrame;
    if (withinWindow) {
      frame = this.#emit('reconnect', now, false, replay);
    } else {
      frame = this.#emit('reconnect', now, true);
      this.#forcedFullRefreshes += 1;
      // 强制全量刷新已下发，degraded 状态随之解除（留痕在 result 与 frame 上）
      this.#degraded = false;
    }

    const result: ReconnectResult = {
      reconnectedAtMs: now,
      offlineMs,
      withinWindow,
      degraded: frame.degraded,
      replayedChanges: withinWindow ? replay.length : 0,
      subscriptions: this.#listeners.size,
      frame,
    };
    this.#lastReconnect = result;
    return result;
  }

  /* ------------------------------------------------------------- 状态 */

  isConnected(): boolean {
    return this.#connected;
  }

  /** 是否处于"已超窗、正在强制全量刷新"的降级态（刷新完成即清零） */
  isDegraded(): boolean {
    return this.#degraded;
  }

  bufferedCount(): number {
    return this.#pending.length + this.#backlog.length;
  }

  stats(): RealtimeStats {
    return {
      connected: this.#connected,
      degraded: this.#degraded,
      subscriptions: this.#listeners.size,
      pendingChanges: this.#pending.length,
      backloggedChanges: this.#backlog.length,
      backlogDropped: this.#backlogDropped,
      sequence: this.#sequence,
      reconnects: this.#reconnects,
      forcedFullRefreshes: this.#forcedFullRefreshes,
      lastBroadcastAtMs: this.#lastBroadcastAtMs,
      ...(this.#lastReconnect !== undefined ? { lastReconnect: this.#lastReconnect } : {}),
    };
  }

  /** 节拍周期（毫秒），供上层调度 */
  intervalMs(): { broadcast: number; fallback: number; restore: number } {
    return {
      broadcast: this.#params.broadcastPeriodMs(),
      fallback: this.#params.fallbackPeriodMs(),
      restore: this.#params.reconnectRestoreMs(),
    };
  }

  /** 解绑投影订阅并清空订阅者（进程退出 / 测试收尾用） */
  dispose(): void {
    this.#unsubscribeProjection?.();
    this.#unsubscribeProjection = undefined;
    this.#listeners.clear();
  }

  /* ------------------------------------------------------------- 内部 */

  #emit(reason: FrameReason, nowMs: number, full: boolean, explicit?: FrameChange[]): RealtimeFrame {
    const changes = explicit ?? (full ? this.#snapshotChanges() : this.#drainPending());
    if (full) this.#pending = [];

    this.#sequence += 1;
    const frame: RealtimeFrame = {
      sequence: this.#sequence,
      atMs: nowMs,
      iso: toIso(nowMs),
      reason,
      full,
      changes,
      degraded: this.#degraded,
    };

    this.#lastBroadcastAtMs = nowMs;
    for (const listener of this.#listeners) {
      try {
        listener(frame);
      } catch {
        this.#listenerErrors += 1;
      }
    }
    return frame;
  }

  #drainPending(): FrameChange[] {
    const pending = this.#pending;
    this.#pending = [];
    return pending;
  }

  /** 全量帧内容：优先取投影快照（真正的"全量对齐"）；无投影时退回待下发增量 */
  #snapshotChanges(): FrameChange[] {
    const projection = this.#projection;
    if (projection === undefined) return this.#drainPending();

    return projection.snapshot().map((record) => ({
      stationCode: record.stationCode,
      state: record.state,
      atMs: record.atMs,
      sourceKind: record.sourceKind,
    }));
  }

  #trimBacklog(): void {
    const max = this.#params.number(BOARD_PARAM.RECONNECT_BACKLOG_MAX);
    if (this.#backlog.length <= max) return;
    const overflow = this.#backlog.length - max;
    this.#backlog.splice(0, overflow);
    this.#backlogDropped += overflow;
  }
}

/** 投影迁移 → 帧变更 */
export function toChange(event: ProjectionEvent): FrameChange {
  return {
    stationCode: event.stationCode,
    state: event.to,
    atMs: event.atMs,
    sourceKind: event.record.sourceKind,
  };
}
