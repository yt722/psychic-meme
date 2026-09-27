/**
 * S01 看板参数注入。
 *
 * 铁律（`peripheral/README.md` 铁律 1、说明书 §11）：
 * **代码中禁止硬编码业务数值**。本文件是 S01 全部可调数值的唯一声明处。
 *
 * 分两层：
 * - **契约已定义的参数**走 core `ParamRegistry`（键类型被冻结为说明书 §11 的 `ParamId`）：
 *   `PARAM-MAP-FALLBACK`（6s 兜底轮询）、`PARAM-MAP-BROADCAST`（1Hz 广播）、
 *   `PARAM-RECONNECT-RESTORE`（10s 重连恢复窗口）、`PARAM-MAP-RECONCILE`（5min 对账）、
 *   `PARAM-OFFLINE-JUDGE`（判离线）、`PARAM-ONLINE-JUDGE`（判在线）。
 * - **本包专有参数**走 core `LocalParams`，编号一律 `PARAM-BOARD-*`。
 *
 * 业务代码只通过 {@link BoardParams} 取数，不直接读 `DEFAULT_PARAMS`。
 */

import { LocalParams, PARAM, ParamRegistry } from '@peripheral/core';
import type { ParamId, ParamOverrides, LocalParamOverrides } from '@peripheral/core';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/* ------------------------------------------------------- 本包专有参数编号表 */

export const BOARD_PARAM = {
  /** 历史状态保留窗口（毫秒） */
  HISTORY_KEEP: 'PARAM-BOARD-HISTORY-KEEP',
  /** 历史状态内存条数上限（超限丢最旧） */
  HISTORY_MAX_ENTRIES: 'PARAM-BOARD-HISTORY-MAX-ENTRIES',
  /** 历史查询默认条数（未传 limit 时） */
  HISTORY_DEFAULT_LIMIT: 'PARAM-BOARD-HISTORY-DEFAULT-LIMIT',
  /** 历史查询单次最大条数（传超即拒，避免拖垮看板） */
  HISTORY_MAX_LIMIT: 'PARAM-BOARD-HISTORY-MAX-LIMIT',
  /** 断线期间缓冲的变更条数上限（超限丢最旧并计数） */
  RECONNECT_BACKLOG_MAX: 'PARAM-BOARD-RECONNECT-BACKLOG-MAX',
  /** 关键词筛选的最大长度（超长直接拒，避免正则/扫描放大） */
  KEYWORD_MAX_LENGTH: 'PARAM-BOARD-KEYWORD-MAX-LENGTH',
  /** 工位详情里占用人员的展示上限（超出截断，避免一个工位把响应撑大） */
  DETAIL_MAX_OCCUPANTS: 'PARAM-BOARD-DETAIL-MAX-OCCUPANTS',
  /** SSE 重连退避提示（`retry:` 行，毫秒） */
  EVENT_STREAM_RETRY_MS: 'PARAM-BOARD-EVENT-STREAM-RETRY',
  /** SSE 空闲保活周期（毫秒）：超过即发 `: keepalive` 注释行 */
  EVENT_STREAM_KEEPALIVE_MS: 'PARAM-BOARD-EVENT-STREAM-KEEPALIVE',
  /** SSE 续传环形缓冲帧数上限（`Last-Event-ID` 补发窗口） */
  EVENT_STREAM_REPLAY_MAX: 'PARAM-BOARD-EVENT-STREAM-REPLAY-MAX',
  /** 单连接待下发变更的工位数上限（慢客户端只留最新，超出丢最旧并计数） */
  EVENT_STREAM_COALESCE_MAX: 'PARAM-BOARD-EVENT-STREAM-COALESCE-MAX',
  /** SSE 并发连接上限（超出即拒，保护看板本身） */
  EVENT_STREAM_MAX_CONNECTIONS: 'PARAM-BOARD-EVENT-STREAM-MAX-CONNECTIONS',
  /** 来源标签：真机 */
  SOURCE_LABEL_REAL: 'PARAM-BOARD-SOURCE-LABEL-REAL',
  /** 来源标签：数字孪生 */
  SOURCE_LABEL_TWIN: 'PARAM-BOARD-SOURCE-LABEL-TWIN',
  /** 来源标签：工业网关 */
  SOURCE_LABEL_GATEWAY: 'PARAM-BOARD-SOURCE-LABEL-GATEWAY',
  /** 来源标签：人工录入 */
  SOURCE_LABEL_MANUAL: 'PARAM-BOARD-SOURCE-LABEL-MANUAL',
} as const;

export type BoardParamId = (typeof BOARD_PARAM)[keyof typeof BOARD_PARAM];

/** 默认值（部署可经 `new BoardParams({ own: {...} })` 覆盖） */
export const BOARD_DEFAULTS: Record<BoardParamId, number | string> = {
  [BOARD_PARAM.HISTORY_KEEP]: 24 * HOUR,
  [BOARD_PARAM.HISTORY_MAX_ENTRIES]: 20_000,
  [BOARD_PARAM.HISTORY_DEFAULT_LIMIT]: 200,
  [BOARD_PARAM.HISTORY_MAX_LIMIT]: 5_000,
  [BOARD_PARAM.RECONNECT_BACKLOG_MAX]: 5_000,
  [BOARD_PARAM.KEYWORD_MAX_LENGTH]: 64,
  [BOARD_PARAM.DETAIL_MAX_OCCUPANTS]: 20,
  [BOARD_PARAM.EVENT_STREAM_RETRY_MS]: 3 * SEC,
  [BOARD_PARAM.EVENT_STREAM_KEEPALIVE_MS]: 15 * SEC,
  [BOARD_PARAM.EVENT_STREAM_REPLAY_MAX]: 512,
  [BOARD_PARAM.EVENT_STREAM_COALESCE_MAX]: 512,
  [BOARD_PARAM.EVENT_STREAM_MAX_CONNECTIONS]: 64,
  [BOARD_PARAM.SOURCE_LABEL_REAL]: '真机',
  [BOARD_PARAM.SOURCE_LABEL_TWIN]: '数字孪生',
  [BOARD_PARAM.SOURCE_LABEL_GATEWAY]: '工业网关',
  [BOARD_PARAM.SOURCE_LABEL_MANUAL]: '人工录入',
};

