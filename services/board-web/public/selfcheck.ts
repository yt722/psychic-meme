/**
 * S01 关键纪律自查（人工核对用，不进 npm test）。
 *
 * 验证两件事：
 * 1. A-02：只带资源池水位、不带 state 的载荷必须被拒（且理由是显式的）；
 * 2. 未上报的工位必须显示 offline（数据缺席），而不是 available（猜测）。
 */

import { FakeClock } from '@peripheral/core';
import {
  BoardView,
  CampusCatalog,
  StationProjection,
  buildCatalog,
  createBoardParams,
} from '../src/index.js';

const clock = new FakeClock('2026-10-12T09:00:00+08:00');
const params = createBoardParams();
const catalog: CampusCatalog = buildCatalog([
  {
    campusCode: 'CAMPUS-01',
    campusName: '主校区',
    labs: [{ labCode: 'LAB-01', labName: '智能装配实训室', stations: [{ stationCode: 'ST-LAB01-01', name: '装配工位1' }] }],
  },
]);
const projection = new StationProjection({ catalog, params, clock });
const view = new BoardView({ catalog, projection, clock, params });

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('\n【1】A-02 守卫：用资源池水位推状态必须被拒');

// 只带水位、不带 state —— 正是"想用 used>=capacity 推状态"的写法
const poolLevelPayload = {
  stationCode: 'ST-LAB01-01',
  atMs: clock.now(),
  sourceKind: 'real' as const,
  used: 4,
  capacity: 4,
  occupancy: 1,
} as unknown as Parameters<typeof projection.applyState>[0];

try {
  projection.applyState(poolLevelPayload);
  check('水位载荷被拒', false, '竟然通过了！');
} catch (error) {
  const e = error as { errorCode?: string; details?: Record<string, unknown> };
  check('水位载荷被拒', e.errorCode === 'GEN-1001', `errorCode=${e.errorCode}`);
  check(
    '拒绝理由显式（可据此定位）',
    JSON.stringify(e.details ?? {}).includes('state-required-not-derived-from-pool-level'),
    JSON.stringify(e.details ?? {}),
  );
}

// 带电水位字段但同时带 state —— 应当放行（不当违规拦下）
try {
  projection.applyState({
    stationCode: 'ST-LAB01-01',
    state: 'occupied',
    atMs: clock.now(),
    sourceKind: 'real',
    used: 4,
    capacity: 4,
  } as unknown as Parameters<typeof projection.applyState>[0]);
  check('带 state 时附带水位字段放行', true);
} catch (error) {
  check('带 state 时附带水位字段放行', false, String(error));
}

console.log('\n【2】未上报 = offline（数据缺席），不是 available（猜测）');

const catalog2: CampusCatalog = buildCatalog([
  {
    campusCode: 'CAMPUS-01',
    campusName: '主校区',
    labs: [
      {
        labCode: 'LAB-01',
        labName: '智能装配实训室',
        stations: [
          { stationCode: 'ST-LAB01-01', name: '装配工位1' },
          { stationCode: 'ST-LAB01-02', name: '装配工位2' },
        ],
      },
    ],
  },
]);
const projection2 = new StationProjection({ catalog: catalog2, params, clock });
const view2 = new BoardView({ catalog: catalog2, projection: projection2, clock, params });

projection2.applyState({ stationCode: 'ST-LAB01-01', state: 'occupied', atMs: clock.now(), sourceKind: 'real' });

const detail1 = view2.stationDetail('ST-LAB01-01');
const detail2 = view2.stationDetail('ST-LAB01-02');

check('已上报工位显示真实状态', detail1.state === 'occupied', `state=${detail1.state}`);
check('未上报工位显示 offline', detail2.state === 'offline', `state=${detail2.state}`);
check('未上报工位无 updatedAt（不编造时间）', detail2.updatedAt === null, `updatedAt=${detail2.updatedAt}`);
check(
  '未上报工位来源标注为"无状态源数据"',
  detail2.sourceLabel === '无状态源数据',
  `sourceLabel=${detail2.sourceLabel}`,
);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
