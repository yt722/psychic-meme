/**
 * 编码规范校验（校区 / 实训室 / 工位 / 虚拟调试单元 / 资源池）。
 *
 * 依据：`contracts/coding-spec.md` §1、§2（已冻结）
 *
 * ⚠️ 与说明书 §3.4.1 示例存在格式差异（见 `docs/外围服务开发计划-多智能体并行版-模型版.md` §2.2）：
 *    说明书示例为 `LAB-A01` / `ST-A01-01`，冻结契约为 `LAB-01` / `ST-LAB01-07`。
 *    本实现以**已冻结契约**为准；差异已登记待平台侧裁决。
 */

/** 校区：`CAMPUS-<2位编号>` */
export const CAMPUS_RE = /^CAMPUS-[0-9]{2}$/;
/** 实训室：`LAB-<2位编号>` */
export const LAB_RE = /^LAB-[0-9]{2}$/;
/** 工位：`ST-<实训室码>-<2位序号>`，全校唯一 */
export const STATION_RE = /^ST-LAB[0-9]{2}-[0-9]{2}$/;
/** 虚拟调试单元：`VU-<3位编号>` */
export const VU_RE = /^VU-[0-9]{3}$/;
/** 资源池：`RP-(SEAT-LAB<2位>|VU-<3位>|INST-<2位>)` */
export const POOL_RE = /^RP-(SEAT-LAB[0-9]{2}|VU-[0-9]{3}|INST-[0-9]{2})$/;

export type CodeKind = 'campus' | 'lab' | 'station' | 'virtualUnit' | 'resourcePool';

/** 各类编码是否通过校验 */
export function isValidCampusCode(value: string): boolean {
  return CAMPUS_RE.test(value);
}

export function isValidLabCode(value: string): boolean {
  return LAB_RE.test(value);
}

export function isValidStationCode(value: string): boolean {
  return STATION_RE.test(value);
}

export function isValidVirtualUnitCode(value: string): boolean {
  return VU_RE.test(value);
}

export function isValidResourcePoolId(value: string): boolean {
  return POOL_RE.test(value);
}

/**
 * 统一校验入口。
 *
 * 编码**大小写敏感**（统一大写），**禁止**中文、空格、下划线、全角字符。
 * 校验失败调用方须拒绝并记录，**不得静默丢弃**（`DEV-1001`）。
 */
export function isValidCode(kind: CodeKind, value: string): boolean {
  switch (kind) {
    case 'campus':
      return isValidCampusCode(value);
    case 'lab':
      return isValidLabCode(value);
    case 'station':
      return isValidStationCode(value);
    case 'virtualUnit':
      return isValidVirtualUnitCode(value);
    case 'resourcePool':
      return isValidResourcePoolId(value);
    default: {
      // 穷尽性检查：新增 CodeKind 必须显式处理
      const never: never = kind;
      throw new Error(`isValidCode: 未处理的编码类型 ${String(never)}`);
    }
  }
}

/**
 * 由实训室编码推导工位编码前缀。
 *
 * `LAB-01` → `ST-LAB01-`，用于看板聚合与权限前缀绑定。
 * 编码不规范时抛错，不返回兜底值。
 */
export function stationPrefixOf(labCode: string): string {
  if (!isValidLabCode(labCode)) {
    throw new Error(`stationPrefixOf: 非法实训室编码「${labCode}」`);
  }
  return `ST-LAB${labCode.slice(4)}-`;
}

/**
 * 从工位编码解析实训室编码。
 *
 * `ST-LAB01-07` → `LAB-01`。
 */
export function labCodeOfStation(stationCode: string): string {
  if (!isValidStationCode(stationCode)) {
    throw new Error(`labCodeOfStation: 非法工位编码「${stationCode}」`);
  }
  return `LAB-${stationCode.slice(6, 8)}`;
}

/** 资源池类型 */
export type ResourcePoolKindCode = 'local-seat' | 'virtual-session' | 'server-instance';

/** 由资源池编号判定类型；非法编号抛错 */
export function poolKindOf(poolId: string): ResourcePoolKindCode {
  if (!isValidResourcePoolId(poolId)) {
    throw new Error(`poolKindOf: 非法资源池编号「${poolId}」`);
  }
  if (poolId.startsWith('RP-SEAT-')) return 'local-seat';
  if (poolId.startsWith('RP-VU-')) return 'virtual-session';
  return 'server-instance';
}

/** 构造资源池编号 */
export function makePoolId(kind: ResourcePoolKindCode, code: string): string {
  switch (kind) {
    case 'local-seat':
      return `RP-SEAT-${code}`;
    case 'virtual-session':
      return `RP-VU-${code}`;
    case 'server-instance':
      return `RP-INST-${code}`;
    default: {
      const never: never = kind;
      throw new Error(`makePoolId: 未知资源池类型 ${String(never)}`);
    }
  }
}
