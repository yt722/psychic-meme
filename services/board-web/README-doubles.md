# 替身登记表 · `@peripheral/board-web`（S01 实训室与工位看板）

> 依据 `contracts/doubles-registry.md` §1（每条替身 6 项，缺一项即视为未登记）与 §2 红线：
> 生产构建**不得**存在未登记替身、演示开关、静态达标数字、随机数据。

---

## 1. 结论

**无外部系统替身**（不直连任何外部系统，仅内存投影，生产由 S05 `device-adapter` 上行驱动）。

**但现有一组注入式替身必须登记**：S01.3 的「工位上下文查询」（任务 / 租约 / 占用人员）。
它的真实实现住在**包外**（平台调度 P08 + S03 连接器），本包只持有接口——
按本册判据，测试里的内联实现即替身，见 §1.1。

本包（S01 看板）**不接触任何外部系统**：

| 可能的替身候选 | 本包的处理 | 是否需要登记 |
|---|---|---|
| 真实设备 / 工业网关（IF-01 数据源） | **不直连**。状态一律由 S05 `device-adapter` 经 `StationProjection.applyState` 注入；本包没有"设备客户端"可替身 | 否（替身属于 S05：`FakeDeviceSource` D-04，已在其登记表内） |
| 平台 P08/P11 等平台接口 | 不调用 | 否 |
| 席位管理器 / 资源池接口 | **不调用**（且设计上禁止用水位推状态，见 README §0） | 否 |
| 数据库 / 消息队列 | 不使用。历史存内存（`HistoryStore`），进程退出即失 | 否（不是"替身"，是没有持久化，见 §3 说明） |
| 系统时钟 | 生产用 core `SystemClock`；**测试**注入 core `FakeClock`（登记号 **D-03**，已在契约 §2 登记） | 否（复用已登记替身，仅测试使用） |
| HTTP 服务 | 真实 `node:http`，测试用 `listen(0)` 真实监听 + `fetch` | 否（真实现，不是替身） |

因此本文件**没有 6 项替身条目**：替身条目的存在前提是"本包替代了某个真实外部接口"，
而本包的全部输入都是**注入的函数/对象**（`StationProjection` / `CampusCatalog` / `Clock` / `BoardParams`），
注入点本身就是生产接口，替换 = 换注入实参，不需要替身层。

---

## 1.1 S01.3 工位上下文查询（新增，2026-09-22）

* **替身名称**：测试内联 `StationContextLookup` 替身（`test/detail-context.test.ts` 中的
  `FULL_CONTEXT` / `broken` / `messy` / `many` 等对象字面量）；实现位置：测试文件内联（无独立模块）。
* **覆盖的真实接口**：
  ```ts
  interface StationContextLookup { contextOf(stationCode: string): StationContextInput; }
  ```
  真实实现＝平台调度 / P08（任务与租约）+ S03 连接器（席位占用与操作者）。
* **输入输出差异**：替身按 `stationCode` 返回固定对象，**允许带原始学号**——
  脱敏由本包在出口处完成（`maskStudentId`），这一分工与真实实现一致，**必须保持**。
  替身还可返回脏数据（空学号、空 `taskId`、缺 `leaseId`）或直接抛错，
  用于验证"脏上下文不产出脏字段"与 `contextSource: 'unavailable'` 降级；
  真实实现有实时性与跨实训室一致性约束，替身都没有。
* **启用环境**：单测与联调。**无缺省实现**：未注入时详情仍可用，
  但 `task`/`lease`/`occupants` 为空且 `contextSource` 为 `not-configured`
  ——本包**不猜**"谁在这个工位"（与 `OccupancyLookup` 同纪律）。
* **替换方法**：`new BoardView({ ..., context })`。
  脱敏、占用人数上限（`PARAM-BOARD-DETAIL-MAX-OCCUPANTS`）、降级标注全部由本包施加，
  替换数据源**不会**改变这些纪律；数据源只提供事实。
* **责任人**：看板泳道（S01）负责人 —— 接口契约与脱敏口径；平台调度/学情服务负责人 ——
  任务与租约数据源；S03 连接器负责人 —— 席位占用与操作者。

---

## 1.2 S01.5 事件流写出口替身（新增，2026-09-22）

* **替身名称**：`FakeSink`（`test/event-stream.test.ts` 内联类）；实现位置：测试文件内联（无独立模块）。
* **覆盖的真实接口**：
  ```ts
  interface EventStreamSink {
    write(chunk: string): boolean;      // false = 下游背压
    onDrain(listener: () => void): void;
    end(): void;
  }
  ```
  真实实现＝`node:http` 的 `ServerResponse`（`res.write` / `res.once('drain')` / `res.end`），
  在 `http.ts` 内联装配，**没有**独立的替身开关。
* **输入输出差异**：替身把写出的 SSE 原文攒在内存里并**可手动开关背压**
  （`blocked = true` 时 `write` 恒返回 `false`，`drain()` 触发解除），
  因此能确定性复现"慢客户端"；真实 `ServerResponse` 的背压由内核 socket 缓冲决定，
  **不可手动制造、也不可复现**。替身不实现超时、不实现 TCP 断开。
