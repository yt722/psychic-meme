/**
 * 看板视图（S01.1 三级浏览 + S01.3 工位详情）。
 *
 * ## 结构
 *
 * 本模块只做两件事：**把目录结构套上状态**、**把状态整理成对外字段**。
 * 状态的唯一来源是注入的 `StationProjection`（它又只认状态源上行数据）。
 *
 * ## A-02：状态只做投影，不由水位推导
 *
 * 本模块**没有**、也不会新增任何"按占用数/容量算状态"的分支：
 * - 工位状态一律 `projection.stateOf(stationCode)`；
 * - 从未上报的工位展示为 `offline`（数据缺席），而不是 `available`（那是猜测）；
 * - `statsOf` 里的计数是从**投影结果**里数出来的，反过来不会写回状态。
 *
 * ## 详情字段（说明书 §3.4.4，6 个必需字段）
 *
 * `stationCode` / `labCode` / `state` / `updatedAt` / `sourceKind` / `params`
 * （外加 `alarmCode`，如存在）——见 `REQUIRED_DETAIL_FIELDS`。
 */

import { errors, isValidStationCode, maskStudentId, toIso } from '@peripheral/core';
import type { Clock } from '@peripheral/core';

import type { CampusCatalog } from './catalog.js';
import { applyFilter, countByState, normalizeFilter, statsOf } from './filter-stats.js';
import { defaultBoardParams, BOARD_PARAM, type BoardParams } from './params.js';
import type { StationProjection } from './projection.js';
import {
  REQUIRED_DETAIL_FIELDS,
  type BoardFilter,
  type BrowseResult,
  type CampusBoardNode,
  type ContextSource,
  type LabBoardNode,
  type RealtimeParams,
  type SourceKind,
  type StationBoardNode,
  type StationContextInput,
  type StationContextLookup,
  type StationDetail,
  type StationLeaseInfo,
  type StationOccupant,
  type StationTaskInfo,
  type StatsBreakdown,
} from './types.js';

export interface BoardViewDeps {
  /** 三级目录（结构） */
  catalog: CampusCatalog;
  /** 状态投影（数据） */
  projection: StationProjection;
  clock: Clock;
  /** 缺省用进程内默认参数容器 */
  params?: BoardParams;
  /**
   * 工位上下文（任务 / 租约 / 占用人员）——**替身注入**。
   *
   * 未注入时详情仍可用，只是这三项为 `null`/空且 `contextSource` 为 `not-configured`；
   * 本包**不猜**"谁在这个工位"，也不提供缺省实现（与 `OccupancyLookup` 同纪律）。
   */
  context?: StationContextLookup;
}

export class BoardView {
  readonly catalog: CampusCatalog;
  readonly projection: StationProjection;
  readonly clock: Clock;
  readonly params: BoardParams;
  readonly #context: StationContextLookup | undefined;

  constructor(deps: BoardViewDeps) {
    this.catalog = deps.catalog;
    this.projection = deps.projection;
    this.clock = deps.clock;
    this.params = deps.params ?? defaultBoardParams();
    this.#context = deps.context;
  }

