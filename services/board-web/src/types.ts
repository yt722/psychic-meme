/**
 * S01 实训室与工位看板 —— 共享类型与入参校验。
 *
 * 依据：说明书 §3.4 三级看板、FR-MAP-02（工位四状态）、`contracts/if-01-device-status.md`。
 *
 * ⚠️ **本包最重要的一条纪律（验收项 A-02）**：
 * 工位状态**只做投影展示**，**绝不**由资源池水位（占用数 / 容量）推导。
 * 本文件里的所有类型都是"状态源上行数据的搬运结构"，**没有任何**
 * `used` / `capacity` 字段参与状态计算；四状态只能来自
 * {@link StationStateInput.state}（状态源上报）。
 *
 * 详见 `README.md` §4「状态只做投影，不由水位推导」。
 */

import { errors, isValidStationCode } from '@peripheral/core';

/* --------------------------------------------------------------- 工位四状态 */

/** 工位四状态（FR-MAP-02） */
export type StationState = 'available' | 'occupied' | 'maintenance' | 'offline';

/** 四状态全量清单：遍历 / 统计 / 图例顺序的唯一出处（禁止各处再写一遍字面量数组） */
export const STATION_STATES: readonly StationState[] = ['available', 'occupied', 'maintenance', 'offline'];

/**
 * IF-01 契约口径 → 平台展示口径的别名表。
 *
 * `contracts/if-01-device-status.md` §1 的设备侧取值为 `idle|occupied|maintenance|offline`，
 * 看板展示口径为 `available|occupied|maintenance|offline`（`idle` 即 `available`）。
 * 别名只在**入口处归一化**，库里/输出里**只保留展示口径**，避免两套词汇漂移。
 */
export const CONTRACT_STATE_ALIASES: Readonly<Record<string, StationState>> = {
  idle: 'available',
};

/* ------------------------------------------------------------- 数据来源标识 */

/**
 * 数据来源类别（IF-01 §7：看板与统计必须能区分"数据来自真机"还是"来自孪生替身"）。
 */
export type SourceKind = 'real' | 'twin' | 'gateway' | 'manual';

/** 来源类别全量清单 */
export const SOURCE_KINDS: readonly SourceKind[] = ['real', 'twin', 'gateway', 'manual'];

/** 报警等级（IF-01 §1） */
export type AlarmLevel = 'info' | 'warning' | 'fault';

/** 报警等级全量清单 */
export const ALARM_LEVELS: readonly AlarmLevel[] = ['info', 'warning', 'fault'];

/** 实时参数取值（只允许标量，避免把设备结构体直接灌进看板响应） */
export type RealtimeParamValue = number | string | boolean;

/** 实时参数键值对（键名由设备方提供，见 IF-01 §1） */
export type RealtimeParams = Readonly<Record<string, RealtimeParamValue>>;

/* ----------------------------------------------------------------- 状态源入参 */

/**
 * 状态源上行入参。
 *
 * **状态只能来自这里**：`state` 字段是唯一的状态输入，
 * 任何"由占用数/容量算出来"的字段都不被接受（见 {@link POOL_LEVEL_FIELDS}）。
 */
export interface StationStateInput {
  /** 工位编码，全校唯一（`ST-LAB<2位>-<2位>`） */
  stationCode: string;
  /** 四状态；契约口径的 `idle` 亦接受并归一化为 `available` */
  state: StationState | 'idle';
  /** 状态的真实采样时间（毫秒时间戳）；非上报时间 */
  atMs: number;
  /** 数据来源类别 */
  sourceKind: SourceKind;
  /** 来源标识（真机/孪生/网关/人工录入的身份，见 IF-01 §1 `sourceId`） */
  sourceId?: string;
  /** 关键实时参数键值对 */
  params?: Record<string, RealtimeParamValue>;
  /** 报警码（可为空） */
  alarmCode?: string | null;
  /** 报警等级 */
  alarmLevel?: AlarmLevel;
}

