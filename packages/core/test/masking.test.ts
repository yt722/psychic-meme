import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  maskStudentId,
  maskPhone,
  maskEmail,
  isForbiddenLogKey,
  filterLogFields,
  safeErrorSummary,
  LOG_FIELD_WHITELIST,
  FORBIDDEN_LOG_KEYS,
} from '../src/index.js';
import { errors } from '../src/index.js';

describe('masking: 学号脱敏（PARAM-MASK-STUDENT）', () => {
  it('前 2 + **** + 后 2', () => {
    assert.equal(maskStudentId('20230101001'), '20****01');
    assert.equal(maskStudentId('12345678'), '12****78');
  });

  it('超短学号整体掩码，避免泄漏', () => {
    assert.equal(maskStudentId('1234'), '****');
    assert.equal(maskStudentId('12'), '**');
    assert.equal(maskStudentId(''), '');
  });
});

describe('masking: 手机号与邮箱', () => {
  it('手机号前 3 + **** + 后 2', () => {
    assert.equal(maskPhone('13812345678'), '138****78');
  });

  it('短号码整体掩码', () => {
    assert.equal(maskPhone('12345'), '*****');
  });

  it('邮箱保留首字符与域名', () => {
    assert.equal(maskEmail('zhangsan@example.com'), 'z***@example.com');
  });

  it('非法邮箱返回全掩码', () => {
    assert.equal(maskEmail('no-at-sign'), '***');
    assert.equal(maskEmail('@example.com'), '***');
  });
});

describe('masking: 禁止记录键', () => {
  it('识别常见敏感键（含大小写与下划线变体）', () => {
    for (const key of ['password', 'Password', 'SECRET', 'token', 'apiKey', 'api_key', 'privateKey', 'deviceKey']) {
      assert.equal(isForbiddenLogKey(key), true, `${key} 应被识别为敏感键`);
    }
  });

  it('普通键不被误判', () => {
    for (const key of ['leaseId', 'taskId', 'stationCode', 'errorClass']) {
      assert.equal(isForbiddenLogKey(key), false, `${key} 不应被误判`);
    }
  });

  it('禁止键清单非空且全部小写规范', () => {
    assert.ok(FORBIDDEN_LOG_KEYS.length > 0);
    for (const k of FORBIDDEN_LOG_KEYS) {
      assert.equal(k, k.toLowerCase());
    }
  });
});

describe('masking: 日志白名单（主防线）', () => {
  it('只保留白名单字段', () => {
    const filtered = filterLogFields({
      leaseId: 'L-1',
      errorClass: 'external-full',
      traceId: 'trace-1',
      // 以下不在白名单
      rawRequestBody: 'huge blob',
      internalStack: 'at foo()',
    });

    assert.deepEqual(filtered, { leaseId: 'L-1', errorClass: 'external-full', traceId: 'trace-1' });
  });

  it('白名单外字段一律丢弃（不是黑名单过滤）', () => {
    const filtered = filterLogFields({ somethingUnknown: 'x' });
    assert.deepEqual(filtered, {});
  });

  it('禁止键即使误入白名单也被二次拦截', () => {
    // 双保险：假设有人不慎把 sensitive 键加入白名单，仍需拦截
    const filtered = filterLogFields({ token: 'abc', leaseId: 'L-1' });
    assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'token'), false);
    assert.equal(filtered['leaseId'], 'L-1');
  });

  it('白名单包含关键排障字段', () => {
    for (const key of ['traceId', 'requestId', 'leaseId', 'errorClass', 'errorCode', 'serverTime', 'stationCode']) {
      assert.ok(LOG_FIELD_WHITELIST.includes(key), `白名单缺少关键字段 ${key}`);
    }
  });

  it('白名单包含 HTTP 接入层的服务定位字段', () => {
    /*
     * 这四项曾缺失，导致 `http-kit` 与网关写进日志的 `service` 被静默丢弃，
     * 实际后果是"哪个服务答的"无法从日志看出——排查跨服务问题时只能靠猜。
     * 它们都是**固定清单里的标识或数字**，不含用户输入，故可放行。
     */
    for (const key of ['service', 'upstream', 'httpStatus', 'outcome']) {
      assert.ok(LOG_FIELD_WHITELIST.includes(key), `白名单缺少接入层字段 ${key}`);
    }
  });

  it('白名单刻意不含原始请求路径（路径可能内嵌学号等身份）', () => {
    /*
     * 这条是**反向断言**：不 whitelist `path`/`method`。
     * 像 `/stats/v1/students/2021001` 这样的路径把学号带在 URL 里，
     * 一旦 `path` 进白名单，学号就会随日志落盘。接入层应记 `action`（方法+路由模板）
     * 而不是原始路径。把这条写成测试，避免以后有人"顺手补全"。
     */
    for (const key of ['path', 'pathname', 'url']) {
      assert.equal(LOG_FIELD_WHITELIST.includes(key), false, `白名单不应包含原始路径字段 ${key}`);
    }
  });

  it('白名单中不含任何禁止键', () => {
    for (const key of LOG_FIELD_WHITELIST) {
      assert.equal(isForbiddenLogKey(key), false, `白名单不应包含敏感键 ${key}`);
    }
  });
});

describe('masking: 安全错误摘要', () => {
  it('只取分类、码、消息，不含堆栈', () => {
    const err = errors.leaseExpired({ leaseId: 'L-1' });
    const summary = safeErrorSummary(err);
    assert.equal(summary['errorClass'], 'lease-invalid');
    assert.equal(summary['errorCode'], 'CONN-4002');
    assert.equal(Object.prototype.hasOwnProperty.call(summary, 'stack'), false);
  });

  it('对普通 Error 也能安全摘要', () => {
    const summary = safeErrorSummary(new Error('boom'));
    assert.equal(summary['errorClass'], 'unknown');
    assert.equal(summary['message'], 'boom');
  });

  it('对非 Error 值也能处理', () => {
    const summary = safeErrorSummary('string error');
    assert.equal(summary['message'], 'string error');
  });
});
