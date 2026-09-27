/**
 * board-web · 生产装配入口（SP-3A）
 * ============================================================
 * S01 是**只读**服务（没有任何写路由），本文件把它的真实组件按数据流装起来：
 *
 * ```
 * CampusCatalog（目录，注入） ─► StationProjection（投影）
 *        │                            ├─► HistoryStore（历史，订阅投影迁移）
 *        └─► BoardView（三级浏览 / 详情）├─► RealtimeChannel（1Hz 广播 / 6s 兜底 / 重连恢复）
 *                                     │           └─► BoardEventHub（SSE 事件流）
 *                                     └────────────► createBoardServer（只读 HTTP）
 * ```
 *
 * ## 边界（如实声明，勿当能力）
 *
 *   - **目录（`CampusCatalog`）由部署层注入**：线上目录由配置/管理接口逐条录入，
 *     `buildCatalog` 是测试/种子数据用的便捷构造，不作为生产来源。
 *   - **工位上下文（任务 / 租约 / 占用人员）由部署层注入**：未注入时详情这三项为
 *     `null`/空且 `contextSource` 为 `not-configured`——本包**不猜**"谁在这个工位"，
 *     也不提供缺省实现（与告警服务的 `OccupancyLookup` 同纪律）。
 *   - **不调 `listen()`**：本入口只组装 `node:http` 服务对象，绑定端口与优雅关停
 *     属部署层；便于先自检再放行。
 *   - 本服务**没有模拟数据开关**（`productionMode` 不存在）：它只做投影，
 *     且投影只认状态源上报的 `state`，不由资源池水位推导（验收项 A-02）。
 *
 * ## 纪律
 *   - 只装配，不新增业务逻辑（状态机、判离线、筛选统计全在组件内）。
 *   - 不读环境变量、不写死数值：数值经 `BoardParams`（`params.ts` 唯一声明处）注入。
 *   - 时钟用 core 的 `SystemClock`（测试替身时钟绝不出现）。
 */

import { SystemClock } from '@peripheral/core';
import type { Clock } from '@peripheral/core';

import { BoardView } from './board.js';
import type { CampusCatalog } from './catalog.js';
import { BoardEventHub } from './event-stream.js';
import { HistoryStore } from './history.js';
import { createBoardServer } from './http.js';
import type { BoardServer } from './http.js';
import { BoardParams, createBoardParams } from './params.js';
import { StationProjection } from './projection.js';
import { RealtimeChannel } from './realtime.js';
import type { StationContextLookup } from './types.js';

/** 生产装配入参：目录与工位上下文必须注入（本包不猜结构，也不猜占用）。 */
export interface ProductionBoardConfig {
  /** 三级目录（结构）：线上由配置/管理接口录入后注入。 */
  catalog: CampusCatalog;
  /** 参数容器；缺省 `createBoardParams()`（含启动期自检：依赖的契约参数必须存在且为正数）。 */
  params?: BoardParams;
  /** 工位上下文（任务 / 租约 / 占用人员）；不注入即 `not-configured`。 */
  context?: StationContextLookup;
  /** 结构化日志出口（字段已过 core `filterLogFields` 白名单）；缺省丢弃。 */
  logger?: (record: Record<string, unknown>) => void;
  /** 可注入时钟；缺省 `SystemClock`。 */
  clock?: Clock;
}

/** 装配结果：组件原样暴露，便于部署层接健康检查与自检。 */
export interface ProductionBoardWiring {
  readonly params: BoardParams;
  readonly clock: Clock;
  readonly catalog: CampusCatalog;
  readonly projection: StationProjection;
  readonly history: HistoryStore;
  readonly realtime: RealtimeChannel;
  readonly eventStream: BoardEventHub;
  readonly view: BoardView;
  readonly server: BoardServer;
  /** 优雅关停：解历史订阅 → 关 HTTP → 释放广播通道（只做装配级收尾，不含业务判定）。 */
  dispose(): Promise<void>;
}

/**
 * 装配生产看板。
 *
 * 失败即抛错（缺目录、参数容器自检不过）：看板宁可不启动，
 * 也不能带着"目录为空"或"缺契约参数"跑起来——那时看板会显示成空园区，
 * 现场会去查网络，而根因在配置。
 */
export function createProductionBoard(config: ProductionBoardConfig): ProductionBoardWiring {
  if (config.catalog === undefined) {
    throw new Error('生产装配必须注入 catalog（线上目录由配置/管理接口录入，本包不猜结构）');
  }

  // 缺省构造带启动期自检：依赖的契约参数不在或非正数时，这里就抛错
  const params = config.params ?? createBoardParams();
  const clock = config.clock ?? new SystemClock();
  const catalog = config.catalog;

  const projection = new StationProjection({ catalog, params, clock });
  const history = new HistoryStore({ params, clock });
  const detachHistory = projection.subscribe(history.listener());
  const realtime = new RealtimeChannel({ params, clock, projection });
  const eventStream = new BoardEventHub({ params, clock, frames: realtime });
  const view = new BoardView({
    catalog,
    projection,
    clock,
    params,
    ...(config.context !== undefined ? { context: config.context } : {}),
  });
  const server = createBoardServer({
    view,
    history,
    eventStream,
    ...(config.logger !== undefined ? { logger: config.logger } : {}),
  });

  return {
    params,
    clock,
    catalog,
    projection,
    history,
    realtime,
    eventStream,
    view,
    server,
    async dispose(): Promise<void> {
      detachHistory();
      realtime.dispose();
      await server.close();
    },
  };
}
