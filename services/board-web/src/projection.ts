/**
 * 工位状态投影（S01.2 / IF-01 §6）。
 *
 * ## 这条纪律是本包的核心（验收项 A-02）
 *
 * **工位状态只做投影：把状态源（真机 / 孪生 / 网关 / 人工）上行来的 `state`
 * 原样搬运到看板，绝不由资源池水位（占用数 / 容量）推导。**
 *
 * 具体到代码：
 * - 状态的唯一写入点是 {@link StationProjection.applyState}，且只取 `input.state`；
 * - `applyState` 收到**没有 `state`、却带水位字段**的载荷时直接拒绝
 *   （`POOL_LEVEL_FIELDS` / reason=`state-required-not-derived-from-pool-level`），
 *   让"想用 `used >= capacity` 算状态"的代码在第一次调用就暴露；
 * - 本模块**不含任何** `used`/`capacity` 参与运算的分支（单测对源码做静态审计）。
 *
 * ## 在线 / 离线判定（IF-01 §5）
 *
 * | 判定 | 条件 | 参数 |
 * |---|---|---|
 * | 判离线 | 连续无有效上报 ≥ 阈值 | `PARAM-OFFLINE-JUDGE`（默认 2 分钟） |
 * | 判在线 | 离线后恢复持续上报 ≥ 阈值 | `PARAM-ONLINE-JUDGE`（默认 1 分钟） |
 *
 * 判出来的 `offline` 与状态源自己报的 `offline` 分开记账：
 * `judgedOffline=true` 才需要走"恢复窗口"才能回到设备自报状态；
 * 状态源明确报 `offline` 之后又报 `available`，那是**正常的源侧迁移**，立即生效。
 *
 * 从未上报的工位展示为 `offline`（数据缺席即不可用）——这仍由"是否有状态源数据"决定，
 * 与资源池水位无关。但从不上报不产生迁移事件（没有"从什么变成什么"）。
 */

import { errors, toIso } from '@peripheral/core';
import type { Clock } from '@peripheral/core';

import type { BoardParams } from './params.js';
import {
  POOL_LEVEL_FIELDS,
  assertStationCode,
  parseAlarmLevel,
  parseAtMs,
  parseOptionalText,
  parseRealtimeParams,
  parseSourceKind,
  parseStationState,
  type KnownStations,
  type RealtimeParams,
  type StationRecord,
  type StationState,
  type StationStateInput,
} from './types.js';

/** 迁移原因 */
export type ProjectionReason = 'upstream' | 'no-report' | 'recovered';

/** 一次状态迁移（看板增量、历史、实时通道都消费它） */
export interface ProjectionEvent {
  stationCode: string;
  from: StationState;
  to: StationState;
  atMs: number;
  reason: ProjectionReason;
  /** 迁移后的完整记录（快照语义，调用方可直接落历史） */
  record: StationRecord;
}

export type ProjectionListener = (event: ProjectionEvent) => void;

export interface StationProjectionDeps {
  /** 合法工位集合（通常是 `CampusCatalog`）；用于拒绝未知工位 */
  catalog: KnownStations;
  params: BoardParams;
  clock: Clock;
}

export class StationProjection {
  readonly #catalog: KnownStations;
  readonly #params: BoardParams;
  readonly #clock: Clock;
  readonly #records = new Map<string, StationRecord>();
  readonly #listeners = new Set<ProjectionListener>();
  /** 离线后首次恢复上报的时间，用于累计 `PARAM-ONLINE-JUDGE` */
  readonly #recoveryStartMs = new Map<string, number>();

  #outOfOrder = 0;
  #listenerErrors = 0;
  #applied = 0;

  constructor(deps: StationProjectionDeps) {
    this.#catalog = deps.catalog;
    this.#params = deps.params;
    this.#clock = deps.clock;
  }

