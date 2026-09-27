/**
 * 参数基线注入。
 *
 * 依据：说明书 §11（参数基线是全部数值的唯一出处）、`peripheral/README.md` 铁律 1
 *
 * **铁律：所有数值走配置，代码中禁止硬编码 `PARAM-*` 的数值。**
 * 正文只引用参数编号，参数变更只改本节与配置文件。
 */

/* --------------------------------------------------------- 参数编号常量 */

export const PARAM = {
  /* 连接器 §11.2 */
  CONNECTOR_TIMEOUT: 'PARAM-CONNECTOR-TIMEOUT',
  CONNECTOR_RETRY: 'PARAM-CONNECTOR-RETRY',
  CONNECTOR_POLL: 'PARAM-CONNECTOR-POLL',

  /* 调度 §11.1 */
  SEAT_HOLD: 'PARAM-SEAT-HOLD',
  HEARTBEAT: 'PARAM-HEARTBEAT',
  DEAD_CYCLES: 'PARAM-DEAD-CYCLES',
  TTL_GRACE: 'PARAM-TTL-GRACE',
  TTL_WARN: 'PARAM-TTL-WARN',
  RENEW_MAX: 'PARAM-RENEW-MAX',
  QUEUE_HINT: 'PARAM-QUEUE-HINT',
  QUEUE_SUSPEND: 'PARAM-QUEUE-SUSPEND',
  RESTORE_DAYS: 'PARAM-RESTORE-DAYS',
  RECLAIM_BATCH: 'PARAM-RECLAIM-BATCH',
  RECLAIM_GAP: 'PARAM-RECLAIM-GAP',
  RELEASE_RETRY: 'PARAM-RELEASE-RETRY',
  CLASS_ALLOC: 'PARAM-CLASS-ALLOC',
  CLASS_RELEASE: 'PARAM-CLASS-RELEASE',
  GROUP_MAX: 'PARAM-GROUP-MAX',
  SEAT_HANDOVER: 'PARAM-SEAT-HANDOVER',
  MASS_OFFLINE_GRACE: 'PARAM-MASS-OFFLINE-GRACE',
  MASS_OFFLINE_TRIGGER: 'PARAM-MASS-OFFLINE-TRIGGER',
  NO_OVERSELL: 'PARAM-NO-OVERSELL',
  VU_LICENSE: 'PARAM-VU-LICENSE',
  SERVER_INSTANCE_MAX: 'PARAM-SERVER-INSTANCE-MAX',
  MAINT_NOTICE: 'PARAM-MAINT-NOTICE',

  /* 地图 §11.3 */
  OFFLINE_JUDGE: 'PARAM-OFFLINE-JUDGE',
  ONLINE_JUDGE: 'PARAM-ONLINE-JUDGE',
  MAP_FALLBACK: 'PARAM-MAP-FALLBACK',
  MAP_BROADCAST: 'PARAM-MAP-BROADCAST',
  MAP_RECONCILE: 'PARAM-MAP-RECONCILE',

  /* 报警与 AI §11.4 */
  ALARM_MERGE: 'PARAM-ALARM-MERGE',
  ALARM_STORM: 'PARAM-ALARM-STORM',
  AI_TIMEOUT: 'PARAM-AI-TIMEOUT',
  AI_CONCURRENCY: 'PARAM-AI-CONCURRENCY',
  AI_BREAK: 'PARAM-AI-BREAK',

  /* 消息 §11.5 */
  MSG_KEEP: 'PARAM-MSG-KEEP',
  MSG_FANOUT: 'PARAM-MSG-FANOUT',
  MSG_RETRY: 'PARAM-MSG-RETRY',
  MSG_UNREAD: 'PARAM-MSG-UNREAD',
  RECONNECT_RESTORE: 'PARAM-RECONNECT-RESTORE',

  /* 学习与数据 §11.6 */
  EVENT_BATCH: 'PARAM-EVENT-BATCH',
  EVENT_BUFFER_TIME: 'PARAM-EVENT-BUFFER-TIME',
  EVENT_DEDUP: 'PARAM-EVENT-DEDUP',
  DASHBOARD_P95: 'PARAM-DASHBOARD-P95',
  AUDIT_KEEP: 'PARAM-AUDIT-KEEP',
  SCHEDLOG_KEEP: 'PARAM-SCHEDLOG-KEEP',
  LEARN_KEEP: 'PARAM-LEARN-KEEP',
  MASK_STUDENT: 'PARAM-MASK-STUDENT',

  /* 客户端与升级 §11.7 */
  UPDATE_NOTICE: 'PARAM-UPDATE-NOTICE',
  LTI_CLOCK_SKEW: 'PARAM-LTI-CLOCK-SKEW',

  /* 性能与限流 §11.8 */
  FIRSTPAINT: 'PARAM-FIRSTPAINT',
  APPLY_P95: 'PARAM-APPLY-P95',
  GATEWAY_P95: 'PARAM-GATEWAY-P95',
  ONLINE_DEF: 'PARAM-ONLINE-DEF',
  API_QPS: 'PARAM-API-QPS',
  API_ERR: 'PARAM-API-ERR',
  RATE_BURST: 'PARAM-RATE-BURST',
  RATE_SUSTAIN: 'PARAM-RATE-SUSTAIN',
  RATE_GLOBAL: 'PARAM-RATE-GLOBAL',

  /* 运维 §11.9 */
  MAINT_RESPONSE: 'PARAM-MAINT-RESPONSE',
  MAINT_FIX: 'PARAM-MAINT-FIX',
  P1_NOTIFY: 'PARAM-P1-NOTIFY',
  P2_NOTIFY: 'PARAM-P2-NOTIFY',
  BATCH_WINDOW: 'PARAM-BATCH-WINDOW',
  TEACHING_HOURS: 'PARAM-TEACHING-HOURS',
  REAL_CELL_PARALLEL: 'PARAM-REAL-CELL-PARALLEL',
} as const;