/**
 * **资源池水位字段清单——本包显式拒绝的一类入参。**
 *
 * A-02 硬约束的可执行表达：`applyState` 收到的载荷若**没有 `state`**、
 * 却带着这些水位字段，一律拒绝（`GEN-1001`），
 * 理由写成 `state-required-not-derived-from-pool-level`，
 * 让"想用 `used >= capacity` 推状态"的代码在第一次调用就暴露，而不是悄悄污染看板。
 *
 * 带电水位字段**同时**带 `state` 时不报错（只当作无关字段忽略）——
 * 避免把设备方附带的诊断字段当违规拦下。
 */
export const POOL_LEVEL_FIELDS: readonly string[] = [
  'used',
  'capacity',
  'usedSeats',
  'capacitySeats',
  'allocated',
  'inUse',
  'occupancy',
  'poolLevel',
];

/* ------------------------------------------------------------------- 工位记录 */

/**
 * 工位投影记录（看板的唯一数据源）。
 *
 * `state` 是**展示态**（含判离线结果）；`upstreamState` 是状态源最近一次上报的原始态。
 * 两者分开是为了判离线恢复：静默期结束后要恢复到"设备自己报的状态"，
 * 而不是恢复到某个推导出来的状态。
 */
export interface StationRecord {
  stationCode: string;
  labCode: string;
  campusCode: string;
  /** 展示态（判离线后为 `offline`） */
  state: StationState;
  /** 状态源最近一次上报的原始态（可能为 `available`，而展示态是 `offline`） */
  upstreamState: StationState;
  /** 最近一次状态源数据的采样时间（毫秒时间戳） */
  atMs: number;
  sourceKind: SourceKind;
  sourceId?: string;
  params: RealtimeParams;
  alarmCode?: string;
  alarmLevel?: AlarmLevel;
  /** true 表示当前 `offline` 是"静默超时"判出来的，而非状态源自己报的 offline */
  judgedOffline: boolean;
}

/* ------------------------------------------------------------------- 目录结构 */

/** 工位附加信息（名称等；不参与状态计算） */
export type StationMeta = Record<string, unknown>;

/** 目录里的工位（纯结构，不含状态） */
export interface StationNode {
  stationCode: string;
  labCode: string;
  name?: string;
  meta: StationMeta;
}

/** 目录里的实训室（纯结构，不含状态） */
export interface LabNode {
  labCode: string;
  campusCode: string;
  name: string;
  stations: StationNode[];
}

/** 目录里的校区（纯结构，不含状态） */
export interface CampusNode {
  campusCode: string;
  name: string;
  labs: LabNode[];
}

/** 只读工位存在性查询（投影用来拒绝未知工位，避免脏数据污染看板） */
export interface KnownStations {
  hasStation(stationCode: string): boolean;
  /** 工位所属校区编码；未登记返回 undefined（可选实现，投影缺省记为 `''`） */
  campusCodeOfStation?(stationCode: string): string | undefined;
}

/* ------------------------------------------------------- 工位上下文（S01.3） */

/**
 * 占用者（**对外只允许脱敏形态**）。
 *
 * 原始学号绝不进详情响应：详情页会被前端缓存、会被截图发群里、会进浏览器历史。
 * 数据源（平台调度/学情服务）负责给事实，**脱敏一律由本包在出口处完成**。
 */
export interface StationOccupant {
  /** 脱敏学号（如 `20****01`） */
  userIdMasked: string;
  taskId?: string;
  /** 入场时刻（毫秒）；未知则不出现 */
  sinceMs?: number;
}

/** 当前任务（S01.3） */
export interface StationTaskInfo {
  taskId: string;
  title?: string;
  startedAtMs?: number;
}

/** 当前租约（S01.3；来自平台调度 P08 与 S03 连接器） */
export interface StationLeaseInfo {
  leaseId: string;
  /** 租约类型（与 `connector-svc` 的 `LeaseKind` 同口径字符串） */
  kind: string;
  /** 租约状态（`allocating` / `ready` / `active` / `releasing` / …） */
  state: string;
  /** 到期时刻（毫秒）；未知为 null */
  expiresAtMs: number | null;
  /** 操作者（**已脱敏**） */
  operatorIdMasked?: string;
}

