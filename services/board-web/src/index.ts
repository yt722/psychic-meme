/**
 * `@peripheral/board-web`（S01 实训室与工位看板）公开入口。
 *
 * 数据流：
 *
 * ```
 * 状态源上行 ──► StationProjection（投影） ──► BoardView（三级浏览 / 工位详情）
 *                      │                            ▲
 *                      ├──► CampusCatalog（三级目录，纯结构）
 *                      ├──► HistoryStore（历史状态）
 *                      └──► RealtimeChannel（1Hz 广播 / 6s 兜底 / 重连恢复）
 *                                                  │
 *                                            BoardEventHub（S01.5 SSE 事件流）
 *                                                  │
 *                                            createBoardServer（只读 HTTP）
 * ```
 *
 * **A-02 硬约束**：工位状态只做投影，**绝不由资源池水位（占用数/容量）推导**；
 * 状态的唯一入口是 `StationProjection.applyState`（只认状态源上报的 `state`），
 * 详见 `README.md` §4。
 */

export * from './types.js';
export * from './params.js';
export * from './catalog.js';
export * from './projection.js';
export * from './filter-stats.js';
export * from './history.js';
export * from './board.js';
export * from './realtime.js';
export * from './event-stream.js';
export * from './http.js';
