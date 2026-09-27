/**
 * S01 看板本地启动器（演示/联调用，非生产入口）。
 *
 * 作用：把 `board-web` 的只读 HTTP 服务真正跑起来，并用一份**贴近现场**的
 * 目录与状态数据灌进去，便于人工查看看板长什么样。
 *
 * 用法：
 *   node --import tsx public/serve.ts [端口]
 *
 * 为什么需要它：`board-web` 本体只导出 `createBoardServer`（库形态），
 * 没有任何 `listen` 调用——注入目录与状态源是部署方的事。
 *
 * ⚠️ 本文件是演示装配，不参与 `npm test`，也不改变任何服务行为：
 *    - 目录与状态都是内存中的**造数据**，不连接真实设备；
 *    - 服务层仍是真实的 `createBoardServer`，A-02 守卫照常生效
 *      （想验证的话：向 /report 发一个只带 used/capacity 不带 state 的载荷，会被拒）。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FakeClock } from '@peripheral/core';

import {
  BoardEventHub,
  BoardView,
  CampusCatalog,
  HistoryStore,
  RealtimeChannel,
  StationProjection,
  buildCatalog,
  createBoardParams,
  createBoardServer,
  type StationState,
} from '../src/index.js';

const PORT = Number(process.argv[2] ?? 8731);

/* ------------------------------------------------------------------ 目录种子 */

/** 2 校区 / 4 实训室 / 14 工位 —— 覆盖四状态与报警，便于肉眼核对 */
const SEED = [
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
          { stationCode: 'ST-LAB01-03', name: '装配工位3' },
          { stationCode: 'ST-LAB01-04', name: '装配工位4' },
        ],
      },
      {
        labCode: 'LAB-02',
        labName: '刻码包装实训室',
        stations: [
          { stationCode: 'ST-LAB02-01', name: '刻码工位1' },
          { stationCode: 'ST-LAB02-02', name: '包装工位1' },
          { stationCode: 'ST-LAB02-03', name: '包装工位2' },
        ],
      },
    ],
  },
  {
    campusCode: 'CAMPUS-02',
    campusName: '南校区',
    labs: [
      {
        labCode: 'LAB-03',
        labName: '智能物流实训室',
        stations: [
          { stationCode: 'ST-LAB03-01', name: '物流工位1' },
          { stationCode: 'ST-LAB03-02', name: '物流工位2' },
          { stationCode: 'ST-LAB03-03', name: '物流工位3' },
          { stationCode: 'ST-LAB03-04', name: '物流工位4' },
        ],
      },
      {
        labCode: 'LAB-04',
        labName: '工业机器人实训室',
        stations: [
          { stationCode: 'ST-LAB04-01', name: '机器人工位1' },
          { stationCode: 'ST-LAB04-02', name: '机器人工位2' },
          { stationCode: 'ST-LAB04-03', name: '机器人工位3' },
        ],
      },
    ],
  },
];

/** 各工位初始状态（未列入的工位 = 从未上报 → 展示为离线，这是刻意的） */
const PLAN: Record<string, { state: StationState | 'idle'; sourceKind: 'real' | 'twin' | 'gateway' | 'manual'; alarmCode?: string; alarmLevel?: 'info' | 'warning' | 'fault'; params?: Record<string, number | string | boolean | null> }> = {
  'ST-LAB01-01': { state: 'occupied',    sourceKind: 'real',    params: { spindleSpeed: 4200, coolantTempC: 36.4, cycleTimeSec: 128 } },
  'ST-LAB01-02': { state: 'available',   sourceKind: 'real',    params: { spindleSpeed: 0, coolantTempC: 24.1 } },
  'ST-LAB01-03': { state: 'available',   sourceKind: 'twin',    params: { spindleSpeed: 0, modelLoaded: true } },
  'ST-LAB01-04': { state: 'maintenance', sourceKind: 'manual',  alarmCode: 'MAINT-2001', alarmLevel: 'info', params: { nextServiceDays: 3 } },

  'ST-LAB02-01': { state: 'occupied',    sourceKind: 'real',    params: { laserPowerW: 18, lensTempC: 41.2 } },
  'ST-LAB02-02': { state: 'available',   sourceKind: 'real',    params: { conveyorSpeedMps: 0 } },
  'ST-LAB02-03': { state: 'offline',     sourceKind: 'gateway', alarmCode: 'COMM-3002', alarmLevel: 'fault', params: { lastSeenSec: 412 } },

  'ST-LAB03-01': { state: 'occupied',    sourceKind: 'real',    params: { agvBatteryPct: 78, taskId: 'T-2291' } },
  'ST-LAB03-02': { state: 'available',   sourceKind: 'twin',    params: { agvBatteryPct: 100 } },
  'ST-LAB03-03': { state: 'available',   sourceKind: 'real',    params: { agvBatteryPct: 91 } },
  'ST-LAB03-04': { state: 'maintenance', sourceKind: 'manual',  params: { nextServiceDays: 11 } },

  'ST-LAB04-01': { state: 'occupied',    sourceKind: 'real',    params: { jointTempsC: '32.1/33.4/31.8', programLoaded: 'MAIN' } },
  'ST-LAB04-02': { state: 'available',   sourceKind: 'real',    params: { jointTempsC: '24.0/24.2/23.9', programLoaded: '' } },
  // ST-LAB04-03 刻意不报：验证"未上报 = 离线"而非猜测为可用
};

