/**
 * @peripheral/core —— 外围服务共享基座。
 *
 * 8 条并行泳道的共同语言：错误分类、幂等、时钟、事件信封、编码校验、
 * 参数基线、重试策略、脱敏与日志白名单。
 *
 * **并行纪律**：任何被两条以上泳道需要的代码，一律上提到本包。
 */

export * from './clock.js';
export * from './coding.js';
export * from './errors.js';
export * from './idempotency.js';
export * from './envelope.js';
export * from './params.js';
export * from './local-params.js';
export * from './retry.js';
export * from './masking.js';
