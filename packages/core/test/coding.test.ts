import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isValidCampusCode,
  isValidLabCode,
  isValidStationCode,
  isValidVirtualUnitCode,
  isValidResourcePoolId,
  isValidCode,
  stationPrefixOf,
  labCodeOfStation,
  poolKindOf,
  makePoolId,
  type CodeKind,
} from '../src/index.js';

describe('coding: 合法编码', () => {
  it('校区编码', () => {
    assert.equal(isValidCampusCode('CAMPUS-01'), true);
    assert.equal(isValidCampusCode('CAMPUS-99'), true);
  });

  it('实训室编码', () => {
    assert.equal(isValidLabCode('LAB-01'), true);
    assert.equal(isValidLabCode('LAB-12'), true);
  });

  it('工位编码（全校唯一）', () => {
    assert.equal(isValidStationCode('ST-LAB01-07'), true);
    assert.equal(isValidStationCode('ST-LAB12-99'), true);
  });

  it('虚拟调试单元编码', () => {
    assert.equal(isValidVirtualUnitCode('VU-001'), true);
    assert.equal(isValidVirtualUnitCode('VU-030'), true);
  });

  it('资源池编码（三类）', () => {
    assert.equal(isValidResourcePoolId('RP-SEAT-LAB01'), true);
    assert.equal(isValidResourcePoolId('RP-VU-001'), true);
    assert.equal(isValidResourcePoolId('RP-INST-01'), true);
  });
});

describe('coding: 非法编码必须被拒', () => {
  it('位数不符', () => {
    assert.equal(isValidCampusCode('CAMPUS-1'), false);
    assert.equal(isValidLabCode('LAB-1'), false);
    assert.equal(isValidVirtualUnitCode('VU-01'), false);
  });

  it('小数 / 非数字', () => {
    assert.equal(isValidLabCode('LAB-AB'), false);
    assert.equal(isValidStationCode('ST-LABXX-01'), false);
  });

  it('禁止中文、空格、下划线、全角字符', () => {
    assert.equal(isValidLabCode('LAB-０１'), false); // 全角
    assert.equal(isValidStationCode('ST-LAB01-0１'), false); // 全角
    assert.equal(isValidLabCode('LAB 01'), false); // 空格
    assert.equal(isValidLabCode('LAB_01'), false); // 下划线
    assert.equal(isValidLabCode('实训室-01'), false); // 中文
  });

  it('大小写敏感：统一大写', () => {
    assert.equal(isValidLabCode('lab-01'), false);
    assert.equal(isValidCampusCode('campus-01'), false);
    assert.equal(isValidResourcePoolId('rp-seat-lab01'), false);
  });

  it('资源池类型前缀必须合法', () => {
    assert.equal(isValidResourcePoolId('RP-FOO-01'), false);
    assert.equal(isValidResourcePoolId('RP-SEAT-LAB1'), false); // 位数不足
    assert.equal(isValidResourcePoolId('RP-INST-1'), false);
  });

  it('前后空格导致校验失败（不静默 trim）', () => {
    assert.equal(isValidLabCode(' LAB-01'), false);
    assert.equal(isValidLabCode('LAB-01 '), false);
  });
});

describe('coding: 统一校验入口', () => {
  it('按类型分派到正确的校验器', () => {
    assert.equal(isValidCode('campus', 'CAMPUS-01'), true);
    assert.equal(isValidCode('lab', 'LAB-01'), true);
    assert.equal(isValidCode('station', 'ST-LAB01-07'), true);
    assert.equal(isValidCode('virtualUnit', 'VU-001'), true);
    assert.equal(isValidCode('resourcePool', 'RP-SEAT-LAB01'), true);
  });

  it('类型与编码不匹配时拒绝', () => {
    assert.equal(isValidCode('lab', 'ST-LAB01-07'), false);
    assert.equal(isValidCode('station', 'LAB-01'), false);
  });

  it('穷尽性：未知类型抛错而非静默放行', () => {
    assert.throws(() => isValidCode('unknown' as CodeKind, 'X'), /未处理的编码类型/);
  });
});

describe('coding: 实训室与工位互推', () => {
  it('LAB-01 → ST-LAB01-', () => {
    assert.equal(stationPrefixOf('LAB-01'), 'ST-LAB01-');
    assert.equal(stationPrefixOf('LAB-12'), 'ST-LAB12-');
  });

  it('ST-LAB01-07 → LAB-01', () => {
    assert.equal(labCodeOfStation('ST-LAB01-07'), 'LAB-01');
    assert.equal(labCodeOfStation('ST-LAB12-99'), 'LAB-12');
  });

  it('往返一致', () => {
    for (const lab of ['LAB-01', 'LAB-05', 'LAB-99']) {
      const prefix = stationPrefixOf(lab);
      const station = `${prefix}03`;
      assert.equal(labCodeOfStation(station), lab);
    }
  });

  it('非法输入抛错（不返回兜底值）', () => {
    assert.throws(() => stationPrefixOf('LAB-1'), /非法实训室编码/);
    assert.throws(() => labCodeOfStation('ST-XX-01'), /非法工位编码/);
  });
});

describe('coding: 资源池类型判定', () => {
  it('三类池可区分', () => {
    assert.equal(poolKindOf('RP-SEAT-LAB01'), 'local-seat');
    assert.equal(poolKindOf('RP-VU-001'), 'virtual-session');
    assert.equal(poolKindOf('RP-INST-01'), 'server-instance');
  });

  it('非法池编号抛错', () => {
    assert.throws(() => poolKindOf('RP-XXX-01'), /非法资源池编号/);
  });

  it('makePoolId 与 poolKindOf 往返一致', () => {
    assert.equal(makePoolId('local-seat', 'LAB01'), 'RP-SEAT-LAB01');
    assert.equal(makePoolId('virtual-session', '001'), 'RP-VU-001');
    assert.equal(makePoolId('server-instance', '01'), 'RP-INST-01');

    assert.equal(poolKindOf(makePoolId('local-seat', 'LAB01')), 'local-seat');
    assert.equal(poolKindOf(makePoolId('virtual-session', '001')), 'virtual-session');
    assert.equal(poolKindOf(makePoolId('server-instance', '01')), 'server-instance');
  });
});
