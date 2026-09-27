/**
 * 统一错误模型：四分类 + 错误码表 + 重试策略。
 *
 * 依据：`contracts/error-codes.md` §3、§3.1、§3.2、§4
 *
 * 两条原则：
 * 1. 错误必须"可分类"——调用方能凭 `errorClass` 做分支（重试/换资源/提示/告警）
 * 2. 错误必须"说人话"——`message` 给师生看，技术细节走 `traceId` 与日志
 */

/** 四类错误（连接器与设备上行共用同一分类体系） */
export type ErrorClass =
  | 'connect-timeout' // 可重试
  | 'external-full' // 不可重试
  | 'external-failure' // 可重试
  | 'lease-invalid'; // 不可重试

const RETRYABLE: Readonly<Record<ErrorClass, boolean>> = {
  'connect-timeout': true,
  'external-full': false,
  'external-failure': true,
  'lease-invalid': false,
};

/** 面向师生的白话提示（不得写成技术术语） */
const DEFAULT_MESSAGE: Readonly<Record<ErrorClass, string>> = {
  'connect-timeout': '暂时联系不上该实训室，正在重试，请稍候。',
  'external-full': '该实训室机位已满，已为你排队，可查看前方等待人数。',
  'external-failure': '该实训室设备暂时异常，正在重试。',
  'lease-invalid': '本次占用已失效，请重新申请。',
};

export function isRetryable(errorClass: ErrorClass): boolean {
  return RETRYABLE[errorClass];
}

export function defaultMessageOf(errorClass: ErrorClass): string {
  return DEFAULT_MESSAGE[errorClass];
}

/** 统一错误响应结构（`error-codes.md` §2） */
export interface ErrorResponse {
  ok: false;
  requestId: string;
  traceId?: string;
  errorClass: ErrorClass;
  errorCode: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  serverTime: string;
  details?: Record<string, unknown>;
}

export interface ServiceErrorInit {
  errorClass: ErrorClass;
  errorCode: string;
  message?: string;
  details?: Record<string, unknown>;
  retryAfterMs?: number;
}

/**
 * 服务错误基类。
 *
 * `details` 中**严禁**出现设备密钥、临时口令、服务令牌、数据库连接串、证书私钥，
 * 以及未脱敏的学号/身份证/手机号。
 */
export class ServiceError extends Error {
  readonly errorClass: ErrorClass;
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(init: ServiceErrorInit) {
    super(init.message ?? DEFAULT_MESSAGE[init.errorClass]);
    this.name = 'ServiceError';
    this.errorClass = init.errorClass;
    this.errorCode = init.errorCode;
    this.retryable = RETRYABLE[init.errorClass];
    this.details = init.details;
    this.retryAfterMs = init.retryAfterMs;
  }

