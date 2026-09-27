/**
 * 校区 → 实训室 → 工位 三级目录（S01.1）。
 *
 * 依据：`contracts/coding-spec.md` §1/§2（已冻结）。
 *
 * 编码规则（**用 core 校验，不在本包重写正则**）：
 *
 * | 层级 | 格式 | 例 |
 * |---|---|---|
 * | 校区 | `CAMPUS-<2位>` | `CAMPUS-01` |
 * | 实训室 | `LAB-<2位>` | `LAB-01` |
 * | 工位 | `ST-LAB<2位>-<2位>` | `ST-LAB01-07` |
 *
 * 两条本包额外收紧的纪律（都是编码规范的直接推论）：
 * 1. 工位编码的实训室段必须与其所属实训室一致（`ST-LAB01-xx` 只能挂在 `LAB-01` 下），
 *    否则"看板聚合"与"权限前缀绑定"会与 `stationCode` 对不上。
 * 2. **实训室编号全局唯一**（不是"校区内唯一"）：工位编码只由实训室**编号**派生
 *    （`LAB-01` → `ST-LAB01-`），而工位编码**全校唯一**；若两个校区都有 `LAB-01`，
 *    它们的工位编码空间会重叠。此处按"更严的一方"落地，冲突已登记待契约裁决。
 *
 * 本文件是**纯结构**目录，不含任何工位状态：状态一律来自 `StationProjection`。
 */

import {
  errors,
  isValidCampusCode,
  isValidLabCode,
  isValidStationCode,
  labCodeOfStation,
  stationPrefixOf,
} from '@peripheral/core';

import type { CampusNode, KnownStations, LabNode, StationMeta, StationNode } from './types.js';

interface CampusEntry {
  campusCode: string;
  name: string;
  /** 保持插入顺序，看板按录入顺序渲染 */
  labs: string[];
}

interface LabEntry {
  labCode: string;
  campusCode: string;
  name: string;
  stations: string[];
}

interface StationEntry {
  stationCode: string;
  labCode: string;
  name?: string;
  meta: StationMeta;
}

/** 目录规模（诊断用） */
export interface CatalogSize {
  campuses: number;
  labs: number;
  stations: number;
}

export class CampusCatalog implements KnownStations {
  readonly #campuses = new Map<string, CampusEntry>();
  readonly #labs = new Map<string, LabEntry>();
  readonly #stations = new Map<string, StationEntry>();

  /* ------------------------------------------------------------ 校区 */

  /** 新增校区；编码非法或重复一律抛错（重复添加**不静默忽略**） */
  addCampus(campusCode: string, name: string): CampusNode {
    if (!isValidCampusCode(campusCode)) {
      throw errors.badRequest({ field: 'campusCode', expected: 'CAMPUS-<2位>', actual: campusCode });
    }
    if (this.#campuses.has(campusCode)) {
      throw errors.badRequest({ reason: 'duplicate-campus', campusCode });
    }
    const campusName = requireName(name, 'campusName');
    this.#campuses.set(campusCode, { campusCode, name: campusName, labs: [] });
    return { campusCode, name: campusName, labs: [] };
  }

  /* ---------------------------------------------------------- 实训室 */

  /** 新增实训室（须先有校区）；编码非法 / 校区不存在 / 编号重复一律抛错 */
  addLab(campusCode: string, labCode: string, name: string): LabNode {
    if (!isValidCampusCode(campusCode)) {
      throw errors.badRequest({ field: 'campusCode', expected: 'CAMPUS-<2位>', actual: campusCode });
    }
    const campus = this.#campuses.get(campusCode);
    if (campus === undefined) {
      throw errors.badRequest({ reason: 'unknown-campus', campusCode });
    }
    if (!isValidLabCode(labCode)) {
      throw errors.badRequest({ field: 'labCode', expected: 'LAB-<2位>', actual: labCode });
    }
    if (this.#labs.has(labCode)) {
      throw errors.badRequest({ reason: 'duplicate-lab', labCode });
    }
    const labName = requireName(name, 'labName');
    this.#labs.set(labCode, { labCode, campusCode, name: labName, stations: [] });
    campus.labs.push(labCode);
    return { labCode, campusCode, name: labName, stations: [] };
  }