/**
 * 上下文**原始**入参：**允许带原始学号**（脱敏由本包负责）。
 *
 * 与 `alarm-svc` 的 `OccupancyLookup` 同一口径：数据源只管给事实，出口侧统一脱敏。
 */
export interface StationContextInput {
  task?: { taskId: string; title?: string; startedAtMs?: number } | null;
  lease?:
    | { leaseId: string; kind: string; state: string; expiresAtMs?: number | null; operatorId?: string }
    | null;
  occupants?: ReadonlyArray<{ userId: string; taskId?: string; sinceMs?: number }>;
}

/**
 * 上下文的可用性。
 *
 * **必须区分"没有任务/租约/占用"与"查不到"**：两者在排查时完全不同——
 * 前者是现场确实空着，后者是数据源挂了、页面上的"空闲"是假的。
 */
export type ContextSource = 'ok' | 'unavailable' | 'not-configured';

/** 工位上下文查询（**替身注入**：真实实现查平台调度/P08 与 S03 连接器） */
export interface StationContextLookup {
  contextOf(stationCode: string): StationContextInput;
}

/* ----------------------------------------------------------------- 看板视图 */

/** 状态计数（四状态齐全，缺项补 0，便于前端直接渲染图例） */
export interface StateCount {
  total: number;
  available: number;
  occupied: number;
  maintenance: number;
  offline: number;
}

/** 可筛选的工位视图项（filter / stats 的最小输入契约） */
export interface FilterableStation {
  stationCode: string;
  labCode: string;
  campusCode: string;
  state: StationState;
  name?: string;
}

/** 看板工位节点 */
export interface StationBoardNode extends FilterableStation {
  /** 状态更新时间（ISO-8601 东八区）；从未收到状态源数据时为 null */
  updatedAt: string | null;
  atMs: number | null;
  sourceKind: SourceKind | null;
  /** 来源类别的人话标签（来自 `PARAM-BOARD-SOURCE-LABEL-*`） */
  sourceLabel: string;
  params: RealtimeParams;
  alarmCode?: string;
  alarmLevel?: AlarmLevel;
  judgedOffline: boolean;
}

/** 看板实训室节点（带本级统计） */
export interface LabBoardNode {
  labCode: string;
  campusCode: string;
  name: string;
  stations: StationBoardNode[];
  stats: StateCount;
}

/** 看板校区节点（带本级统计） */
export interface CampusBoardNode {
  campusCode: string;
  name: string;
  labs: LabBoardNode[];
  stats: StateCount;
}

/** 三级浏览结果 */
export interface BrowseResult {
  campuses: CampusBoardNode[];
  /** 全量统计（筛选后） */
  stats: StateCount;
}

/** 工位详情（说明书 §3.4.4 要求 6 个必需字段 + 报警码） */
export interface StationDetail {
  /** ① 工位编码 */
  stationCode: string;
  /** ② 所属实训室 */
  labCode: string;
  /** 所属校区（随实训室带出） */
  campusCode: string;
  /** ③ 当前状态 */
  state: StationState;
  /** ④ 状态更新时间（ISO-8601；从未上报为 null） */
  updatedAt: string | null;
  updatedAtMs: number | null;
  /** ⑤ 数据来源 */
  sourceKind: SourceKind;
  sourceLabel: string;
  sourceId?: string;
  /** ⑥ 实时参数 */
  params: RealtimeParams;
  /** 报警码（如存在） */
  alarmCode?: string;
  alarmLevel?: AlarmLevel;
  judgedOffline: boolean;
  name?: string;
  /** S01.3：当前任务（无任务为 null） */
  task: StationTaskInfo | null;
  /** S01.3：当前租约（无租约为 null） */
  lease: StationLeaseInfo | null;
  /** S01.3：占用人员（**已脱敏**） */
  occupants: StationOccupant[];
  /**
   * 上下文是否可取。
   *
   * `not-configured` = 未注入数据源；`unavailable` = 数据源报错。
   * 两者都必须显式出现，否则前端会把"查不到"渲染成"这个工位空着"。
   */
  contextSource: ContextSource;
}