  /** 全部工位视图项（未筛选） */
  allStations(): StationBoardNode[] {
    return this.catalog
      .stationCodes()
      .map((stationCode) => this.#stationNode(stationCode))
      .filter((node): node is StationBoardNode => node !== undefined);
  }

  /** 按条件筛选后的工位视图项 */
  stations(filter: BoardFilter = {}): StationBoardNode[] {
    return applyFilter(this.allStations(), filter, this.params);
  }

  /**
   * 三级浏览（S01.1）：校区 → 实训室 → 工位，每级带本级统计。
   *
   * 筛选行为：命中筛选的工位保留；**被显式点名的**实训室/校区即使筛完为空也保留
   * （否则前端切换筛选后会出现"我点的那个实训室不见了"）。
   */
  browse(filter: BoardFilter = {}): BrowseResult {
    const normalized = normalizeFilter(filter, {
      keywordMaxLength: this.params.number(BOARD_PARAM.KEYWORD_MAX_LENGTH),
    });
    const stations = applyFilter(this.allStations(), normalized, this.params);

    const byLab = new Map<string, StationBoardNode[]>();
    for (const node of stations) {
      const list = byLab.get(node.labCode);
      if (list === undefined) byLab.set(node.labCode, [node]);
      else list.push(node);
    }

    const campuses: CampusBoardNode[] = [];
    for (const campus of this.catalog.tree()) {
      const labs: LabBoardNode[] = [];
      for (const lab of campus.labs) {
        const labStations = byLab.get(lab.labCode) ?? [];
        if (labStations.length === 0 && normalized.labCode !== lab.labCode) continue;
        labs.push({
          labCode: lab.labCode,
          campusCode: campus.campusCode,
          name: lab.name,
          stations: labStations,
          stats: countByState(labStations),
        });
      }

      if (labs.length === 0 && normalized.campusCode !== campus.campusCode) continue;
      campuses.push({
        campusCode: campus.campusCode,
        name: campus.name,
        labs,
        stats: countByState(labs.flatMap((lab) => lab.stations)),
      });
    }

    return { campuses, stats: countByState(stations) };
  }

  /** 统计（按状态 / 按实训室 / 按校区）；入参为筛选条件 */
  stats(filter: BoardFilter = {}): StatsBreakdown {
    return statsOf(this.stations(filter));
  }

  /**
   * 工位详情（S01.3 / 说明书 §3.4.4）。
   *
   * 未知工位抛 `GEN-1001`（`reason=unknown-station`），HTTP 层映射为 404。
   */
  stationDetail(stationCode: string): StationDetail {
    if (!isValidStationCode(stationCode)) {
      throw errors.badRequest({ field: 'stationCode', expected: 'ST-LAB<2位>-<2位>', actual: String(stationCode) });
    }
    if (!this.catalog.hasStation(stationCode)) {
      throw errors.badRequest({ reason: 'unknown-station', stationCode });
    }

    const record = this.projection.recordOf(stationCode);
    const state = this.projection.stateOf(stationCode);
    const meta = this.catalog.metaOfStation(stationCode);
    const labCode = this.catalog.labOfStation(stationCode).labCode;
    const campusCode = this.catalog.campusCodeOfStation(stationCode) ?? '';
    const context = this.#resolveContext(stationCode);

    return {
      stationCode,
      labCode,
      campusCode,
      state,
      updatedAt: record === undefined ? null : toIso(record.atMs),
      updatedAtMs: record === undefined ? null : record.atMs,
      sourceKind: record?.sourceKind ?? 'manual',
      sourceLabel: record === undefined ? '无状态源数据' : this.params.sourceLabel(record.sourceKind),
      params: record?.params ?? {},
      judgedOffline: record?.judgedOffline ?? false,
      ...(record?.sourceId !== undefined ? { sourceId: record.sourceId } : {}),
      ...(record?.alarmCode !== undefined ? { alarmCode: record.alarmCode } : {}),
      ...(record?.alarmLevel !== undefined ? { alarmLevel: record.alarmLevel } : {}),
      ...(typeof meta?.['name'] === 'string' ? { name: String(meta['name']) } : {}),
      task: context.task,
      lease: context.lease,
      occupants: context.occupants,
      contextSource: context.source,
    };
  }

  /** 详情字段清单（说明书 §3.4.4 的 6 个必需字段），供自检与文档引用 */
  requiredDetailFields(): readonly string[] {
    return REQUIRED_DETAIL_FIELDS;
  }

  /** 目录规模与已投影工位数（诊断用） */
  size(): { campuses: number; labs: number; stations: number; projected: number } {
    const size = this.catalog.size();
    return { ...size, projected: this.projection.snapshot().length };
  }

  /**
   * 取工位上下文（S01.3）。
   *
   * 三条纪律：
   * 1. **脱敏在出口做**：数据源允许给原始学号，本包一律 `maskStudentId` 后才输出——
   *    详情响应会被前端缓存、被截图、被浏览器历史留存，原始学号绝不进去。
   * 2. **数据源报错不能让详情 500**：状态字段是看板的核心，上下文缺了照样要能看，
   *    但必须用 `contextSource: 'unavailable'` 说清"这是查不到，不是没有人"。
   * 3. **占用人数有界**：上限走 `PARAM-BOARD-DETAIL-MAX-OCCUPANTS`，
   *    防一个异常数据源把响应撑成大对象。
   */
  #resolveContext(stationCode: string): {
    task: StationTaskInfo | null;
    lease: StationLeaseInfo | null;
    occupants: StationOccupant[];
    source: ContextSource;
  } {
    const lookup = this.#context;
    if (lookup === undefined) {
      return { task: null, lease: null, occupants: [], source: 'not-configured' };
    }

    let raw: StationContextInput;
    try {
      raw = lookup.contextOf(stationCode);
    } catch {
      return { task: null, lease: null, occupants: [], source: 'unavailable' };
    }

    const maxOccupants = this.params.number(BOARD_PARAM.DETAIL_MAX_OCCUPANTS);
    const occupants: StationOccupant[] = [];
    for (const item of raw.occupants ?? []) {
      if (occupants.length >= maxOccupants) break;
      const userId = typeof item?.userId === 'string' ? item.userId.trim() : '';
      if (userId === '') continue; // 空学号不产出空记录，也不静默变成一条占位
      occupants.push({
        userIdMasked: maskStudentId(userId),
        ...(item.taskId !== undefined ? { taskId: item.taskId } : {}),
        ...(item.sinceMs !== undefined ? { sinceMs: item.sinceMs } : {}),
      });
    }

    const rawTask = raw.task;
    const task: StationTaskInfo | null =
      rawTask != null && typeof rawTask.taskId === 'string' && rawTask.taskId.trim() !== ''
        ? {
            taskId: rawTask.taskId,
            ...(rawTask.title !== undefined ? { title: rawTask.title } : {}),
            ...(rawTask.startedAtMs !== undefined ? { startedAtMs: rawTask.startedAtMs } : {}),
          }
        : null;

    const rawLease = raw.lease;
    const operatorId = typeof rawLease?.operatorId === 'string' ? rawLease.operatorId.trim() : '';
    const lease: StationLeaseInfo | null =
      rawLease != null && typeof rawLease.leaseId === 'string' && rawLease.leaseId.trim() !== ''
        ? {
            leaseId: rawLease.leaseId,
            kind: rawLease.kind,
            state: rawLease.state,
            expiresAtMs: rawLease.expiresAtMs ?? null,
            ...(operatorId !== '' ? { operatorIdMasked: maskStudentId(operatorId) } : {}),
          }
        : null;

    return { task, lease, occupants, source: 'ok' };
  }