  /* ------------------------------------------------------------ 工位 */

  /**
   * 新增工位（须先有实训室）。
   *
   * 非法工位编码 / 未知实训室 / 编码前缀与实训室不符 / 重复工位 → 抛错。
   */
  addStation(labCode: string, stationCode: string, meta: StationMeta = {}): StationNode {
    if (!isValidLabCode(labCode)) {
      throw errors.badRequest({ field: 'labCode', expected: 'LAB-<2位>', actual: labCode });
    }
    const lab = this.#labs.get(labCode);
    if (lab === undefined) {
      throw errors.badRequest({ reason: 'unknown-lab', labCode });
    }
    if (!isValidStationCode(stationCode)) {
      throw errors.badRequest({ field: 'stationCode', expected: 'ST-LAB<2位>-<2位>', actual: stationCode });
    }
    const prefix = stationPrefixOf(labCode);
    if (!stationCode.startsWith(prefix)) {
      throw errors.badRequest({
        reason: 'station-lab-mismatch',
        stationCode,
        labCode,
        expectedPrefix: prefix,
      });
    }
    if (this.#stations.has(stationCode)) {
      throw errors.badRequest({ reason: 'duplicate-station', stationCode });
    }

    const name = typeof meta['name'] === 'string' && meta['name'].trim() !== '' ? String(meta['name']) : undefined;
    const entry: StationEntry = {
      stationCode,
      labCode,
      meta: { ...meta },
      ...(name !== undefined ? { name } : {}),
    };
    this.#stations.set(stationCode, entry);
    lab.stations.push(stationCode);

    return {
      stationCode,
      labCode,
      meta: { ...meta },
      ...(name !== undefined ? { name } : {}),
    };
  }

  /* ------------------------------------------------------------ 查询 */

