/**
 * 筛选与统计（S01.3）。
 *
 * 维度：`campusCode?` / `labCode?` / `state?` / `keyword?`。
 *
 * 口径：
 * - 编码先按 `contracts/coding-spec.md` 校验；**非法即抛 `GEN-1001`**
 *   （不静默忽略——静默忽略会让"筛错了"看起来像"筛出来是空的"）。
 * - `keyword` 大小写不敏感，匹配工位编码 / 实训室编码 / 校区编码 / 工位名称 / 状态；
 *   超长直接拒（`PARAM-BOARD-KEYWORD-MAX-LENGTH`），避免把看板当成全文检索用。
 * - 统计里四状态**永远齐全**（缺项补 0），前端可以直接照图例渲染。
 *
 * 注意：本模块只做"筛选与计数"，**不参与任何状态计算**；
 * 状态从入参 `item.state` 原样取用（见 A-02 纪律）。
 */

import { errors, isValidCampusCode, isValidLabCode } from '@peripheral/core';

import { defaultBoardParams, BOARD_PARAM, type BoardParams } from './params.js';
import {
  STATION_STATES,
  normalizeStationState,
  type BoardFilter,
  type FilterableStation,
  type GroupStats,
  type StateCount,
  type StatsBreakdown,
  type StationState,
} from './types.js';

/** 规范化入参（去空白）；非法编码 / 状态 / 超长关键词一律抛 `GEN-1001` */
export interface NormalizeFilterOptions {
  /** 关键词最大长度；缺省取 `PARAM-BOARD-KEYWORD-MAX-LENGTH` */
  keywordMaxLength?: number;
}

/** 规范化入参（去空白）；非法编码 / 状态 / 超长关键词一律抛 `GEN-1001` */
export function normalizeFilter(filter: BoardFilter = {}, options: NormalizeFilterOptions = {}): BoardFilter {
  const out: BoardFilter = {};

  if (filter.campusCode !== undefined) {
    if (!isValidCampusCode(filter.campusCode)) {
      throw errors.badRequest({ field: 'campusCode', expected: 'CAMPUS-<2位>', actual: filter.campusCode });
    }
    out.campusCode = filter.campusCode;
  }

  if (filter.labCode !== undefined) {
    if (!isValidLabCode(filter.labCode)) {
      throw errors.badRequest({ field: 'labCode', expected: 'LAB-<2位>', actual: filter.labCode });
    }
    out.labCode = filter.labCode;
  }

  if (filter.state !== undefined) {
    const state = normalizeStationState(filter.state);
    if (state === undefined) {
      throw errors.badRequest({ field: 'state', allowed: STATION_STATES.join('|'), actual: String(filter.state) });
    }
    out.state = state;
  }

  if (filter.keyword !== undefined) {
    const max = options.keywordMaxLength ?? defaultBoardParams().number(BOARD_PARAM.KEYWORD_MAX_LENGTH);
    if (typeof filter.keyword !== 'string') {
      throw errors.badRequest({ field: 'keyword', expected: 'string' });
    }
    const keyword = filter.keyword.trim();
    if (keyword !== '') {
      if (keyword.length > max) {
        throw errors.badRequest({ field: 'keyword', reason: 'too-long', maxLength: max });
      }
      out.keyword = keyword;
    }
  }

  return out;
}

/** 空统计（四状态齐全） */
export function emptyStateCount(): StateCount {
  return { total: 0, available: 0, occupied: 0, maintenance: 0, offline: 0 };
}

/** 按状态计数（四状态齐全，顺序固定） */
export function countByState(items: readonly FilterableStation[]): StateCount {
  const count = emptyStateCount();
  for (const item of items) {
    const state = normalizeStationState(item.state);
    if (state === undefined) {
      throw errors.badRequest({ field: 'state', reason: 'invalid-item-state', actual: String(item.state) });
    }
    count[state] += 1;
    count.total += 1;
  }
  return count;
}

/** 按筛选条件过滤（会先校验 filter）；返回新数组，不改入参 */
export function applyFilter<T extends FilterableStation>(
  items: readonly T[],
  filter: BoardFilter = {},
  params: BoardParams = defaultBoardParams(),
): T[] {
  const normalized = normalizeFilter(filter, { keywordMaxLength: params.number(BOARD_PARAM.KEYWORD_MAX_LENGTH) });
  const keyword = normalized.keyword?.toLowerCase();

  return items.filter((item) => {
    if (normalized.campusCode !== undefined && item.campusCode !== normalized.campusCode) return false;
    if (normalized.labCode !== undefined && item.labCode !== normalized.labCode) return false;
    if (normalized.state !== undefined && item.state !== normalized.state) return false;
    if (keyword !== undefined && !matchesKeyword(item, keyword)) return false;
    return true;
  });
}

/** 按状态 / 按实训室 / 按校区统计（输入应先经 `applyFilter`） */
export function statsOf(items: readonly FilterableStation[]): StatsBreakdown {
  const byLab = new Map<string, { stats: GroupStats; items: FilterableStation[] }>();
  const byCampus = new Map<string, { stats: GroupStats; items: FilterableStation[] }>();

  for (const item of items) {
    const labEntry = byLab.get(item.labCode);
    if (labEntry === undefined) {
      byLab.set(item.labCode, {
        stats: { key: item.labCode, campusCode: item.campusCode, count: 0, byState: emptyStateCount() },
        items: [item],
      });
    } else {
      labEntry.items.push(item);
    }

    const campusEntry = byCampus.get(item.campusCode);
    if (campusEntry === undefined) {
      byCampus.set(item.campusCode, {
        stats: { key: item.campusCode, count: 0, byState: emptyStateCount() },
        items: [item],
      });
    } else {
      campusEntry.items.push(item);
    }
  }

  const rename = (map: Map<string, { stats: GroupStats; items: FilterableStation[] }>): GroupStats[] =>
    [...map.values()]
      .map(({ stats, items: group }) => {
        const named = group.find((item) => item.name !== undefined);
        return {
          ...stats,
          count: group.length,
          byState: countByState(group),
          ...(named?.name !== undefined ? { name: named.name } : {}),
        };
      })
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return {
    total: items.length,
    byState: countByState(items),
    byLab: rename(byLab),
    byCampus: rename(byCampus),
  };
}

/** 取某状态的计数（四状态齐全，可直接索引） */
export function stateCountOf(count: StateCount, state: StationState): number {
  return count[state];
}

function matchesKeyword(item: FilterableStation, keyword: string): boolean {
  return (
    item.stationCode.toLowerCase().includes(keyword) ||
    item.labCode.toLowerCase().includes(keyword) ||
    item.campusCode.toLowerCase().includes(keyword) ||
    item.state.toLowerCase().includes(keyword) ||
    (item.name !== undefined && item.name.toLowerCase().includes(keyword))
  );
}
