/**
 * S01.1 三级浏览用例：目录结构、每级统计、编码校验、筛选。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GEN, errors } from '@peripheral/core';

import {
  CampusCatalog,
  buildCatalog,
  type StationBoardNode,
} from '../src/index.js';
import { CATALOG_SEED, isBadRequest, makeRig, reportAll, reportState } from './helpers.js';

test('目录三级结构：2 校区 / 3 实训室 / 9 工位，且工位与实训室互相可查', () => {
  const { catalog, close } = makeRig();
  try {
    assert.deepEqual(catalog.size(), { campuses: 2, labs: 3, stations: 9 });

    const tree = catalog.tree();
    assert.deepEqual(
      tree.map((campus) => campus.campusCode),
      ['CAMPUS-01', 'CAMPUS-02'],
    );
    assert.deepEqual(
      tree[0]?.labs.map((lab) => lab.labCode),
      ['LAB-01', 'LAB-02'],
    );
    assert.equal(tree[0]?.labs[0]?.stations.length, 4);
    assert.equal(tree[1]?.labs[0]?.stations.length, 2);

    // 工位 → 实训室 → 校区 双向可查（不靠字符串硬拼）
    assert.equal(catalog.labOfStation('ST-LAB03-02').labCode, 'LAB-03');
    assert.equal(catalog.campusCodeOfStation('ST-LAB03-02'), 'CAMPUS-02');
    assert.deepEqual(
      catalog.stationsOfLab('LAB-02').map((station) => station.stationCode),
      ['ST-LAB02-01', 'ST-LAB02-02', 'ST-LAB02-03'],
    );
    assert.equal(catalog.metaOfStation('ST-LAB01-01')?.['name'], '装配工位1');
  } finally {
    close();
  }
});

test('非法编码一律抛 GEN-1001；重复添加抛错而不是静默忽略', () => {
  const catalog = new CampusCatalog();
  catalog.addCampus('CAMPUS-01', '主校区');

  // 非法：编号位数不对 / 小写 / 中文
  assert.throws(() => catalog.addCampus('CAMPUS-1', '短编号'), isBadRequest);
  assert.throws(() => catalog.addCampus('campus-01', '小写'), isBadRequest);
  assert.throws(() => catalog.addLab('CAMPUS-01', 'LAB-1', '位数不对'), isBadRequest);
  assert.throws(() => catalog.addLab('CAMPUS-09', 'LAB-01', '校区不存在'), isBadRequest);
  assert.throws(() => catalog.addLab('CAMPUS-01', 'LAB-01', '  '), isBadRequest);

  catalog.addLab('CAMPUS-01', 'LAB-01', '智能装配实训室');
  catalog.addStation('LAB-01', 'ST-LAB01-01');

  // 重复
  assert.throws(() => catalog.addCampus('CAMPUS-01', '重复校区'), isBadRequest);
  assert.throws(() => catalog.addLab('CAMPUS-01', 'LAB-01', '重复实训室'), isBadRequest);
  assert.throws(() => catalog.addStation('LAB-01', 'ST-LAB01-01'), isBadRequest);

  // 工位编码的实训室段必须与所属实训室一致（否则看板聚合与权限前缀会对不上）
  assert.throws(() => catalog.addStation('LAB-01', 'ST-LAB02-01'), (error: unknown) => {
    assert.ok(isBadRequest(error));
    assert.equal(
      (error as { details?: Record<string, unknown> }).details?.['reason'],
      'station-lab-mismatch',
    );
    return true;
  });
  assert.throws(() => catalog.addStation('LAB-09', 'ST-LAB09-01'), isBadRequest);

  // 错误分类与错误码符合 core 契约
  const thrown = (() => {
    try {
      catalog.addCampus('CAMPUS-1', 'x');
    } catch (error) {
      return error;
    }
    return undefined;
  })();
  assert.equal((thrown as { errorCode?: string }).errorCode, GEN.badRequest);
  assert.equal((thrown as { errorClass?: string }).errorClass, 'lease-invalid');
  assert.equal((thrown as { retryable?: boolean }).retryable, false);
  assert.ok(errors.badRequest({}).message.length > 0);
});

test('三级浏览每级带统计：总数与四状态数与实际上报一致', () => {
  const rig = makeRig();
  try {
    const { view, close } = rig;
    reportAll(rig, ['ST-LAB01-01', 'ST-LAB01-02'], 'occupied');
    reportAll(rig, ['ST-LAB01-03'], 'maintenance');
    reportAll(rig, ['ST-LAB02-01'], 'available');
    reportState(rig, 'ST-LAB03-01', 'available');
    // ST-LAB01-04 / ST-LAB02-02 / ST-LAB02-03 / ST-LAB03-02 从未上报 → offline

    const browse = view.browse();

    assert.equal(browse.stats.total, 9);
    assert.deepEqual(browse.stats, {
      total: 9,
      available: 2,
      occupied: 2,
      maintenance: 1,
      offline: 4,
    });

    const campus1 = browse.campuses.find((campus) => campus.campusCode === 'CAMPUS-01');
    assert.ok(campus1 !== undefined);
    assert.equal(campus1.stats.total, 7);
    assert.equal(campus1.stats.occupied, 2);
    assert.equal(campus1.stats.maintenance, 1);
    assert.equal(campus1.stats.available, 1);
    assert.equal(campus1.stats.offline, 3);

    const lab01 = campus1.labs.find((lab) => lab.labCode === 'LAB-01');
    assert.ok(lab01 !== undefined);
    assert.deepEqual(lab01.stats, { total: 4, available: 0, occupied: 2, maintenance: 1, offline: 1 });

    const lab02 = campus1.labs.find((lab) => lab.labCode === 'LAB-02');
    assert.ok(lab02 !== undefined);
    assert.deepEqual(lab02.stats, { total: 3, available: 1, occupied: 0, maintenance: 0, offline: 2 });

    const campus2 = browse.campuses.find((campus) => campus.campusCode === 'CAMPUS-02');
    assert.ok(campus2 !== undefined);
    assert.deepEqual(campus2.stats, { total: 2, available: 1, occupied: 0, maintenance: 0, offline: 1 });

    // 工位节点带着"状态更新时间"与来源标签（看板渲染直接可用）
    const station = lab01.stations.find((node) => node.stationCode === 'ST-LAB01-01');
    assert.ok(station !== undefined);
    assert.equal(station.state, 'occupied');
    assert.equal(station.name, '装配工位1');
    assert.equal(station.sourceLabel, '真机');
  } finally {
    rig.close();
  }
});

test('按校区 / 实训室 / 关键词筛选：命中保留，点名的空实训室仍可见', () => {
  const rig = makeRig();
  try {
    const { view, close } = rig;
    reportAll(rig, ['ST-LAB01-01'], 'occupied');

    const campus2 = view.browse({ campusCode: 'CAMPUS-02' });
    assert.deepEqual(
      campus2.campuses.map((campus) => campus.campusCode),
      ['CAMPUS-02'],
    );
    assert.equal(campus2.stats.total, 2);

    const lab01 = view.browse({ labCode: 'LAB-01' });
    assert.equal(lab01.campuses.length, 1);
    assert.deepEqual(
      lab01.campuses[0]?.labs.map((lab) => lab.labCode),
      ['LAB-01'],
    );
    assert.equal(lab01.stats.total, 4);

    // 点名 LAB-02 且筛 maintenance → 空列表但实训室本身仍返回（前端不会"跳走"）
    const empty = view.browse({ labCode: 'LAB-02', state: 'maintenance' });
    const lab02 = empty.campuses[0]?.labs[0];
    assert.equal(lab02?.labCode, 'LAB-02');
    assert.deepEqual(lab02?.stations, []);
    assert.equal(empty.stats.total, 0);

    // 关键词命中工位名称（大小写不敏感）
    const byKeyword = view.stations({ keyword: '物流工位1' });
    assert.deepEqual(byKeyword.map((node: StationBoardNode) => node.stationCode), ['ST-LAB03-01']);

    const byCodeKeyword = view.stations({ keyword: 'st-lab02-02' });
    assert.deepEqual(byCodeKeyword.map((node) => node.stationCode), ['ST-LAB02-02']);
  } finally {
    rig.close();
  }
});

test('从未上报的工位展示为 offline（数据缺席），且不出现在投影快照里', () => {
  const rig = makeRig();
  try {
    const { view, projection, close } = rig;

    assert.deepEqual(projection.snapshot(), []);
    assert.equal(projection.stateOf('ST-LAB01-04'), 'offline');

    const node = view.stations({ keyword: 'ST-LAB02-03' })[0];
    assert.ok(node !== undefined);
    assert.equal(node.state, 'offline');
    assert.equal(node.updatedAt, null);
    assert.equal(node.atMs, null);
    assert.equal(node.sourceKind, null);
    assert.equal(node.sourceLabel, '无状态源数据');
    assert.deepEqual(node.params, {});
  } finally {
    rig.close();
  }
});

test('目录可空：没有任何校区时 browse 返回空树而不是报错', () => {
  const catalog = new CampusCatalog();
  const built = buildCatalog([]);
  assert.deepEqual(catalog.tree(), []);
  assert.deepEqual(built.size(), { campuses: 0, labs: 0, stations: 0 });
  assert.deepEqual(CATALOG_SEED.length, 2);
});