/* ---------------------------------------------------------------- 参数门面 */

export interface BoardParamsOverrides {
  /** 覆盖说明书 §11 的基座参数 */
  core?: ParamOverrides;
  /** 覆盖本包专有参数 */
  own?: LocalParamOverrides<BoardParamId>;
}

/**
 * 看板参数门面：一次构造，业务代码只从这里取数。
 *
 * 依赖的基座参数（core）：
 * `PARAM-OFFLINE-JUDGE`、`PARAM-ONLINE-JUDGE`、`PARAM-MAP-FALLBACK`、
 * `PARAM-MAP-BROADCAST`、`PARAM-MAP-RECONCILE`、`PARAM-RECONNECT-RESTORE`。
 */
export class BoardParams {
  readonly core: ParamRegistry;
  readonly own: LocalParams<BoardParamId>;

  constructor(overrides: BoardParamsOverrides = {}) {
    this.core = new ParamRegistry(overrides.core ?? {});
    this.own = new LocalParams<BoardParamId>(BOARD_DEFAULTS, overrides.own ?? {});
  }

  /** 说明书 §11 基座参数（数值） */
  base(id: ParamId): number {
    return this.core.number(id);
  }

  /** 本包专有参数（数值） */
  number(id: BoardParamId): number {
    return this.own.number(id);
  }

  /** 本包专有参数（字符串，如来源标签） */
  text(id: BoardParamId): string {
    return this.own.string(id);
  }

  /** 判离线窗口：连续无有效上报达到该时长即判离线 */
  offlineJudgeMs(): number {
    return this.#positive(PARAM.OFFLINE_JUDGE);
  }

  /** 判在线窗口：离线后需持续上报达到该时长才恢复 */
  onlineJudgeMs(): number {
    return this.#positive(PARAM.ONLINE_JUDGE);
  }

  /**
   * 广播周期（毫秒）。
   *
   * `PARAM-MAP-BROADCAST` 的单位是 **Hz**（说明书 §11.3 标注 1Hz），
   * 因此周期 = `1000 / 值`；这与 `PARAM-MAP-FALLBACK`（毫秒）单位不同，
   * 差异在此**唯一一处**显式换算，禁止在别处再算一次。
   */
  broadcastPeriodMs(): number {
    const hz = this.#positive(PARAM.MAP_BROADCAST);
    return 1000 / hz;
  }

  /** 兜底轮询周期（毫秒）：广播断层时按此周期全量拉一次 */
  fallbackPeriodMs(): number {
    return this.#positive(PARAM.MAP_FALLBACK);
  }

  /** 对账周期（毫秒） */
  reconcileMs(): number {
    return this.#positive(PARAM.MAP_RECONCILE);
  }

  /** 断线重连恢复窗口（毫秒）：窗口内重连不丢订阅，超窗即 degraded */
  reconnectRestoreMs(): number {
    return this.#positive(PARAM.RECONNECT_RESTORE);
  }

  /** 来源类别 → 人话标签 */
  sourceLabel(kind: 'real' | 'twin' | 'gateway' | 'manual'): string {
    switch (kind) {
      case 'real':
        return this.text(BOARD_PARAM.SOURCE_LABEL_REAL);
      case 'twin':
        return this.text(BOARD_PARAM.SOURCE_LABEL_TWIN);
      case 'gateway':
        return this.text(BOARD_PARAM.SOURCE_LABEL_GATEWAY);
      case 'manual':
        return this.text(BOARD_PARAM.SOURCE_LABEL_MANUAL);
      default: {
        const never: never = kind;
        throw new Error(`BoardParams.sourceLabel: 未知来源类别 ${String(never)}`);
      }
    }
  }

  /** 诊断快照（不含凭据） */
  snapshot(): { core: Record<string, number | string | undefined>; own: Record<string, number | string | undefined> } {
    return { core: this.core.snapshot(), own: this.own.snapshot() };
  }

  #positive(id: ParamId): number {
    const value = this.base(id);
    if (value <= 0) {
      throw new Error(`参数 ${id} 必须为正数（当前 ${value}）`);
    }
    return value;
  }
}

let defaultParams: BoardParams | undefined;

/** 进程内默认参数容器（未注入时使用） */
export function defaultBoardParams(): BoardParams {
  defaultParams ??= new BoardParams();
  return defaultParams;
}

/**
 * 构造参数容器并做**启动期自检**：依赖的契约参数必须存在且为正数。
 * 缺参数时启动即失败，而不是运行到判离线那一刻才报错。
 */
export function createBoardParams(overrides: BoardParamsOverrides = {}): BoardParams {
  const params = new BoardParams(overrides);
  params.offlineJudgeMs();
  params.onlineJudgeMs();
  params.broadcastPeriodMs();
  params.fallbackPeriodMs();
  params.reconnectRestoreMs();
  params.reconcileMs();
  return params;
}

/** 本包声明的 `PARAM-BOARD-*` 编号清单，供审计与文档生成 */
export function boardParamIds(): BoardParamId[] {
  return defaultBoardParams().own.ids();
}