/**
 * 详情的 6 个必需字段（说明书 §3.4.4）。
 *
 * 单测直接对着这张表断言，避免"漏了字段但没人发现"。
 */
export const REQUIRED_DETAIL_FIELDS: readonly (keyof StationDetail)[] = [
  'stationCode',
  'labCode',
  'state',
  'updatedAt',
  'sourceKind',
  'params',
];

/**
 * S01.3 要求的上下文三项（任务 / 租约 / 占用人员）。
 *
 * 与 `REQUIRED_DETAIL_FIELDS` **分开列**：两者来源不同——
 * 6 个必需字段的唯一来源是状态源投影，而这三项来自平台调度与 S03 连接器，
 * 可以"查不到"（此时 `contextSource` 会说明原因）。
 */
export const S01_3_CONTEXT_FIELDS: readonly (keyof StationDetail)[] = ['task', 'lease', 'occupants'];

/* ------------------------------------------------------------------- 筛选统计 */

/** 筛选维度 */
export interface BoardFilter {
  campusCode?: string;
  labCode?: string;
  state?: StationState;
  keyword?: string;
}

/** 分组统计（按实训室 / 按校区） */
export interface GroupStats {
  /** 分组键（实训室编码 / 校区编码） */
  key: string;
  name?: string;
  campusCode?: string;
  count: number;
  byState: StateCount;
}

/** 统计结果：按状态 / 按实训室 / 按校区 */
export interface StatsBreakdown {
  total: number;
  byState: StateCount;
  byLab: GroupStats[];
  byCampus: GroupStats[];
}

/* --------------------------------------------------------------------- 历史 */

/** 历史状态条目 */
export interface HistoryEntry {
  stationCode: string;
  labCode: string;
  campusCode?: string;
  state: StationState;
  atMs: number;
  sourceKind: SourceKind;
  alarmCode?: string;
  params: RealtimeParams;
}

/** 历史写入入参（`labCode` 可由工位编码推导，故可省） */
export interface HistoryEntryInput {
  stationCode: string;
  state: StationState;
  atMs: number;
  sourceKind: SourceKind;
  labCode?: string;
  campusCode?: string;
  alarmCode?: string | null;
  params?: Record<string, RealtimeParamValue>;
}

/** 历史查询条件 */
export interface HistoryQuery {
  stationCode?: string;
  fromMs?: number;
  toMs?: number;
  /** 取窗口内**最新** N 条（返回仍按时间升序） */
  limit?: number;
}

/* --------------------------------------------------------------- 实时通道 */

/** 一次状态变更（帧的最小单位） */
export interface FrameChange {
  stationCode: string;
  state: StationState;
  atMs: number;
  sourceKind: SourceKind;
}

/** 帧产生原因：1Hz 广播 / 兜底全量 / 重连补发 */
export type FrameReason = 'broadcast' | 'fallback' | 'reconnect';

/** 下发帧 */
export interface RealtimeFrame {
  /** 帧序号（单调递增，便于前端丢弃乱序帧） */
  sequence: number;
  atMs: number;
  iso: string;
  reason: FrameReason;
  /** true 表示这是全量帧（收方应整体替换本地视图） */
  full: boolean;
  changes: FrameChange[];
  /** 本次是"断线超窗后的强制全量刷新" */
  degraded: boolean;
}

/** 帧监听器 */
export type FrameListener = (frame: RealtimeFrame) => void;