* **启用环境**：单测（含真实 `node:http` 端到端用例里**不使用**替身——那几条走真 `ServerResponse`）。
  生产路径**没有**任何替身：`createBoardServer` 的 `eventStream` 未注入时 `/events` 直接 503。
* **替换方法**：`createBoardServer({ ..., eventStream })`；
  单测替换写出口＝给 `BoardEventHub.open(lastEventId, sink)` 传自定义 `EventStreamSink`。
  合并不变量（同工位取最新、全量不降级、丢最旧计数）由 **hub/连接**施加，
  换 sink **不会**改变这些纪律——sink 只负责"写出去"。
* **责任人**：看板泳道（S01）负责人 —— 事件流协议与合并不变量；部署方 —— 反向代理侧
  关闭该路径的响应缓冲（本包已发 `x-accel-buffering: no`，但不能替代理决定）。

---

## 2. 数据链路（"谁提供状态"写清楚）

```
真机/孪生/网关/人工
      │  IF-01 上行（sourceId 鉴权、observedAt 采样时间）
      ▼
S05 device-adapter（真连接的归属方；其替身 D-04 已登记在其表格中）
      │  注入调用：
      ▼
StationProjection.applyState({ stationCode, state, atMs, sourceKind, params?, alarmCode? })
      │  ← 这是本包唯一的状态入口；**没有任何水位字段参与**
      ▼
BoardView / HistoryStore / RealtimeChannel ──► createBoardServer ──► 看板前端
```

生产接入方式：把 S05 的出站事件接到 `projection.applyState`（或 `realtime.publish`）；
**不需要改本包任何代码**，只需改装配处的注入实参。

---

## 3. 生产红线自检

| 检查项 | 结论 |
|---|---|
| 含演示开关（`DEMO_MODE` / `demoMode` / `FAKE_PASS` 等） | 否 |
| 含静态达标数字（`staticScore = 90` 之类） | 否：统计与状态全部由注入数据推导，无任何预置结果 |
| 含随机数据 | 否：本包不生成数据（无 `Math.random`，单测亦断言不得出现） |
| 未登记替身 | 无：本包无外部替身（见 §1） |
| 是否会把模拟数据当真实数据展示 | 不自行判定：`sourceKind` 如实区分 `real`/`twin`/`gateway`/`manual` 并带人话标签（`PARAM-BOARD-SOURCE-LABEL-*`）；"哪些模拟数据进入统计"属平台/统计侧口径（S02 `provenance` 负责），本包不替它决定 |
| 是否用水位推状态（A-02） | 否：运行期拒绝"只给水位不给状态"的载荷，静态源码审计禁止水位算术写法（见 README §0、`test/states.test.ts`） |

---

## 4. 已知的"非替身"缺口（不影响验收，但联调需知）

| 缺口 | 现状 | 影响 | 替换/补齐方式 |
|---|---|---|---|
| 历史不持久化 | `HistoryStore` 仅内存，保留窗口 `PARAM-BOARD-HISTORY-KEEP`（默认 24h）、条数上限 20000 | 进程重启后历史为空；无法跨重启查询 | 换 `HistoryStore` 实现（同 `append/query` 语义）；生产建议落平台/时序库 |
| 目录来源于种子/配置 | `CampusCatalog` 由调用方逐条录入（`buildCatalog` 仅便捷构造） | 目录权威源在校方资产台账 | 由部署配置或管理接口灌入；新增校区/实训室**只改配置不改代码**（A-16） |
| 无鉴权 | HTTP 层只读、无鉴权 | 内网看板可接受；公网需前置网关 | 由 S08 网关或反向代理统一鉴权；本包不引入令牌概念 |
| 无背压/限流 | 帧下发为内存队列，backlog 有上限（超限丢最旧并计数） | 极端断线场景会丢中间增量（但重连超窗会强制全量） | 需要接入压时由网关限流（`PARAM-RATE-*` 归 S08） |

以上均**不是替身**（没有"替代真实接口"的行为差异），故不进入 6 项登记表；
如需把它们纳入台帐，请按平台"依赖到位状态"表（`doubles-registry.md` §3）登记，而不是替身表。

---

## 5. 置换验收清单（真机源接入时执行）

1. S05 出站事件驱动 `projection.applyState`，跑通 45 个既有单测（改为对拍：注入源 vs 真机源同一时间窗状态一致）。
2. `sourceKind` 如实区分真机/孪生；报警来源为模拟的数据由平台侧统计排除（本包只如实透出）。
3. `updatedAt` 等于设备采样时间（`observedAt`），不是服务端兜底时间；从未上报仍为 `null`。
4. 判离线/判在线按 `PARAM-OFFLINE-JUDGE` / `PARAM-ONLINE-JUDGE` 在真机上复测一次（拔网线 → 判离线 → 复电 → 满窗口恢复）。
5. 断线恢复复测：窗口内（≤ `PARAM-RECONNECT-RESTORE`）不丢订阅且补齐变更；超窗全量刷新且 `degraded` 留痕。
6. 复核 A-02：真机源给的数据里即使带 `used/capacity`，看板状态也只随 `state` 变化。
