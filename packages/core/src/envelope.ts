/**
 * 事件信封、事件类型与去重规则。
 *
 * 依据：说明书 §4.2 末段、`contracts/event-envelope.md`
 *
 * 所有异步事件至少包含 specversion / id / type / source / time / traceId / eventId / data。
 * 同一 `eventId` 在 `PARAM-EVENT-DEDUP`（默认 24 小时）内不得重复处理。
 */

import type { Clock } from './clock.js';
import { DEFAULT_IDEMPOTENCY_WINDOW_MS } from './idempotency.js';

/** 事件类型枚举（说明书 §4.2） */
export type EventType =
  | 'alarm'
  | 'station.status'
  | 'task.training'
  | 'learning.event'
  | 'scheduler.lease'
  | 'control.command';

/** 统一事件信封 */
export interface EventEnvelope<T = Record<string, unknown>> {
  specversion: '1.0';
  id: string;
  type: EventType;
  source: string;
  time: string;
  traceId: string;
  /** 业务幂等键：同一 eventId 在去重窗口内不得重复处理 */
  eventId: string;
  data: T;
}

export interface CreateEnvelopeInput<T> {
  type: EventType;
  source: string;
  /** 业务幂等键；缺失时应由调用方生成，但**不得静默留空** */
  eventId: string;
  traceId?: string;
  /** 事件发生时间（ISO-8601）；缺省用时钟当前时间 */
  time?: string;
  data: T;
}

/**
 * 构造事件信封。
 *
 * `eventId` 必填：它是幂等键，缺失会导致重复事件无法识别。
 */
export function createEnvelope<T>(clock: Clock, input: CreateEnvelopeInput<T>): EventEnvelope<T> {
  if (!input.eventId || input.eventId.trim() === '') {
    throw new Error('createEnvelope: eventId 必填——它是幂等键，不允许为空');
  }

  const time = input.time ?? clock.iso();

  return {
    specversion: '1.0',
    id: `event-${input.eventId}`,
    type: input.type,
    source: input.source,
    time,
    traceId: input.traceId ?? `trace-${input.eventId}`,
    eventId: input.eventId,
    data: input.data,
  };
}

/** 校验事件信封结构完整性 */
export function isValidEnvelope(value: unknown): value is EventEnvelope<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;

  return (
    e['specversion'] === '1.0' &&
    typeof e['id'] === 'string' &&
    typeof e['type'] === 'string' &&
    typeof e['source'] === 'string' &&
    typeof e['time'] === 'string' &&
    typeof e['traceId'] === 'string' &&
    typeof e['eventId'] === 'string' &&
    e['eventId'] !== '' &&
    typeof e['data'] === 'object' &&
    e['data'] !== null
  );
}

export interface DedupResult {
  /** true 表示这是首次见到该事件，应处理；false 表示重复，应跳过 */
  accepted: boolean;
  /** 重复时为首次处理时间（毫秒） */
  firstSeenAt?: number;
}

/**
 * 事件去重器。
 *
 * 规则：同一 `eventId` 在窗口内只处理一次；重复事件返回 `accepted: false`，
 * 调用方应返回 `ok:true, duplicated:true`（**幂等命中不是错误**，见 `DEV-2001`）。
 */
export class EventDeduplicator {
  readonly #clock: Clock;
  readonly #windowMs: number;
  readonly #seen = new Map<string, number>();

  constructor(clock: Clock, windowMs: number = DEFAULT_IDEMPOTENCY_WINDOW_MS) {
    this.#clock = clock;
    this.#windowMs = windowMs;
  }

  /** 尝试接受一个事件 */
  accept(eventId: string): DedupResult {
    if (!eventId || eventId.trim() === '') {
      throw new Error('EventDeduplicator.accept: eventId 不能为空');
    }

    const now = this.#clock.now();
    const firstSeenAt = this.#seen.get(eventId);

    if (firstSeenAt !== undefined && now - firstSeenAt < this.#windowMs) {
      return { accepted: false, firstSeenAt };
    }

    this.#seen.set(eventId, now);
    this.#purge(now);
    return { accepted: true };
  }

  /** 已记录的事件数 */
  size(): number {
    this.#purge(this.#clock.now());
    return this.#seen.size;
  }

  clear(): void {
    this.#seen.clear();
  }

  #purge(now: number): void {
    for (const [key, at] of this.#seen) {
      if (now - at >= this.#windowMs) this.#seen.delete(key);
    }
  }
}

/**
 * 乱序事件处理策略。
 *
 * 说明书 §4.2：乱序事件按服务端序号或事件时间处理；
 * **不能恢复顺序时保留原始事件并告警**（不得静默丢弃）。
 */
export interface OutOfOrderResult {
  /** 是否被判定为乱序（时间戳早于已处理的最新时间） */
  outOfOrder: boolean;
  /** 建议动作 */
  action: 'process' | 'process-and-warn';
}

export function evaluateOrdering(eventTimeMs: number, latestProcessedMs: number | undefined): OutOfOrderResult {
  if (latestProcessedMs === undefined || eventTimeMs >= latestProcessedMs) {
    return { outOfOrder: false, action: 'process' };
  }
  // 乱序但不丢弃：保留原始事件并告警
  return { outOfOrder: true, action: 'process-and-warn' };
}
