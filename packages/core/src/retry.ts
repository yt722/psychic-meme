/**
 * 退避重试。
 *
 * 依据：`contracts/error-codes.md` §3.2 重试策略
 *
 * | errorClass | 重试 | 退避 |
 * |---|---|---|
 * | connect-timeout | 是 | 指数退避，基准 500ms，上限 PARAM-CONNECTOR-TIMEOUT |
 * | external-failure | 是 | 指数退避，基准 1s |
 * | external-full | 否 | — |
 * | lease-invalid | 否 | — |
 *
 * **释放动作例外**：release 即使遇到不可重试分类，也必须进入
 * "保持 releasing + 告警 + 人工队列"的恢复流程，不得直接放弃。
 */

import type { Clock } from './clock.js';
import { ServiceError, isRetryable } from './errors.js';

export interface RetryPolicy {
  /** 最大重试次数（不含首次） */
  maxAttempts: number;
  /** 退避基准毫秒 */
  baseDelayMs: number;
  /** 退避上限毫秒 */
  maxDelayMs: number;
  /** 退避倍率，默认 2（指数退避） */
  factor?: number;
  /** 是否加抖动，默认 false（便于测试确定性） */
  jitter?: boolean;
}

/** 按错误分类给出默认重试策略 */
export function defaultPolicyFor(errorClass: string): RetryPolicy | undefined {
  switch (errorClass) {
    case 'connect-timeout':
      return { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5000, factor: 2 };
    case 'external-failure':
      return { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 10_000, factor: 2 };
    case 'external-full':
    case 'lease-invalid':
      return undefined; // 不可重试
    default:
      return undefined;
  }
}

/** 计算第 attempt 次重试的退避毫秒（attempt 从 1 开始） */
export function backoffDelay(policy: RetryPolicy, attempt: number, random = Math.random): number {
  const factor = policy.factor ?? 2;
  const raw = policy.baseDelayMs * Math.pow(factor, attempt - 1);
  const capped = Math.min(raw, policy.maxDelayMs);
  if (policy.jitter !== true) return capped;

  // 全抖动：在 [base, capped] 之间取值
  const min = policy.baseDelayMs;
  return min + random() * Math.max(0, capped - min);
}

export interface RetryOutcome<T> {
  value?: T;
  error?: ServiceError;
  /** 总尝试次数（含首次） */
  attempts: number;
  /** 每次间隔的毫秒数，便于取证 */
  delaysMs: number[];
  /** 是否因不可重试而立即失败 */
  abortedAsNonRetryable: boolean;
}

/**
 * 执行带重试的操作。
 *
 * 不可重试的错误**立即失败**，不做无谓等待。
 * 达到最大次数后返回最后一次错误。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<RetryOutcome<T>> {
  const delaysMs: number[] = [];
  let lastError: ServiceError | undefined;

  for (let attempt = 1; attempt <= policy.maxAttempts + 1; attempt += 1) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt, delaysMs, abortedAsNonRetryable: false };
    } catch (error) {
      const svcError =
        error instanceof ServiceError
          ? error
          : new ServiceError({
              errorClass: 'external-failure',
              errorCode: 'GEN-1099',
              details: { raw: error instanceof Error ? error.message : String(error) },
            });

      lastError = svcError;

      // 不可重试：立即失败，不等待
      if (!isRetryable(svcError.errorClass)) {
        return { error: svcError, attempts: attempt, delaysMs, abortedAsNonRetryable: true };
      }

      const isLast = attempt > policy.maxAttempts;
      if (isLast) break;

      const delay = backoffDelay(policy, attempt);
      delaysMs.push(delay);
      await sleep(delay);
    }
  }

  return { error: lastError, attempts: policy.maxAttempts + 1, delaysMs, abortedAsNonRetryable: false };
}

/** 默认 sleep；测试可注入假实现配合 FakeClock */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 创建与 FakeClock 联动的 sleep。
 *
 * 推进假时钟而不真实等待，使超时重试测试瞬时完成。
 */
export function clockSleep(clock: Clock & { advance?: (ms: number) => void }): (ms: number) => Promise<void> {
  return async (ms: number): Promise<void> => {
    if (typeof clock.advance === 'function') {
      clock.advance(ms);
      return;
    }
    await defaultSleep(ms);
  };
}
