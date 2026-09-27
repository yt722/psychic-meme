import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock, ServiceError, errors } from '../src/index.js';
import {
  withRetry,
  backoffDelay,
  defaultPolicyFor,
  clockSleep,
  type RetryPolicy,
} from '../src/index.js';

const policy: RetryPolicy = { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5000, factor: 2 };

describe('retry: 退避计算', () => {
  it('指数退避：500 → 1000 → 2000', () => {
    assert.equal(backoffDelay(policy, 1), 500);
    assert.equal(backoffDelay(policy, 2), 1000);
    assert.equal(backoffDelay(policy, 3), 2000);
  });

  it('受 maxDelayMs 上限约束', () => {
    const p: RetryPolicy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 1500, factor: 2 };
    assert.equal(backoffDelay(p, 1), 500);
    assert.equal(backoffDelay(p, 2), 1000);
    assert.equal(backoffDelay(p, 3), 1500);
    assert.equal(backoffDelay(p, 4), 1500, '不得超过上限');
  });

  it('启用 jitter 时落在 [base, capped] 区间', () => {
    const p: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 2000, factor: 2, jitter: true };
    const delay = backoffDelay(p, 3, () => 0.5);
    assert.ok(delay >= 500 && delay <= 2000, `jitter 结果越界：${delay}`);
  });
});

describe('retry: 分类默认策略', () => {
  it('connect-timeout 可重试，基准 500ms', () => {
    const p = defaultPolicyFor('connect-timeout');
    assert.ok(p);
    assert.equal(p.baseDelayMs, 500);
    assert.equal(p.maxAttempts, 2);
  });

  it('external-failure 可重试，基准 1s', () => {
    const p = defaultPolicyFor('external-failure');
    assert.ok(p);
    assert.equal(p.baseDelayMs, 1000);
  });

  it('external-full 与 lease-invalid 不可重试 → 无策略', () => {
    assert.equal(defaultPolicyFor('external-full'), undefined);
    assert.equal(defaultPolicyFor('lease-invalid'), undefined);
  });
});

describe('retry: withRetry 行为', () => {
  it('首次成功即返回，不产生退避', async () => {
    const r = await withRetry(async () => 'ok', policy, async () => {});
    assert.equal(r.value, 'ok');
    assert.equal(r.attempts, 1);
    assert.deepEqual(r.delaysMs, []);
  });

  it('可重试错误按次数重试后成功', async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw errors.connectTimeout();
        return 'recovered';
      },
      policy,
      async () => {},
    );
    assert.equal(r.value, 'recovered');
    assert.equal(r.attempts, 3);
    assert.deepEqual(r.delaysMs, [500, 1000]);
  });

  it('不可重试错误立即失败，不做无谓等待', async () => {
    let calls = 0;
    const delays: number[] = [];
    const r = await withRetry(
      async () => {
        calls += 1;
        throw errors.poolFull();
      },
      policy,
      async (ms) => {
        delays.push(ms);
      },
    );
    assert.equal(calls, 1, '不可重试分类不应重试');
    assert.equal(r.abortedAsNonRetryable, true);
    assert.deepEqual(delays, []);
    assert.equal(r.error?.errorClass, 'external-full');
  });

  it('lease-invalid 同样立即失败', async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls += 1;
        throw errors.leaseExpired();
      },
      policy,
      async () => {},
    );
    assert.equal(calls, 1);
    assert.equal(r.abortedAsNonRetryable, true);
    assert.equal(r.error?.errorCode, 'CONN-4002');
  });

  it('耗尽重试次数后返回最后一次错误', async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls += 1;
        throw errors.external5xx();
      },
      policy,
      async () => {},
    );
    assert.equal(calls, 3, '首次 + 2 次重试 = 3');
    assert.equal(r.attempts, 3);
    assert.equal(r.abortedAsNonRetryable, false);
    assert.equal(r.error?.errorClass, 'external-failure');
  });

  it('非 ServiceError 的裸异常归一为可重试的 external-failure', async () => {
    const r = await withRetry(
      async () => {
        throw new Error('socket hang up');
      },
      { maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 1 },
      async () => {},
    );
    assert.equal(r.error?.errorClass, 'external-failure');
  });

  it('maxAttempts=0 时只尝试一次', async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls += 1;
        throw errors.connectTimeout();
      },
      { maxAttempts: 0, baseDelayMs: 10, maxDelayMs: 10 },
      async () => {},
    );
    assert.equal(calls, 1);
    assert.deepEqual(r.delaysMs, []);
  });
});

describe('retry: 与 FakeClock 联动（测试不真实等待）', () => {
  it('clockSleep 推进假时钟而非真实等待', async () => {
    const clock = new FakeClock('2026-10-12T09:00:00+08:00');
    const sleep = clockSleep(clock);
    const start = clock.now();
    await sleep(1500);
    assert.equal(clock.now() - start, 1500);
    assert.deepEqual(clock.advances, [1500]);
  });

  it('超时重试场景可在毫秒内完成', async () => {
    const clock = new FakeClock('2026-10-12T09:00:00+08:00');
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw errors.readTimeout();
        return 'done';
      },
      policy,
      clockSleep(clock),
    );
    assert.equal(r.value, 'done');
    // 500 + 1000 = 1500ms 的退避被瞬时推进
    assert.equal(clock.now() - Date.parse('2026-10-12T09:00:00+08:00'), 1500);
  });
});

describe('retry: 释放动作例外（契约红线）', () => {
  it('释放失败即使不可重试，也必须保留错误供上层进入人工队列（不得静默吞掉）', async () => {
    // 契约：release 遇到不可重试分类，仍须进入"保持 releasing + 告警 + 人工队列"
    // 这里验证 withRetry 不会把错误吞掉，上层能拿到它
    const r = await withRetry(
      async () => {
        throw errors.releaseFailed({ leaseId: 'L-1' });
      },
      { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10 },
      async () => {},
    );
    assert.ok(r.error instanceof ServiceError);
    assert.equal(r.error.errorCode, 'CONN-5001');
  });
});
