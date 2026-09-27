import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock, IdempotencyStore, DEFAULT_IDEMPOTENCY_WINDOW_MS } from '../src/index.js';

function makeStore(clock: FakeClock, windowMs?: number, maxEntries?: number) {
  return new IdempotencyStore<{ value: number }>({
    clock,
    ...(windowMs !== undefined ? { windowMs } : {}),
    ...(maxEntries !== undefined ? { maxEntries } : {}),
  });
}

describe('idempotency: 基本语义', () => {
  it('首次 put 成功，重复 put 不覆盖', () => {
    const clock = new FakeClock();
    const store = makeStore(clock);

    assert.equal(store.put('req-1', { value: 100 }), true);
    assert.equal(store.put('req-1', { value: 999 }), false);
    assert.deepEqual(store.get('req-1'), { value: 100 });
  });

  it('未记录的 requestId 返回 undefined', () => {
    const clock = new FakeClock();
    const store = makeStore(clock);
    assert.equal(store.get('nope'), undefined);
    assert.equal(store.has('nope'), false);
  });
});

describe('idempotency: run 包装（写操作标准入口）', () => {
  it('首次执行副作用，重复请求返回首次结果', async () => {
    const clock = new FakeClock();
    const store = makeStore(clock);
    let calls = 0;

    const first = await store.run('req-A', async () => {
      calls += 1;
      return { value: calls };
    });
    assert.equal(first.duplicated, false);
    assert.deepEqual(first.result, { value: 1 });

    const second = await store.run('req-A', async () => {
      calls += 1;
      return { value: calls };
    });
    assert.equal(second.duplicated, true);
    assert.deepEqual(second.result, { value: 1 });
    assert.equal(calls, 1, '重复请求不得再执行副作用');
  });

  it('不同 requestId 各自执行', async () => {
    const clock = new FakeClock();
    const store = makeStore(clock);
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { value: calls };
    };

    await store.run('req-1', fn);
    await store.run('req-2', fn);
    assert.equal(calls, 2);
  });
});

describe('idempotency: 窗口过期', () => {
  it('窗口内重复请求命中首次结果', async () => {
    const clock = new FakeClock('2026-10-12T09:00:00+08:00');
    const store = makeStore(clock, 60_000);

    await store.run('req-1', async () => ({ value: 1 }));
    clock.advance(59_999);

    const again = await store.run('req-1', async () => ({ value: 2 }));
    assert.equal(again.duplicated, true);
    assert.deepEqual(again.result, { value: 1 });
  });

  it('超出窗口后可重新执行（旧条目失效）', async () => {
    const clock = new FakeClock('2026-10-12T09:00:00+08:00');
    const store = makeStore(clock, 60_000);

    await store.run('req-1', async () => ({ value: 1 }));
    clock.advance(60_000);

    const again = await store.run('req-1', async () => ({ value: 2 }));
    assert.equal(again.duplicated, false);
    assert.deepEqual(again.result, { value: 2 });
  });

  it('默认窗口为 24 小时', () => {
    assert.equal(DEFAULT_IDEMPOTENCY_WINDOW_MS, 24 * 60 * 60 * 1000);
  });

  it('过期条目在 size() 时被清理', async () => {
    const clock = new FakeClock();
    const store = makeStore(clock, 1000);

    await store.run('req-1', async () => ({ value: 1 }));
    assert.equal(store.size(), 1);
    clock.advance(1000);
    assert.equal(store.size(), 0);
  });
});

describe('idempotency: 容量上限', () => {
  it('超出 maxEntries 时淘汰最旧，且不破坏最近的条目', async () => {
    const clock = new FakeClock();
    const store = makeStore(clock, 24 * 60 * 60 * 1000, 2);

    await store.run('req-1', async () => ({ value: 1 }));
    clock.advance(10);
    await store.run('req-2', async () => ({ value: 2 }));
    clock.advance(10);
    await store.run('req-3', async () => ({ value: 3 }));

    assert.equal(store.get('req-1'), undefined, '最旧条目应被淘汰');
    assert.deepEqual(store.get('req-2'), { value: 2 });
    assert.deepEqual(store.get('req-3'), { value: 3 });
  });
});

describe('idempotency: clear', () => {
  it('清空后全部失效', async () => {
    const clock = new FakeClock();
    const store = makeStore(clock);
    await store.run('req-1', async () => ({ value: 1 }));
    assert.equal(store.size(), 1);
    store.clear();
    assert.equal(store.size(), 0);
    assert.equal(store.get('req-1'), undefined);
  });
});