/** 重连结果 */
export interface ReconnectResult {
  reconnectedAtMs: number;
  /** 断线时长（毫秒）；本次未断线时为 0 */
  offlineMs: number;
  /** 是否在 `PARAM-RECONNECT-RESTORE` 恢复窗口内 */
  withinWindow: boolean;
  /** 是否因超窗被标记 degraded（并强制全量刷新） */
  degraded: boolean;
  /** 本次补发的变更条数 */
  replayedChanges: number;
  /** 重连后仍在的订阅数（"不丢订阅"的证据） */
  subscriptions: number;
  /** 本次下发给订阅者的帧（未断线时为 undefined） */
  frame?: RealtimeFrame;
}

/** 通道诊断快照（不含凭据） */
export interface RealtimeStats {
  connected: boolean;
  degraded: boolean;
  subscriptions: number;
  pendingChanges: number;
  backloggedChanges: number;
  backlogDropped: number;
  sequence: number;
  reconnects: number;
  forcedFullRefreshes: number;
  lastBroadcastAtMs: number;
  lastReconnect?: ReconnectResult;
}

/* ------------------------------------------------------------- 入参解析与校验 */

/** 归一化四状态：接受契约别名 `idle`；非法返回 undefined（由调用方决定报错口径） */
export function normalizeStationState(value: unknown): StationState | undefined {
  if (typeof value !== 'string') return undefined;
  if ((STATION_STATES as readonly string[]).includes(value)) return value as StationState;
  return CONTRACT_STATE_ALIASES[value];
}

/** 解析四状态，非法抛 `GEN-1001` */
export function parseStationState(value: unknown, field = 'state'): StationState {
  const state = normalizeStationState(value);
  if (state === undefined) {
    throw errors.badRequest({ field, allowed: STATION_STATES.join('|'), actual: String(value) });
  }
  return state;
}

/** 解析来源类别，非法抛 `GEN-1001` */
export function parseSourceKind(value: unknown, field = 'sourceKind'): SourceKind {
  if (typeof value !== 'string' || !(SOURCE_KINDS as readonly string[]).includes(value)) {
    throw errors.badRequest({ field, allowed: SOURCE_KINDS.join('|'), actual: String(value) });
  }
  return value as SourceKind;
}

/** 解析报警等级（可选），非法抛 `GEN-1001` */
export function parseAlarmLevel(value: unknown, field = 'alarmLevel'): AlarmLevel | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !(ALARM_LEVELS as readonly string[]).includes(value)) {
    throw errors.badRequest({ field, allowed: ALARM_LEVELS.join('|'), actual: String(value) });
  }
  return value as AlarmLevel;
}

/** 解析毫秒时间戳，非法抛 `GEN-1001` */
export function parseAtMs(value: unknown, field = 'atMs'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw errors.badRequest({ field, reason: 'non-negative-finite-number-required', actual: String(value) });
  }
  return value;
}

/** 校验收到的工位编码；非法抛 `GEN-1001`（对应 `DEV-1001` 的入站口径） */
export function assertStationCode(value: unknown, field = 'stationCode'): string {
  if (typeof value !== 'string' || !isValidStationCode(value)) {
    throw errors.badRequest({ field, reason: 'station-code-format', expected: 'ST-LAB<2位>-<2位>' });
  }
  return value;
}

/** 解析可选非空字符串 */
export function parseOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw errors.badRequest({ field, expected: 'string' });
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 解析实时参数键值对（只允许标量；非法抛 `GEN-1001`） */
export function parseRealtimeParams(value: unknown, field = 'params'): RealtimeParams {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw errors.badRequest({ field, expected: 'scalar-map' });
  }

  const out: Record<string, RealtimeParamValue> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key.trim() === '') throw errors.badRequest({ field, reason: 'empty-param-key' });
    const type = typeof raw;
    if (type !== 'number' && type !== 'string' && type !== 'boolean') {
      throw errors.badRequest({ field: `${field}.${key}`, expected: 'number|string|boolean' });
    }
    if (type === 'number' && !Number.isFinite(raw as number)) {
      throw errors.badRequest({ field: `${field}.${key}`, reason: 'non-finite-number' });
    }
    out[key] = raw as RealtimeParamValue;
  }
  return out;
}
