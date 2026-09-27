/**
 * 脱敏与日志白名单。
 *
 * 依据：`contracts/error-codes.md` §5、说明书 §11.6 `PARAM-MASK-STUDENT`
 *
 * **两条硬约束**：
 * 1. 学号/身份证等必须脱敏为 `前 2 + **** + 后 2`
 * 2. 日志字段采用**白名单**写入，而不是"过滤黑名单"——后者一定会漏
 */

/** 学号脱敏：前 2 位 + **** + 后 2 位 */
export function maskStudentId(value: string): string {
  if (value.length <= 4) {
    // 过短无法保留前后各 2 位，整体掩码避免泄漏
    return '*'.repeat(value.length);
  }
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

/** 手机号脱敏：前 3 + **** + 后 2 */
export function maskPhone(value: string): string {
  if (value.length <= 5) return '*'.repeat(value.length);
  return `${value.slice(0, 3)}****${value.slice(-2)}`;
}

/** 邮箱脱敏：本地部分保留首字符 + *** */
export function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at <= 0) return '***';
  const local = value.slice(0, at);
  const domain = value.slice(at);
  if (local.length <= 1) return `***${domain}`;
  return `${local.slice(0, 1)}***${domain}`;
}

/**
 * 严禁出现在日志与错误响应中的敏感键。
 *
 * 仅用于**额外防线**；主防线是白名单（见 `LOG_FIELD_WHITELIST`）。
 */
export const FORBIDDEN_LOG_KEYS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'credential',
  'devicekey',
  'device_key',
  'connectionstring',
  'connection_string',
];

const FORBIDDEN_SET = new Set(FORBIDDEN_LOG_KEYS.map((k) => k.toLowerCase()));

/** 键名是否属于禁止记录项（忽略大小写、下划线与连字符） */
export function isForbiddenLogKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
  for (const forbidden of FORBIDDEN_SET) {
    if (normalized.includes(forbidden.replace(/[-_\s]/g, ''))) return true;
  }
  return false;
}

/**
 * 日志字段白名单。
 *
 * 依据 `error-codes.md` §5 的"白名单写入"原则：只允许这里列出的字段进入日志。
 * 新增日志字段必须显式加入本表——这是**有意为之的摩擦**，避免敏感数据被顺手记下。
 */
export const LOG_FIELD_WHITELIST: readonly string[] = [
  // 追踪
  'traceId',
  'requestId',
  'eventId',
  'serverTime',
  'observedAt',
  'time',
  // 业务标识
  'leaseId',
  'taskId',
  'resourcePoolId',
  'externalResourceId',
  'stationCode',
  'operatorId',
  'sourceId',
  'deviceId',
  'leaseKind',
  'eventType',
  // 结果
  'ok',
  'action',
  'state',
  'phase',
  'errorClass',
  'errorCode',
  'message',
  'retryable',
  'duplicated',
  'attempts',
  'delaysMs',
  'alive',
  'judged',
  'missedHeartbeats',
  'capacity',
  'inUse',
  'running',
  'released',
  'reusableAfterMs',
  'manualIntervention',
  'accepted',
  'reason',
  // 服务与网关（HTTP 接入层的排障字段）
  //
  // 这几个字段是 `packages/http-kit` 与统一网关的结构化日志需要的：
  // 没有它们，"哪个服务答的、转发到哪个上游、耗时多少"就无法从日志看出，
  // 排查跨服务问题只能靠猜。四者都是**固定清单里的标识或闭枚举**，不含用户数据。
  'service',
  'upstream',
  'httpStatus',
  'outcome',
  // HTTP 方法与状态码：闭枚举与数字，不含用户输入，可安全入日志
  'method',
  'status',
  // 路由模板（**不是**原始路径，见 gateway 的 `redactPath`）。
  // 原始路径可能内嵌学号（如 `/stats/v1/students/2021001`），故 `path` 不在白名单里，
  // 接入层只能记脱敏后的 `route`。
  'route',
  // 数值
  'durationMs',
  'drift',
  'driftRatio',
  'count',
];

const WHITELIST_SET = new Set(LOG_FIELD_WHITELIST);

/**
 * 按白名单筛选日志字段。
 *
 * 同时二次拦截禁止键（双保险）。未在白名单中的字段被丢弃。
 */
export function filterLogFields(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (!WHITELIST_SET.has(key)) continue;
    if (isForbiddenLogKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 构造可安全记录的错误摘要。
 *
 * 只取错误分类、错误码与脱敏后的技术细节，**不含堆栈与原始请求头**。
 */
export function safeErrorSummary(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const anyErr = error as Error & { errorClass?: string; errorCode?: string; details?: unknown };
    return {
      errorClass: anyErr.errorClass ?? 'unknown',
      errorCode: anyErr.errorCode ?? 'unknown',
      message: error.message,
    };
  }
  return { errorClass: 'unknown', errorCode: 'unknown', message: String(error) };
}