  /** 三级结构（纯目录，无状态） */
  tree(): CampusNode[] {
    return [...this.#campuses.values()].map((campus) => ({
      campusCode: campus.campusCode,
      name: campus.name,
      labs: campus.labs.map((labCode) => this.#labNode(labCode)),
    }));
  }

  /** 某实训室下的工位（非法编码 / 未知实训室抛错） */
  stationsOfLab(labCode: string): StationNode[] {
    if (!isValidLabCode(labCode)) {
      throw errors.badRequest({ field: 'labCode', expected: 'LAB-<2位>', actual: labCode });
    }
    const lab = this.#labs.get(labCode);
    if (lab === undefined) {
      throw errors.badRequest({ reason: 'unknown-lab', labCode });
    }
    return lab.stations.map((stationCode) => this.#stationNode(stationCode));
  }

  /** 工位所属实训室（非法编码 / 未知工位抛错） */
  labOfStation(stationCode: string): LabNode {
    if (!isValidStationCode(stationCode)) {
      throw errors.badRequest({ field: 'stationCode', expected: 'ST-LAB<2位>-<2位>', actual: stationCode });
    }
    const entry = this.#stations.get(stationCode);
    if (entry === undefined) {
      throw errors.badRequest({ reason: 'unknown-station', stationCode });
    }
    return this.#labNode(entry.labCode);
  }

  /** 实训室所属校区（非法编码 / 未知实训室抛错） */
  campusOfLab(labCode: string): CampusNode {
    if (!isValidLabCode(labCode)) {
      throw errors.badRequest({ field: 'labCode', expected: 'LAB-<2位>', actual: labCode });
    }
    const entry = this.#labs.get(labCode);
    if (entry === undefined) {
      throw errors.badRequest({ reason: 'unknown-lab', labCode });
    }
    return this.#campusNode(entry.campusCode);
  }

  /** 工位所属校区编码；未登记返回 undefined（供历史条目补全，不抛错） */
  campusCodeOfStation(stationCode: string): string | undefined {
    const entry = this.#stations.get(stationCode);
    if (entry === undefined) return undefined;
    return this.#labs.get(entry.labCode)?.campusCode;
  }

  /** 工位元数据（未登记返回 undefined） */
  metaOfStation(stationCode: string): StationMeta | undefined {
    const entry = this.#stations.get(stationCode);
    return entry === undefined ? undefined : { ...entry.meta };
  }

  /** 由工位编码推导实训室编码（**不查目录**，纯编码运算，用于拒绝脏数据前的快速校验） */
  static labCodeOf(stationCode: string): string {
    return labCodeOfStation(stationCode);
  }

  hasCampus(campusCode: string): boolean {
    return this.#campuses.has(campusCode);
  }

  hasLab(labCode: string): boolean {
    return this.#labs.has(labCode);
  }

  hasStation(stationCode: string): boolean {
    return this.#stations.has(stationCode);
  }

  /** 全部工位编码（插入顺序） */
  stationCodes(): string[] {
    return [...this.#stations.keys()];
  }

  /** 全部实训室编码（插入顺序） */
  labCodes(): string[] {
    return [...this.#labs.keys()];
  }

  /** 全部校区编码（插入顺序） */
  campusCodes(): string[] {
    return [...this.#campuses.keys()];
  }

  size(): CatalogSize {
    return { campuses: this.#campuses.size, labs: this.#labs.size, stations: this.#stations.size };
  }

  /* ------------------------------------------------------------ 内部 */

  #labNode(labCode: string): LabNode {
    const entry = this.#labs.get(labCode);
    /* c8 ignore next 3 -- 调用前均已校验 */
    if (entry === undefined) {
      throw errors.badRequest({ reason: 'unknown-lab', labCode });
    }
    return {
      labCode: entry.labCode,
      campusCode: entry.campusCode,
      name: entry.name,
      stations: entry.stations.map((stationCode) => this.#stationNode(stationCode)),
    };
  }

  #stationNode(stationCode: string): StationNode {
    const entry = this.#stations.get(stationCode);
    /* c8 ignore next 3 -- 调用前均已校验 */
    if (entry === undefined) {
      throw errors.badRequest({ reason: 'unknown-station', stationCode });
    }
    return {
      stationCode: entry.stationCode,
      labCode: entry.labCode,
      meta: { ...entry.meta },
      ...(entry.name !== undefined ? { name: entry.name } : {}),
    };
  }

  #campusNode(campusCode: string): CampusNode {
    const entry = this.#campuses.get(campusCode);
    /* c8 ignore next 3 -- 调用前均已校验 */
    if (entry === undefined) {
      throw errors.badRequest({ reason: 'unknown-campus', campusCode });
    }
    return {
      campusCode: entry.campusCode,
      name: entry.name,
      labs: entry.labs.map((labCode) => this.#labNode(labCode)),
    };
  }
}

/** 名称必填且非空：留空会让看板出现"无名实训室"，比直接拒更糟 */
function requireName(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw errors.badRequest({ field, reason: 'name-required' });
  }
  return value.trim();
}

/**
 * 便捷构造：一次性录入 `{campus, labs:[{lab, stations:[...]}]}` 形态的目录。
 * 仅用于测试与种子数据；线上目录由配置/管理接口逐条录入。
 */
export function buildCatalog(
  seed: Array<{
    campusCode: string;
    campusName: string;
    labs: Array<{ labCode: string; labName: string; stations: Array<{ stationCode: string; name?: string }> }>;
  }>,
): CampusCatalog {
  const catalog = new CampusCatalog();
  for (const campus of seed) {
    catalog.addCampus(campus.campusCode, campus.campusName);
    for (const lab of campus.labs) {
      catalog.addLab(campus.campusCode, lab.labCode, lab.labName);
      for (const station of lab.stations) {
        catalog.addStation(lab.labCode, station.stationCode, station.name !== undefined ? { name: station.name } : {});
      }
    }
  }
  return catalog;
}