/* --------------------------------------------------------------- 装配与启动 */

const clock = new FakeClock('2026-10-12T09:00:00+08:00');
const params = createBoardParams();
const catalog: CampusCatalog = buildCatalog(SEED);
const projection = new StationProjection({ catalog, params, clock });
const view = new BoardView({ catalog, projection, clock, params });
const history = new HistoryStore({ params, clock });
const channel = new RealtimeChannel({ params, clock, projection });

for (const [stationCode, plan] of Object.entries(PLAN)) {
  projection.applyState({
    stationCode,
    state: plan.state,
    atMs: clock.now(),
    sourceKind: plan.sourceKind,
    ...(plan.sourceKind === 'manual' ? {} : { sourceId: `${plan.sourceKind}-agent-01` }),
    ...(plan.alarmCode !== undefined ? { alarmCode: plan.alarmCode } : {}),
    ...(plan.alarmLevel !== undefined ? { alarmLevel: plan.alarmLevel } : {}),
    ...(plan.params !== undefined ? { params: plan.params } : {}),
  });
}

const board = createBoardServer({
  view,
  history,
  // S01.5：把实时通道接成 SSE 事件流（页面用原生 EventSource 消费）
  eventStream: new BoardEventHub({
    params,
    clock,
    frames: channel,
    snapshot: () =>
      projection.snapshot().map((record) => ({
        stationCode: record.stationCode,
        state: record.state,
        atMs: record.atMs,
        sourceKind: record.sourceKind,
      })),
  }),
  logger: (rec) => console.log('[board]', JSON.stringify(rec)),
});

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 演示心跳：让 SSE 有东西可推。
 *
 * 只存在于这个演示装配里——真实部署由 S05 上行事件驱动 `projection.applyState`，
 * 看板本身**不产生**状态（A-02）。没有这段，页面就只能看到一次全量快照，
 * 验证不了"状态 ≤5s 上屏 / 断线重连续传"。
 */
const DEMO_STATIONS = ['ST-LAB01-01', 'ST-LAB02-01', 'ST-LAB03-01', 'ST-LAB04-01'] as const;
let demoBeat = 0;
const demoTimer = setInterval(() => {
  const index = demoBeat % DEMO_STATIONS.length;
  demoBeat += 1;
  clock.advance(3000);
  const stationCode = DEMO_STATIONS[index] as string;
  // 按**当前显示态**取反：保证每一拍都产生一次真实迁移（否则通道收不到变更，只能靠兜底全量）
  const next = projection.stateOf(stationCode) === 'occupied' ? 'available' : 'occupied';
  projection.applyState({
    stationCode,
    state: next,
    atMs: clock.now(),
    sourceKind: 'twin',
    sourceId: 'twin-agent-demo',
  });
  channel.tick();
}, 3000);

/** 同源托管 index.html，避免前端跨域与硬编码端口 */
const PAGE_ROUTES = new Set(['/', '/index.html']);

const pageServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;

  if (PAGE_ROUTES.has(path)) {
    try {
      const html = await readFile(join(here, 'index.html'));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(html.byteLength),
      });
      res.end(html);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('读取 index.html 失败：' + String(error));
    }
    return;
  }

  if (path.startsWith('/board/v1')) {
    // 详情页也走 /board/v1/*，这里统一转发到真实的看板 HTTP 处理器
    return board.server.emit('request', req, res);
  }

  // 其余路径交给看板服务，由它按统一错误体回 404
  board.server.emit('request', req, res);
});

pageServer.listen(PORT, '127.0.0.1', () => {
  const size = view.size();
  console.log('');
  console.log('  S01 实训室与工位看板 已启动');
  console.log('  ────────────────────────────────────────────');
  console.log(`  页面      http://127.0.0.1:${PORT}/`);
  console.log(`  接口      http://127.0.0.1:${PORT}/board/v1/tree`);
  console.log(`  事件流    http://127.0.0.1:${PORT}/board/v1/events （SSE，页面已接）`);
  console.log(`  目录      ${size.campuses} 校区 / ${size.labs} 实训室 / ${size.stations} 工位`);
  console.log(`  已投影    ${size.projected} 个工位有状态上报（其余按"未上报"显示离线）`);
  console.log('  ────────────────────────────────────────────');
  console.log('  Ctrl+C 停止');
  console.log('');
});

function shutdown(): void {
  clearInterval(demoTimer);
  channel.dispose();
  pageServer.close(() => {
    void board.close().then(() => process.exit(0));
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
