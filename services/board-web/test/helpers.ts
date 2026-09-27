/**
 * 测试夹具（不参与 `npm test` 的用例文件名清单，仅供 7 个用例文件 import）。
 *
 * 固定一份 3 实训室 / 9 工位的目录，所有用例共用，避免每个文件各造一套数据
 * 导致"这个文件里的工位编码和那个文件里不一样"。
 */

import { FakeClock } from '@peripheral/core';

import {
  BoardView,
  CampusCatalog,
  HistoryStore,
  RealtimeChannel,
  StationProjection,
  buildCatalog,
  createBoardParams,
  type BoardParamsOverrides,
  type FrameChange,
  type StationState,
  type StationStateInput,
} from '../src/index.js';

/** 固定起始时刻（东八区），全包统一，便于断言 ISO 字符串 */
export const START_ISO = '2026-10-12T09:00:00+08:00';

/** ISO 断言正则（东八区、秒级） */
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;

/** 目录种子：2 校区 / 3 实训室 / 9 工位 */
export const CATALOG_SEED = [
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
          { stationCode: 'ST-LAB02-01', name: '包装工位1' },
          { stationCode: 'ST-LAB02-02', name: '包装工位2' },
          { stationCode: 'ST-LAB02-03', name: '包装工位3' },
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
        ],
      },
    ],
  },
];

export interface Rig {
  clock: FakeClock;
  params: ReturnType<typeof createBoardParams>;
  catalog: CampusCatalog;
  projection: StationProjection;
  view: BoardView;
  history: HistoryStore;
  channel: RealtimeChannel;
  close: () => void;
}

/** 组装一套完整的看板依赖（FakeClock + 固定目录 + 内存投影） */
export function makeRig(overrides: BoardParamsOverrides = {}, withChannel = true): Rig {
  const clock = new FakeClock(START_ISO);
  const params = createBoardParams(overrides);
  const catalog = buildCatalog(CATALOG_SEED);
  const projection = new StationProjection({ catalog, params, clock });
  const view = new BoardView({ catalog, projection, clock, params });
  const history = new HistoryStore({ params, clock });
  const channel = new RealtimeChannel({ params, clock, projection });
  return {
    clock,
    params,
    catalog,
    projection,
    view,
    history,
    channel,
    close: () => {
      if (withChannel) channel.dispose();
    },
  };
}

/** 用"当前时钟时刻"作为采样时间上报一次状态（测试里最常见的调用） */
export function reportState(
  rig: Pick<Rig, 'projection' | 'clock'>,
  stationCode: string,
  state: StationState | 'idle',
  extra: Partial<Omit<StationStateInput, 'stationCode' | 'state' | 'atMs'>> = {},
): void {
  rig.projection.applyState({
    stationCode,
    state,
    atMs: rig.clock.now(),
    sourceKind: extra.sourceKind ?? 'real',
    ...extra,
  });
}

/** 批量上报同一状态 */
export function reportAll(rig: Pick<Rig, 'projection' | 'clock'>, stationCodes: readonly string[], state: StationState): void {
  for (const stationCode of stationCodes) reportState(rig, stationCode, state);
}

/** 造一条帧变更（实时通道测试用） */
export function change(stationCode: string, state: StationState, atMs: number): FrameChange {
  return { stationCode, state, atMs, sourceKind: 'real' };
}

/** 断言抛出的错误是 `errors.badRequest`（`GEN-1001`） */
export function isBadRequest(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { errorCode?: string }).errorCode === 'GEN-1001'
  );
}