  /**
   * 应用一次状态源数据。
   *
   * 非法编码 / 未知工位 / 非法状态 / 无状态只给水位 → 一律抛错
   * （脏数据宁可拒，也不能污染看板）。
   */
  applyState(input: StationStateInput): StationRecord {
    assertNoPoolLevelDerivation(input);

    const stationCode = assertStationCode(input.stationCode);
    if (!this.#catalog.hasStation(stationCode)) {
      throw errors.badRequest({ reason: 'unknown-station', stationCode });
    }

    const upstreamState = parseStationState(input.state);
    const atMs = parseAtMs(input.atMs);
    const sourceKind = parseSourceKind(input.sourceKind);
    const params = parseRealtimeParams(input.params);
    const alarmLevel = parseAlarmLevel(input.alarmLevel);
    const alarmCode = parseOptionalText(input.alarmCode, 'alarmCode');
    const sourceId = parseOptionalText(input.sourceId, 'sourceId');

    const previous = this.#records.get(stationCode);
    const labCode = labCodeFrom(stationCode);
    const campusCode = this.#catalog.campusCodeOfStation?.(stationCode) ?? '';

    // 乱序（比已记的采样时间还早）照样收下并保留，仅计数告警——不静默丢弃（IF-01 §4.2 口径）。
    if (previous !== undefined && atMs < previous.atMs) this.#outOfOrder += 1;

    const effectiveAtMs = previous === undefined ? atMs : Math.max(previous.atMs, atMs);
    const effectiveSourceId = sourceId ?? previous?.sourceId;
    const judgedOffline = previous?.judgedOffline ?? false;

    const record: StationRecord = {
      stationCode,
      labCode,
      campusCode,
      state: upstreamState,
      upstreamState,
      atMs: effectiveAtMs,
      sourceKind,
      params: mergeParams(previous?.params, params),
      judgedOffline: false,
      ...(alarmCode !== undefined ? { alarmCode } : {}),
      ...(alarmLevel !== undefined ? { alarmLevel } : {}),
      ...(effectiveSourceId !== undefined ? { sourceId: effectiveSourceId } : {}),
    };

    this.#applied += 1;

    if (judgedOffline) {
      // 恢复中：需持续上报累计满 `PARAM-ONLINE-JUDGE` 才回到设备自报状态。
      const judge = this.#params.offlineJudgeMs();
      const gapFromPrevious = previous === undefined ? Number.POSITIVE_INFINITY : atMs - previous.atMs;
      if (gapFromPrevious >= judge) {
        // 恢复期内又中断，重新计时
        this.#recoveryStartMs.set(stationCode, atMs);
      }
      const startedAt = this.#recoveryStartMs.get(stationCode) ?? atMs;
      if (!this.#recoveryStartMs.has(stationCode)) this.#recoveryStartMs.set(stationCode, startedAt);

      if (atMs - startedAt >= this.#params.onlineJudgeMs()) {
        this.#recoveryStartMs.delete(stationCode);
        this.#records.set(stationCode, record);
        this.#dispatch({ stationCode, from: 'offline', to: upstreamState, atMs: effectiveAtMs, reason: 'recovered', record });
        return record;
      }

      // 未满足恢复窗口：展示态仍为 offline，但保留最新上报内容（参数 / 报警要能给到看板）
      const stillOffline: StationRecord = { ...record, state: 'offline', judgedOffline: true };
      this.#records.set(stationCode, stillOffline);
      return stillOffline;
    }

    this.#records.set(stationCode, record);

    // 从未上报时展示态本来就是 `offline`（数据缺席即不可用），
    // 因此首次上报的迁移起点取 `offline`，与 `stateOf` 的读法完全一致。
    const from = previous?.state ?? 'offline';
    if (from !== upstreamState) {
      this.#dispatch({
        stationCode,
        from,
        to: upstreamState,
        atMs: effectiveAtMs,
        reason: 'upstream',
        record,
      });
    }
    return record;
  }

  /**
   * 展示态。
   *
   * - 未知工位（不在目录里）→ 抛 `GEN-1001`
   * - 已知但从未上报 → `offline`
   * - 静默超过 `PARAM-OFFLINE-JUDGE` → `offline`（惰性判定，顺带推进迁移）
   */
  stateOf(stationCode: string): StationState {
    const code = assertStationCode(stationCode);
    if (!this.#catalog.hasStation(code)) {
      throw errors.badRequest({ reason: 'unknown-station', stationCode: code });
    }
    this.evaluate();
    return this.#records.get(code)?.state ?? 'offline';
  }

  /** 完整记录；从未上报返回 undefined */
  recordOf(stationCode: string): StationRecord | undefined {
    const code = assertStationCode(stationCode);
    if (!this.#catalog.hasStation(code)) {
      throw errors.badRequest({ reason: 'unknown-station', stationCode: code });
    }
    this.evaluate();
    return this.#records.get(code);
  }

  /** 已上报工位的快照（按工位编码升序，便于比对） */
  snapshot(): StationRecord[] {
    this.evaluate();
    return [...this.#records.values()].sort((a, b) => (a.stationCode < b.stationCode ? -1 : 1));
  }

  /** 订阅状态迁移；返回退订函数 */
  subscribe(listener: ProjectionListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** 订阅者数量 */
  listenerCount(): number {
    return this.#listeners.size;
  }

  /**
   * 推进判离线（幂等）：静默超窗者转 `offline`，恢复中再次静默者重新计时。
   *
   * 返回本次产生的迁移。`stateOf` / `snapshot` / `recordOf` 会**惰性**调用它，
   * 因此读看板与收事件永远一致。
   */
  evaluate(nowMs?: number): ProjectionEvent[] {
    const now = nowMs ?? this.#clock.now();
    const judge = this.#params.offlineJudgeMs();
    const events: ProjectionEvent[] = [];

    for (const record of this.#records.values()) {
      const silentFor = now - record.atMs;
      if (silentFor < judge) continue;

      if (record.judgedOffline) {
        // 静默期内再次中断 → 恢复计时清零
        this.#recoveryStartMs.delete(record.stationCode);
        continue;
      }

      const offlineRecord: StationRecord = { ...record, state: 'offline', judgedOffline: true };
      this.#records.set(record.stationCode, offlineRecord);
      this.#recoveryStartMs.delete(record.stationCode);
      events.push({
        stationCode: record.stationCode,
        from: record.state,
        to: 'offline',
        atMs: now,
        reason: 'no-report',
        record: offlineRecord,
      });
    }

    for (const event of events) this.#dispatch(event);
    return events;
  }

  /** 该工位的展示态 `offline` 是否为"静默判出" */
  isJudgedOffline(stationCode: string): boolean {
    return this.recordOf(stationCode)?.judgedOffline ?? false;
  }

  /** 距上次状态源数据的静默时长（毫秒）；从未上报返回 undefined */
  silentForMs(stationCode: string, nowMs?: number): number | undefined {
    const record = this.recordOf(stationCode);
    if (record === undefined) return undefined;
    return (nowMs ?? this.#clock.now()) - record.atMs;
  }

  /** 诊断快照 */
  stats(): {
    applied: number;
    stations: number;
    listeners: number;
    outOfOrder: number;
    listenerErrors: number;
    offlineJudgeMs: number;
    onlineJudgeMs: number;
  } {
    return {
      applied: this.#applied,
      stations: this.#records.size,
      listeners: this.#listeners.size,
      outOfOrder: this.#outOfOrder,
      listenerErrors: this.#listenerErrors,
      offlineJudgeMs: this.#params.offlineJudgeMs(),
      onlineJudgeMs: this.#params.onlineJudgeMs(),
    };
  }

  /** 清空（仅测试与重放用） */
  clear(): void {
    this.#records.clear();
    this.#recoveryStartMs.clear();
  }

  /** 带异常隔离的对外广播：监听器出错不影响看板读路径（IF-01 §6 NFR-REL-03 同源原则） */
  #dispatch(event: ProjectionEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        this.#listenerErrors += 1;
      }
    }
  }
}

