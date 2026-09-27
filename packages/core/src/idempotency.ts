/**
 * 幂等存储。
 *
 * 依据：`contracts/README.md` §3 规则 1、`contracts/if-09-connector-actions.md` §1
 *
 * 铁律：**写操作一律幂等**。请求带 `requestId`，同 ID 重复请求返回**第一次的结果**，
 * 不重复执行副作用。窗口默认 24 小时。
 */

import type { Clock } from './clock.js';

export interface IdempotencyEntry<T> {
  requestId: string;
  /** 首次执行的完整结果 */
  result: T;
  /** 首次执行时间（毫秒） */
  storedAt: number;
}

export interface IdempotencyStoreOptions {
  clock: Clock;
  /** 幂等窗口，默认 24 小时 */
  windowMs?: number;
  /** 最大条目数，超出时淘汰最旧（防止内存无界增长） */
  maxEntries?: number;
}

/** 默认幂等窗口 24 小时 */
export const DEFAULT_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 内存幂等存储。
 *
 * 进程内有效；生产环境如需跨实例幂等，应替换为共享存储（接口不变）。
 */
export class IdempotencyStore<T = unknown> {
  readonly #clock: Clock;
  readonly #windowMs: number;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, IdempotencyEntry<T>>();

  constructor(options: IdempotencyStoreOptions) {
    this.#clock = options.clock;
    this.#windowMs = options.windowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS;
    this.#maxEntries = options.maxEntries ?? 10_000;
  }

  /**
   * 查询是否已有该请求的结果。
   *
   * 命中且未过期则返回首次结果；过期条目视为不存在并顺手清理。
   */
  get(requestId: string): T | undefined {
    const entry = this.#entries.get(requestId);
    if (entry === undefined) return undefined;

    if (this.#isExpired(entry)) {
      this.#entries.delete(requestId);
      return undefined;
    }
    return entry.result;
  }

  /** 是否已存在（未过期的）该请求 */
  has(requestId: string): boolean {
    return this.get(requestId) !== undefined;
  }

  /**
   * 记录首次执行结果。
   *
   * 若已存在未过期条目，**不覆盖**——保证"重复请求返回第一次的结果"。
   * 返回 true 表示本次写入生效（即这是首次），false 表示已存在。
   */
  put(requestId: string, result: T): boolean {
    const existing = this.#entries.get(requestId);
    if (existing !== undefined && !this.#isExpired(existing)) {
      return false;
    }

    if (this.#entries.size >= this.#maxEntries) {
      this.#evictOldest();
    }

    this.#entries.set(requestId, {
      requestId,
      result,
      storedAt: this.#clock.now(),
    });
    return true;
  }

  /**
   * 幂等包装：命中直接返回首次结果，未命中才执行并记录。
   *
   * 这是各服务写操作的标准入口。
   */
  async run(requestId: string, fn: () => Promise<T>): Promise<{ result: T; duplicated: boolean }> {
    const cached = this.get(requestId);
    if (cached !== undefined) {
      return { result: cached, duplicated: true };
    }

    const result = await fn();
    this.put(requestId, result);
    return { result, duplicated: false };
  }

  /** 当前有效条目数 */
  size(): number {
    this.#purgeExpired();
    return this.#entries.size;
  }

  /** 清空（测试用） */
  clear(): void {
    this.#entries.clear();
  }

  #isExpired(entry: IdempotencyEntry<T>): boolean {
    return this.#clock.now() - entry.storedAt >= this.#windowMs;
  }

  #purgeExpired(): void {
    for (const [key, entry] of this.#entries) {
      if (this.#isExpired(entry)) this.#entries.delete(key);
    }
  }

  #evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;

    for (const [key, entry] of this.#entries) {
      if (entry.storedAt < oldestAt) {
        oldestAt = entry.storedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.#entries.delete(oldestKey);
  }
}