  #stationNode(stationCode: string): StationBoardNode | undefined {
    if (!this.catalog.hasStation(stationCode)) return undefined;
    const record = this.projection.recordOf(stationCode);
    const state = this.projection.stateOf(stationCode);
    const labCode = this.catalog.labOfStation(stationCode).labCode;
    const campusCode = this.catalog.campusCodeOfStation(stationCode) ?? '';
    const meta = this.catalog.metaOfStation(stationCode);
    const sourceKind: SourceKind | null = record?.sourceKind ?? null;
    const params: RealtimeParams = record?.params ?? {};

    return {
      stationCode,
      labCode,
      campusCode,
      state,
      updatedAt: record === undefined ? null : toIso(record.atMs),
      atMs: record === undefined ? null : record.atMs,
      sourceKind,
      sourceLabel: sourceKind === null ? '无状态源数据' : this.params.sourceLabel(sourceKind),
      params,
      judgedOffline: record?.judgedOffline ?? false,
      ...(typeof meta?.['name'] === 'string' ? { name: String(meta['name']) } : {}),
      ...(record?.alarmCode !== undefined ? { alarmCode: record.alarmCode } : {}),
      ...(record?.alarmLevel !== undefined ? { alarmLevel: record.alarmLevel } : {}),
    };
  }
}