export type ParamId = (typeof PARAM)[keyof typeof PARAM];

/* ------------------------------------------------------------ 默认基线值 */

const MS = 1;
const SEC = 1000 * MS;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * 说明书 §11 的默认值（数值型统一转毫秒，便于计算）。
 *
 * 非数值型参数（如 `PARAM-MASK-STUDENT`、`PARAM-BATCH-WINDOW`）保持原值。
 * `PARAM-SERVER-INSTANCE-MAX` 说明书标注"按服务器资源评估，实施时确定"，
 * 此处用 `undefined` 表示**必须由部署配置提供**，不做兜底猜测。
 */
export const DEFAULT_PARAMS: Readonly<Record<ParamId, number | string | undefined>> = {
  /* 连接器 */
  [PARAM.CONNECTOR_TIMEOUT]: 5 * SEC,
  [PARAM.CONNECTOR_RETRY]: 2,
  [PARAM.CONNECTOR_POLL]: 5 * MIN,

  /* 调度 */
  [PARAM.SEAT_HOLD]: 15 * MIN,
  [PARAM.HEARTBEAT]: 30 * SEC,
  [PARAM.DEAD_CYCLES]: 2,
  [PARAM.TTL_GRACE]: 10 * MIN,
  [PARAM.TTL_WARN]: '60s/30s/5s',
  [PARAM.RENEW_MAX]: 3,
  [PARAM.QUEUE_HINT]: 10,
  [PARAM.QUEUE_SUSPEND]: 15 * MIN,
  [PARAM.RESTORE_DAYS]: 30,
  [PARAM.RECLAIM_BATCH]: 50,
  [PARAM.RECLAIM_GAP]: 5 * SEC,
  [PARAM.RELEASE_RETRY]: 2,
  [PARAM.CLASS_ALLOC]: 30 * SEC,
  [PARAM.CLASS_RELEASE]: 60 * SEC,
  [PARAM.GROUP_MAX]: 2,
  [PARAM.SEAT_HANDOVER]: 60 * SEC,
  [PARAM.MASS_OFFLINE_GRACE]: 5 * MIN,
  [PARAM.MASS_OFFLINE_TRIGGER]: 0.3,
  [PARAM.NO_OVERSELL]: 'allocated <= capacity',
  [PARAM.VU_LICENSE]: 30,
  [PARAM.SERVER_INSTANCE_MAX]: undefined,
  [PARAM.MAINT_NOTICE]: 48 * HOUR,

  /* 地图 */
  [PARAM.OFFLINE_JUDGE]: 2 * MIN,
  [PARAM.ONLINE_JUDGE]: 1 * MIN,
  [PARAM.MAP_FALLBACK]: 6 * SEC,
  [PARAM.MAP_BROADCAST]: 1,
  [PARAM.MAP_RECONCILE]: 5 * MIN,

  /* 报警与 AI */
  [PARAM.ALARM_MERGE]: 5 * MIN,
  [PARAM.ALARM_STORM]: 60 * SEC,
  [PARAM.AI_TIMEOUT]: 2 * SEC,
  [PARAM.AI_CONCURRENCY]: 20,
  [PARAM.AI_BREAK]: 3,

  /* 消息 */
  [PARAM.MSG_KEEP]: 36,
  [PARAM.MSG_FANOUT]: 5 * SEC,
  [PARAM.MSG_RETRY]: 3,
  [PARAM.MSG_UNREAD]: 24 * HOUR,
  [PARAM.RECONNECT_RESTORE]: 10 * SEC,

  /* 学习与数据 */
  [PARAM.EVENT_BATCH]: 100,
  [PARAM.EVENT_BUFFER_TIME]: 500 * MS,
  [PARAM.EVENT_DEDUP]: 24 * HOUR,
  [PARAM.DASHBOARD_P95]: 2 * SEC,
  [PARAM.AUDIT_KEEP]: 36,
  [PARAM.SCHEDLOG_KEEP]: 12,
  [PARAM.LEARN_KEEP]: '毕业后 3 年',
  [PARAM.MASK_STUDENT]: '前 2 + **** + 后 2',

  /* 客户端与升级 */
  [PARAM.UPDATE_NOTICE]: 48 * HOUR,
  [PARAM.LTI_CLOCK_SKEW]: 5 * MIN,

  /* 性能与限流 */
  [PARAM.FIRSTPAINT]: 2 * SEC,
  [PARAM.APPLY_P95]: 1 * SEC,
  [PARAM.GATEWAY_P95]: 500 * MS,
  [PARAM.ONLINE_DEF]: '有效会话 + 活跃心跳 + 15 分钟内一次业务请求',
  [PARAM.API_QPS]: 1000,
  [PARAM.API_ERR]: 0.001,
  [PARAM.RATE_BURST]: 100,
  [PARAM.RATE_SUSTAIN]: 50,
  [PARAM.RATE_GLOBAL]: 1200,

  /* 运维 */
  [PARAM.MAINT_RESPONSE]: 1 * HOUR,
  [PARAM.MAINT_FIX]: 24 * HOUR,
  [PARAM.P1_NOTIFY]: 15 * MIN,
  [PARAM.P2_NOTIFY]: 2 * HOUR,
  [PARAM.BATCH_WINDOW]: '22:00-06:00',
  [PARAM.TEACHING_HOURS]: '工作日 8:00-18:00',
  [PARAM.REAL_CELL_PARALLEL]: 2,
};