  /** 转成对外错误响应；可选字段仅在存在时输出 */
  toResponse(serverTime: string, requestId: string, traceId?: string): ErrorResponse {
    return {
      ok: false,
      requestId,
      errorClass: this.errorClass,
      errorCode: this.errorCode,
      message: this.message,
      retryable: this.retryable,
      serverTime,
      ...(traceId !== undefined ? { traceId } : {}),
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

/* ------------------------------------------------------------- 错误码表 §4 */

/** 连接器错误码（S03） */
export const CONN = {
  connectTimeout: 'CONN-1001',
  readTimeout: 'CONN-1002',
  poolFull: 'CONN-2001',
  seatTaken: 'CONN-2002',
  seatInHandover: 'CONN-2003',
  external5xx: 'CONN-3001',
  unparsable: 'CONN-3002',
  externalBusiness: 'CONN-3003',
  leaseNotFound: 'CONN-4001',
  leaseExpired: 'CONN-4002',
  leaseReleased: 'CONN-4003',
  leaseMismatch: 'CONN-4004',
  seatNotFound: 'CONN-4005',
  invalidLeaseKind: 'CONN-4006',
  releaseFailed: 'CONN-5001',
} as const;

/** 设备上行错误码（S05） */
export const DEV = {
  badStationCode: 'DEV-1001',
  sourceNotAllowed: 'DEV-1002',
  observedAtOutOfWindow: 'DEV-1003',
  eventIdMissing: 'DEV-1004',
  duplicateEvent: 'DEV-2001',
} as const;

/** 通用错误码 */
export const GEN = {
  badRequest: 'GEN-1001',
  authFailed: 'GEN-1002',
  forbidden: 'GEN-1003',
  internal: 'GEN-1099',
} as const;

/* --------------------------------------------------------------- 错误工厂 */

function mk(
  errorClass: ErrorClass,
  errorCode: string,
  message?: string,
  details?: Record<string, unknown>,
  retryAfterMs?: number,
): ServiceError {
  return new ServiceError({
    errorClass,
    errorCode,
    ...(message !== undefined ? { message } : {}),
    ...(details !== undefined ? { details } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

export const errors = {
  /* 连接器 */
  connectTimeout: (d?: Record<string, unknown>) => mk('connect-timeout', CONN.connectTimeout, undefined, d),
  readTimeout: (d?: Record<string, unknown>) => mk('connect-timeout', CONN.readTimeout, undefined, d),
  poolFull: (d?: Record<string, unknown>) => mk('external-full', CONN.poolFull, undefined, d),
  seatTaken: (d?: Record<string, unknown>) => mk('external-full', CONN.seatTaken, undefined, d),
  seatInHandover: (d?: Record<string, unknown>, retryAfterMs?: number) =>
    mk('external-full', CONN.seatInHandover, undefined, d, retryAfterMs),
  external5xx: (d?: Record<string, unknown>) => mk('external-failure', CONN.external5xx, undefined, d),
  unparsable: (d?: Record<string, unknown>) => mk('external-failure', CONN.unparsable, undefined, d),
  externalBusiness: (d?: Record<string, unknown>) => mk('external-failure', CONN.externalBusiness, undefined, d),
  leaseNotFound: (d?: Record<string, unknown>) => mk('lease-invalid', CONN.leaseNotFound, undefined, d),
  leaseExpired: (d?: Record<string, unknown>) => mk('lease-invalid', CONN.leaseExpired, undefined, d),
  leaseReleased: (d?: Record<string, unknown>) => mk('lease-invalid', CONN.leaseReleased, undefined, d),
  leaseMismatch: (d?: Record<string, unknown>) => mk('lease-invalid', CONN.leaseMismatch, undefined, d),
  seatNotFound: (d?: Record<string, unknown>) => mk('lease-invalid', CONN.seatNotFound, undefined, d),
  releaseFailed: (d?: Record<string, unknown>) => mk('external-failure', CONN.releaseFailed, undefined, d),

  /**
   * 租约类型缺失或非法。
   *
   * 归入 `lease-invalid`：请求无法安全执行，平台必须补齐后重发。
   * **绝不默认兜底成某个类型**——兜底要么让线上租约被误判死（违反 A-03c），
   * 要么让线下租约永不回收（资源泄漏）。
   */
  invalidLeaseKind: (d?: Record<string, unknown>) =>
    mk(
      'lease-invalid',
      CONN.invalidLeaseKind,
      '租约类型缺失或非法，无法确定心跳判死是否适用，请补齐 leaseKind 后重新申请。',
      d,
    ),

  /* 设备上行 */
  badStationCode: (d?: Record<string, unknown>) =>
    mk('lease-invalid', DEV.badStationCode, '工位编码不符合规范，上报已被拒绝。', d),
  sourceNotAllowed: (d?: Record<string, unknown>) =>
    mk('lease-invalid', DEV.sourceNotAllowed, '该来源无权上报此工位，已拒绝并告警。', d),
  observedAtOutOfWindow: (d?: Record<string, unknown>) =>
    mk('lease-invalid', DEV.observedAtOutOfWindow, '上报时间超出合理时间窗，已拒绝。', d),
  eventIdMissing: (d?: Record<string, unknown>) =>
    mk('lease-invalid', DEV.eventIdMissing, '缺少事件编号，已拒绝。', d),

  /* 通用 */
  badRequest: (d?: Record<string, unknown>) =>
    mk('lease-invalid', GEN.badRequest, '请求不符合接口约定，请检查必填字段。', d),
  authFailed: (d?: Record<string, unknown>) => mk('lease-invalid', GEN.authFailed, '认证失败，请重新登录。', d),
  forbidden: (d?: Record<string, unknown>) => mk('lease-invalid', GEN.forbidden, '你没有执行该操作的权限。', d),
  internal: (d?: Record<string, unknown>) => mk('external-failure', GEN.internal, '系统内部错误，请稍后重试。', d),
} as const;

/**
 * 把外部系统的裸异常归一化为四分类之一。
 *
 * 未识别错误一律归入 `external-failure`（可重试），
 * 避免把可恢复问题误判为不可重试而导致资源误锁。
 */
export function classifyExternalError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;

  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();

  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
    return errors.readTimeout({ raw });
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('ehostunreach') ||
    lower.includes('econnreset')
  ) {
    return errors.connectTimeout({ raw });
  }
  if (lower.includes('full') || lower.includes('no available') || lower.includes('capacity')) {
    return errors.poolFull({ raw });
  }

  return errors.externalBusiness({ raw });
}

/**
 * 错误判定顺序（`error-codes.md` §3.1，实现必须按此顺序，避免误分类）。
 *
 * ```
 * 1. 本地租约校验        → 失败即 lease-invalid（不发外部调用，省一次往返）
 * 2. 建立连接 / 读响应   → 超时即 connect-timeout
 * 3. 解析响应结构        → 无法解析即 external-failure
 * 4. 解析业务结果        → "已满" 即 external-full；其他业务错误即 external-failure
 * 5. 成功
 * ```
 *
 * 若先发外部调用再校验本地租约，已失效租约会误报成 `connect-timeout`，
 * 平台便去重试一个**根本不该执行**的操作。
 */
export const ERROR_CLASSIFICATION_ORDER = [
  'lease-invalid',
  'connect-timeout',
  'external-failure',
  'external-full',
] as const;