/** 把 `ProjectionEvent` 压成可读的时间线文本（诊断/日志用） */
export function describeEvent(event: ProjectionEvent): string {
  return `${toIso(event.atMs)} ${event.stationCode} ${event.from}→${event.to} (${event.reason})`;
}

/**
 * A-02 守卫：**拒绝"只给水位不给状态"的载荷**。
 *
 * 带水位字段**同时**带 `state` 时不拦（那是设备方附带的诊断信息）；
 * 只有"想用 `used >= capacity` 推状态"的调用形态才会命中。
 */
export function assertNoPoolLevelDerivation(input: unknown): void {
  if (typeof input !== 'object' || input === null) {
    throw errors.badRequest({ field: 'input', expected: 'object' });
  }
  const raw = input as Record<string, unknown>;
  if (raw['state'] !== undefined && raw['state'] !== null) return;

  const leaked = POOL_LEVEL_FIELDS.filter((key) => raw[key] !== undefined);
  if (leaked.length > 0) {
    throw errors.badRequest({
      reason: 'state-required-not-derived-from-pool-level',
      field: 'state',
      poolLevelFields: leaked.join(','),
    });
  }
  throw errors.badRequest({ field: 'state', reason: 'required' });
}

/** 工位编码 → 实训室编码（编码运算，不查目录） */
function labCodeFrom(stationCode: string): string {
  return `LAB-${stationCode.slice(6, 8)}`;
}

/** 实时参数合并：新值覆盖同名旧值，旧值中未再上报的键保留（"最近已知值"语义） */
function mergeParams(previous: RealtimeParams | undefined, next: RealtimeParams): RealtimeParams {
  if (previous === undefined) return next;
  return { ...previous, ...next };
}
