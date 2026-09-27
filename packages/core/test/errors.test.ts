import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ServiceError,
  errors,
  isRetryable,
  defaultMessageOf,
  classifyExternalError,
  CONN,
  DEV,
  GEN,
  ERROR_CLASSIFICATION_ORDER,
  type ErrorClass,
} from '../src/index.js';

describe('errors: 四分类基本语义', () => {
  it('四类错误的重试性与白话提示必须各不相同且正确', () => {
    const expected: Record<ErrorClass, boolean> = {
      'connect-timeout': true,
      'external-full': false,
      'external-failure': true,
      'lease-invalid': false,
    };

    for (const [cls, retryable] of Object.entries(expected) as [ErrorClass, boolean][]) {
      assert.equal(isRetryable(cls), retryable, `${cls} 的可重试性应为 ${retryable}`);
      const msg = defaultMessageOf(cls);
      assert.ok(msg.length > 0, `${cls} 必须有白话提示`);
      // 白话提示不得出现技术术语
      assert.ok(!/error|exception|stack|undefined|null/i.test(msg), `${cls} 提示含技术术语：${msg}`);
    }
  });

  it('不可重试分类不应进入重试循环', () => {
    assert.equal(isRetryable('external-full'), false);
    assert.equal(isRetryable('lease-invalid'), false);
  });
});

describe('errors: 错误码表完整性', () => {
  it('连接器错误码格式统一为 CONN-<4位>', () => {
    for (const code of Object.values(CONN)) {
      assert.match(code, /^CONN-[0-9]{4}$/, `错误码格式不符：${code}`);
    }
  });

  it('设备上行错误码格式统一为 DEV-<4位>', () => {
    for (const code of Object.values(DEV)) {
      assert.match(code, /^DEV-[0-9]{4}$/, `错误码格式不符：${code}`);
    }
  });

  it('通用错误码格式统一为 GEN-<4位>', () => {
    for (const code of Object.values(GEN)) {
      assert.match(code, /^GEN-[0-9]{4}$/, `错误码格式不符：${code}`);
    }
  });

  it('CONN-4006 存在：租约类型缺失或非法必须可识别', () => {
    assert.equal(CONN.invalidLeaseKind, 'CONN-4006');
    const err = errors.invalidLeaseKind();
    assert.equal(err.errorCode, 'CONN-4006');
    assert.equal(err.errorClass, 'lease-invalid');
    // 不可重试：必须补齐后重新发起，不能靠重试自愈
    assert.equal(err.retryable, false);
  });
});

describe('errors: 响应结构', () => {
  it('toResponse 输出完整字段且不含未定义项', () => {
    const err = errors.poolFull({ pool: 'RP-SEAT-LAB01' });
    const res = err.toResponse('2026-10-12T09:15:01+08:00', 'req-1', 'trace-1');

    assert.equal(res.ok, false);
    assert.equal(res.requestId, 'req-1');
    assert.equal(res.traceId, 'trace-1');
    assert.equal(res.errorClass, 'external-full');
    assert.equal(res.errorCode, 'CONN-2001');
    assert.equal(res.retryable, false);
    assert.equal(res.serverTime, '2026-10-12T09:15:01+08:00');
    assert.ok(!Object.prototype.hasOwnProperty.call(res, 'retryAfterMs'));
  });

  it('retryAfterMs 存在时才输出（席位换人清理场景）', () => {
    const err = errors.seatInHandover({}, 60_000);
    const res = err.toResponse('2026-10-12T09:15:01+08:00', 'req-2');
    assert.equal(res.errorCode, 'CONN-2003');
    assert.equal(res.retryAfterMs, 60_000);
    // 同属 external-full：不可重试，但需按 retryAfterMs 另发申请
    assert.equal(res.errorClass, 'external-full');
    assert.equal(res.retryable, false);
  });

  it('details 透传但不得含敏感键（由 masking 二次防线保证）', () => {
    const err = errors.external5xx({ httpStatus: 503, externalSystem: 'seat-manager' });
    const res = err.toResponse('2026-10-12T09:15:01+08:00', 'req-3');
    assert.deepEqual(res.details, { httpStatus: 503, externalSystem: 'seat-manager' });
  });
});

describe('errors: 外部异常归一化', () => {
  it('超时类消息归为 connect-timeout', () => {
    const e = classifyExternalError(new Error('connect ETIMEDOUT 10.0.0.1:8080'));
    assert.equal(e.errorClass, 'connect-timeout');
  });

  it('连接被拒/域名解析失败归为 connect-timeout', () => {
    assert.equal(classifyExternalError(new Error('connect ECONNREFUSED')).errorClass, 'connect-timeout');
    assert.equal(classifyExternalError(new Error('getaddrinfo ENOTFOUND seat')).errorClass, 'connect-timeout');
  });

  it('容量已满归为 external-full', () => {
    const e = classifyExternalError(new Error('pool is full, no available seat'));
    assert.equal(e.errorClass, 'external-full');
  });

  it('未识别错误归为 external-failure（可重试，避免误锁资源）', () => {
    const e = classifyExternalError(new Error('something weird happened'));
    assert.equal(e.errorClass, 'external-failure');
    assert.equal(e.retryable, true);
  });

  it('已是 ServiceError 时原样返回', () => {
    const original = errors.leaseExpired();
    assert.equal(classifyExternalError(original), original);
  });
});

describe('errors: 判定顺序契约', () => {
  it('判定顺序为 租约 → 连接 → 解析 → 业务（避免把失效租约误报为超时）', () => {
    assert.deepEqual(
      [...ERROR_CLASSIFICATION_ORDER],
      ['lease-invalid', 'connect-timeout', 'external-failure', 'external-full'],
    );
  });

  it('lease-invalid 必须排在 connect-timeout 之前', () => {
    const leaseIdx = ERROR_CLASSIFICATION_ORDER.indexOf('lease-invalid');
    const timeoutIdx = ERROR_CLASSIFICATION_ORDER.indexOf('connect-timeout');
    assert.ok(leaseIdx < timeoutIdx, '失效租约若被误报为超时，平台会重试本不该执行的操作');
  });
});

describe('errors: ServiceError 基本行为', () => {
  it('保留 errorClass / errorCode / message', () => {
    const err = new ServiceError({ errorClass: 'external-failure', errorCode: 'TEST-0001', message: '测试' });
    assert.equal(err.errorClass, 'external-failure');
    assert.equal(err.errorCode, 'TEST-0001');
    assert.equal(err.message, '测试');
    assert.equal(err.name, 'ServiceError');
  });

  it('未提供 message 时使用分类默认白话提示', () => {
    const err = new ServiceError({ errorClass: 'lease-invalid', errorCode: 'TEST-0002' });
    assert.equal(err.message, defaultMessageOf('lease-invalid'));
  });
});