/* --------------------------------------------------------------- 参数容器 */

export type ParamOverrides = Partial<Record<ParamId, number | string>>;

/**
 * 参数容器：以默认基线为底，叠加部署配置。
 *
 * 服务启动时必须通过构造参数注入，禁止在业务代码里直接读常量。
 */
export class ParamRegistry {
  readonly #values: Map<ParamId, number | string | undefined>;

  constructor(overrides: ParamOverrides = {}) {
    this.#values = new Map(Object.entries(DEFAULT_PARAMS) as [ParamId, number | string | undefined][]);
    for (const [key, value] of Object.entries(overrides)) {
      this.#values.set(key as ParamId, value);
    }
  }

  /** 取数值型参数；非数值或缺失时抛错（不静默兜底） */
  number(id: ParamId): number {
    const value = this.#values.get(id);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`ParamRegistry: 参数 ${id} 未配置为有效数值（当前 ${String(value)}）`);
    }
    return value;
  }

  /** 取数值型参数，缺失时用调用方提供的兜底（仅用于可选参数） */
  numberOr(id: ParamId, fallback: number): number {
    const value = this.#values.get(id);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  /** 取字符串型参数 */
  string(id: ParamId): string {
    const value = this.#values.get(id);
    if (typeof value !== 'string') {
      throw new Error(`ParamRegistry: 参数 ${id} 未配置为字符串（当前 ${String(value)}）`);
    }
    return value;
  }

  /** 是否已配置（用于检出"必须由部署提供"的参数） */
  has(id: ParamId): boolean {
    return this.#values.get(id) !== undefined;
  }

  /** 原始读取（可能 undefined），供诊断输出 */
  raw(id: ParamId): number | string | undefined {
    return this.#values.get(id);
  }

  /** 导出全部配置（脱敏后的诊断用） */
  snapshot(): Record<string, number | string | undefined> {
    return Object.fromEntries(this.#values);
  }
}

/**
 * 校验"必须由部署提供"的参数已配置。
 *
 * `PARAM-SERVER-INSTANCE-MAX` 说明书未给默认值，缺失时必须在启动期暴露，
 * 而不是运行时兜底成某个数字。
 */
export function assertRequiredParams(registry: ParamRegistry, ids: readonly ParamId[]): void {
  const missing = ids.filter((id) => !registry.has(id));
  if (missing.length > 0) {
    throw new Error(`以下参数必须由部署配置提供，当前缺失：${missing.join('、')}`);
  }
}
