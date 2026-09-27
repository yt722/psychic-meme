# S01 实训室与工位看板 · `@peripheral/board-web`（人读简版）

> 这个服务干什么：**把设备上行来的工位状态，原样搬到看板上**——
> 三级浏览（校区 → 实训室 → 工位）、四状态、工位详情、1Hz 实时刷新、断线恢复、筛选统计与历史查询。
>
> 模型详版（含判定顺序、边界与不变量）：见 `README-model.md`。

---

## 0. 一条最重要的纪律（验收项 A-02）

**工位状态只做投影，绝不由资源池水位（占用数 / 容量）推导。**

| 该做 | 不该做 |
|---|---|
| 状态源（真机/孪生/网关/人工）报 `occupied`，看板显示占用 | 算 `used >= capacity` 得出"占用" |
| 超过判离线窗口没有新数据 → 显示 `offline` | 池子满了就认为所有工位都占用 |
| 具体状态一律来自 `applyState({ state })` | 任何"按占用率反推状态"的代码 |

数据流：

```
状态源上行 ──► StationProjection（投影：四状态 + 判离线/判在线）
                     │
                     ├──► CampusCatalog（三级目录，纯结构，不含状态）
                     ├──► BoardView（三级浏览 / 工位详情 / 统计）
                     ├──► HistoryStore（历史状态）
                     └──► RealtimeChannel（1Hz 广播 / 6s 兜底 / 重连恢复）
                                     │
                              createBoardServer（只读 HTTP，给前端）
```

**生产环境**：真实状态由 S05 `device-adapter` 从 IF-01 上行驱动；本包只提供投影与展示，
不直连设备、不写任何设备参数（见 `README-doubles.md`）。

---

## 1. 接口清单

### 1.1 目录 `catalog.ts`

| 方法 | 说明 |
|---|---|
| `addCampus(code, name)` | 新增校区（`CAMPUS-<2位>`） |
| `addLab(campusCode, labCode, name)` | 新增实训室（`LAB-<2位>`） |
| `addStation(labCode, stationCode, meta)` | 新增工位（`ST-LAB<2位>-<2位>`） |
| `tree()` | 三级结构（纯目录） |
| `stationsOfLab(labCode)` / `labOfStation(stationCode)` / `campusOfLab(labCode)` | 双向查询 |
| `hasCampus/hasLab/hasStation`、`stationCodes/labCodes/campusCodes`、`size()` | 存在性与规模 |
| `buildCatalog(seed)` | 种子数据便捷构造（测试/初始化） |

### 1.2 状态投影 `projection.ts`

| 方法 | 说明 |
|---|---|
| `applyState(input)` | **状态唯一入口**：`{stationCode,state,atMs,sourceKind,sourceId?,params?,alarmCode?,alarmLevel?}` |
| `stateOf(code)` / `recordOf(code)` / `snapshot()` | 展示态 / 完整记录 / 全量快照 |
| `subscribe(listener)` | 订阅状态迁移（返回退订函数） |
| `evaluate(nowMs?)` | 推进判离线（幂等；读路径会惰性调用） |
| `stats()` / `clear()` | 诊断 / 重置 |

### 1.3 看板视图 `board.ts`

| 方法 | 说明 |
|---|---|
| `browse(filter?)` | 三级浏览，每级带 `{total, available, occupied, maintenance, offline}` |
| `stationDetail(stationCode)` | §3.4.4 的 6 个必需字段 + 报警码 |
| `stations(filter?)` / `allStations()` | 扁平工位列表 |
| `stats(filter?)` | 按状态 / 按实训室 / 按校区分布 |
| `size()` | 目录规模与已投影工位数 |

### 1.4 实时通道 `realtime.ts`

| 方法 | 说明 |
|---|---|
| `publish(delta)` | 记录变更（断线时进缓冲） |
| `tick(nowMs?)` | 按节奏返回本次要下发的帧（无内容返回 `undefined`） |
| `poll(nowMs?)` | 立即全量拉一帧 |
| `shouldFallback(nowMs)` | 广播是否已断层（距上次成功广播 ≥ 兜底周期） |
| `disconnect(atMs)` / `reconnect(atMs)` | 断线 / 重连（窗口内不丢订阅并补发；超窗 `degraded` + 强制全量） |
| `subscribe(listener)` / `stats()` / `intervalMs()` | 订阅与诊断 |

### 1.5 筛选统计与历史 `filter-stats.ts` / `history.ts`

| 方法 | 说明 |
|---|---|
| `normalizeFilter(filter, options?)` | 校验并规范化（非法编码/状态/超长关键词抛 `GEN-1001`） |
| `applyFilter(items, filter, params?)` | 按校区/实训室/状态/关键词筛选 |
| `statsOf(items)` / `countByState(items)` / `emptyStateCount()` | 统计（四状态永远齐全） |
| `HistoryStore.append(input)` | 追加历史（保留窗口 + 条数上限，超限清理） |
| `HistoryStore.query({stationCode?,fromMs?,toMs?,limit?})` | **升序**返回；`limit` 取最新 N 条 |
| `HistoryStore.listener()` | 直接接给 `projection.subscribe`，迁移自动落历史 |

### 1.6 HTTP `http.ts`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/board/v1/tree` | 三级浏览 + 统计（支持 `campusCode/state/keyword`） |
| GET | `/board/v1/labs/:labCode` | 实训室工位 + 统计 |
| GET | `/board/v1/stations/:stationCode` | 工位详情（6 必需字段） |
| GET | `/board/v1/stations/:stationCode/history` | 历史（`fromMs/toMs/limit`） |
| GET | `/board/v1/stats` | 分布统计 |
| GET | `/board/v1/events` | **S01.5 现场状态上屏**：SSE 长连接（`text/event-stream`） |
| GET | `/board/v1/health` | 健康（只读，含事件流诊断） |

- 成功响应统一 `{ ok: true, serverTime, ... }`，`serverTime` 为东八区 ISO-8601；
- 失败统一走 `ServiceError.toResponse`（`ok:false / errorClass / errorCode / retryable / serverTime`）；
- **只读**：任何非 GET 一律 405，没有写路由。格式非法 → 400，格式合法但目录没有 → 404。

### 1.7 事件流 `event-stream.ts`（S01.5）

前端**不轮询**：`GET /board/v1/events` 是一条 SSE 长连接，浏览器用原生 `EventSource` 消费。

| 事件 | 何时发 | 载荷要点 |
|---|---|---|
| （`retry:` 行） | 每次连接首行 | 重连退避提示，来自 `PARAM-BOARD-EVENT-STREAM-RETRY` |
| `hello` | 连接建立 | `serverTime / sequence / resumed / replayed` |
| `snapshot` | 新连接、或续传失败时 | `full:true` + 全部工位当前状态（前端首屏不必再打一次 HTTP） |
| `state` | 有状态变化（1Hz 广播节奏） | `id` = 帧序号；`changes[]`；`merged` = 本次被合并掉的条数 |
| `notice` | 续传被拒（`Last-Event-ID` 过旧 / 未知 / 超前） | `reason / requestedId / oldestId / latestId`——**明确告知，不静默丢事件** |
| （`: keepalive`） | 空闲超 `PARAM-BOARD-EVENT-STREAM-KEEPALIVE` | 注释行，**不推进 `Last-Event-ID`** |

- **≤5s 上屏**：投影迁移 → 1Hz 广播 → 连接写出，端到端时延在单测里有界断言（实测 0ms 量级）；
- **不丢订阅**：断连清的是连接，不是通道订阅；重连后订阅数不变；
- **不丢事件**：`Last-Event-ID` 落在续传窗口内 → 逐帧补发；落在窗口外 → `notice` + 整体全量重发；
- **背压合并**：慢客户端只留**每工位最新**状态（旧帧丢掉并计数 `merged`/`droppedChanges`），内存不随客户端变慢而增长；
- **能力未注入 / 连接满** → 503（`event-stream-not-configured` / `event-stream-full`），不假装推流。

**现场可眼见地验证**（演示装配 `public/serve.ts`，非生产入口）：

```bash
cd peripheral/services/board-web && node --import tsx public/serve.ts 8799
curl.exe -sN http://127.0.0.1:8799/board/v1/events            # retry + hello + snapshot + 每 3s 一条 state
curl.exe -sN -H "Last-Event-ID: 3" http://127.0.0.1:8799/board/v1/events   # hello.resumed=true + 逐帧补发，无 notice
```

演示装配里另有一个"演示心跳"（每 3s 让一个工位真实迁移一次），只为让 SSE 有东西可推；
真实部署由 S05 上行事件驱动，看板本身不产生状态（A-02）。

---

## 2. 参数清单

铁律：**代码里不写数值**。所有数值只有一个出处。

### 2.1 本包专有参数（`LocalParams`，编号一律 `PARAM-BOARD-*`）

| 编号 | 默认值 | 用途 |
|---|---|---|
| `PARAM-BOARD-HISTORY-KEEP` | 24h | 历史状态保留窗口 |
| `PARAM-BOARD-HISTORY-MAX-ENTRIES` | 20000 | 历史条数上限（超限丢最旧） |
| `PARAM-BOARD-HISTORY-DEFAULT-LIMIT` | 200 | 历史查询默认条数 |
| `PARAM-BOARD-HISTORY-MAX-LIMIT` | 5000 | 历史查询单次最大条数（超限即拒） |
| `PARAM-BOARD-RECONNECT-BACKLOG-MAX` | 5000 | 断线期间缓冲变更上限（超限丢最旧并计数） |
| `PARAM-BOARD-KEYWORD-MAX-LENGTH` | 64 | 关键词最大长度 |
| `PARAM-BOARD-EVENT-STREAM-RETRY` | 3000 | SSE `retry:` 重连退避提示（ms） |
| `PARAM-BOARD-EVENT-STREAM-KEEPALIVE` | 15000 | SSE 空闲保活周期（ms） |
| `PARAM-BOARD-EVENT-STREAM-REPLAY-MAX` | 512 | 续传环形缓冲帧数（`Last-Event-ID` 补发窗口） |
| `PARAM-BOARD-EVENT-STREAM-COALESCE-MAX` | 512 | 单连接待下发工位数上限（超出丢最旧并计数） |
| `PARAM-BOARD-EVENT-STREAM-MAX-CONNECTIONS` | 64 | SSE 并发连接上限（超出即拒，保护看板） |
| `PARAM-BOARD-SOURCE-LABEL-REAL` | 真机 | 来源标签 |
| `PARAM-BOARD-SOURCE-LABEL-TWIN` | 数字孪生 | 来源标签 |
| `PARAM-BOARD-SOURCE-LABEL-GATEWAY` | 工业网关 | 来源标签 |
| `PARAM-BOARD-SOURCE-LABEL-MANUAL` | 人工录入 | 来源标签 |

### 2.2 引用的契约参数（core `ParamRegistry`，说明书 §11）

| 编号 | 默认值 | 本包怎么用 |
|---|---|---|
| `PARAM-OFFLINE-JUDGE` | 2 min | 连续无新状态超此即展示 `offline` |
| `PARAM-ONLINE-JUDGE` | 1 min | 判离线后需持续上报满此才恢复 |
| `PARAM-MAP-BROADCAST` | 1（**Hz**） | 广播周期 = `1000/值` ms（换算只在这一处） |
| `PARAM-MAP-FALLBACK` | 6 s（ms） | 广播断层时全量拉取周期 |
| `PARAM-RECONNECT-RESTORE` | 10 s | 断线恢复窗口；超窗 `degraded` + 强制全量 |
| `PARAM-MAP-RECONCILE` | 5 min | 只暴露读取入口；实际对账归 S05，避免两处口径 |

> 覆盖方式：`createBoardParams({ core: {...}, own: {...} })`；启动期自检（`createBoardParams`）
> 会校验这些参数存在且为正数，缺参/非法即刻失败，而不是运行到判离线那一刻才炸。

---

## 3. 四状态与判离线口径

| 状态 | 含义 | 来源 |
|---|---|---|
| `available` | 空闲可上课（契约设备的 `idle` 归一化为此） | 状态源 |
| `occupied` | 占用中 | 状态源 |
| `maintenance` | 维修中 | 状态源 |
| `offline` | 不可用/失联 | ① 状态源明确上报；② 静默超 `PARAM-OFFLINE-JUDGE` 判出；③ 从未上报（数据缺席） |

- 判离线后**不会**因为一条上报就恢复：必须持续上报累计满 `PARAM-ONLINE-JUDGE`；恢复期内再次静默则重新计时。
- 判出的 `offline` 与设备自报的 `offline` 分开记账（`judgedOffline`），恢复时回到"设备自己报的状态"，不做推测。
- 判离线是**惰性**判定：`stateOf/snapshot/recordOf` 会顺带推进，因此"看板显示"与"推送事件"永远一致。

---

## 4. 自检结论（在本包目录内执行）

```bash
cd peripheral/services/board-web
npx tsc -p tsconfig.test.json   # 通过：0 error（strict + NodeNext + noUncheckedIndexedAccess）
npm test                        # 通过：64 个用例，64 pass / 0 fail
```

| 用例文件 | 用例数 | 覆盖 |
|---|---|---|
| `browse.test.ts` | 6 | 三级结构、每级统计、编码校验、筛选、空目录 |
| `states.test.ts` | 8 | 四状态、拒绝脏数据、判离线、判在线、恢复计时、**A-02 水位不推状态（含源码静态审计）**、订阅 |
| `detail.test.ts` | 6 | 6 必需字段、来源可区分、报警、无数据、参数合并、未知工位 |
| `detail-context.test.ts` | 8 | S01.3 上下文三项、**原始学号绝不进响应**、数据源报错不 500 且标注 `unavailable`、未注入标注 `not-configured`、占用人数上限、脏上下文、字段清单、未知工位仍拒 |
| `refresh.test.ts` | 6 | 1Hz 广播、6s 兜底、参数化节拍、不重不漏、投影接线 |
| `reconnect.test.ts` | 5 | 窗口内不丢订阅 + 补发、超窗 degraded + 全量、缓冲上限、幂等、投影联动 |
| `filter-stats.test.ts` | 8 | 四维筛选、非法编码、三种分布、历史窗口/limit/接线 |
| `http.test.ts` | 6 | 5 个端点、serverTime、400/404/405、筛选参数、日志白名单 |
| `event-stream.test.ts` | 11 | **S01.5**：SSE 编码与 `Last-Event-ID` 解析、首屏 retry+hello+snapshot、≤5s 上屏、窗口内逐帧补发且不丢订阅、过旧/超前/未知一律 notice+全量、慢客户端背压合并与全量不降级、队列上限丢最旧计数、心跳不推进 id、真实 server 端到端、连接满 503 |

---

## 5. 生产装配入口（SP-3A：`src/production.ts`）

`createProductionBoard(config)` 按本包的数据流把真实组件装起来，并返回 `dispose()` 做装配级收尾：

```ts
const board = createProductionBoard({
  catalog,          // CampusCatalog（线上目录由配置/管理接口录入后注入；buildCatalog 只用于种子数据）
  params,           // 缺省 createBoardParams()（含启动期自检：依赖的契约参数必须存在且为正数）
  context,          // 工位上下文（任务/租约/占用人员）；不注入即 not-configured
  logger,           // 结构化日志出口（字段已过 core filterLogFields 白名单）
  clock,            // 缺省 core SystemClock
});
// board = { params, clock, catalog, projection, history, realtime, eventStream, view, server, dispose }
```

接线顺序：`StationProjection` →（订阅迁移事件）`HistoryStore`、`RealtimeChannel` → `BoardEventHub`
→ `BoardView` → `createBoardServer`。边界：

1. **目录与工位上下文必须注入**：本包不猜结构、也不猜"谁在这个工位"；
2. **本入口不调 `listen()`**：绑定端口与优雅关停属部署层，便于先自检再放行；
3. 本服务**没有 `productionMode`**：只读服务，没有模拟数据入口可关（工程证据：
   `verification/production-graph.test.ts` 对本入口断言"闭包内不得出现 `productionMode: true` 这类半接线开关"）。

构建期证据：本入口生产闭包 21 个模块，**替身引用位 0 处**。

---

## 6. 已知取舍（待现场/平台确认）

1. **实训室编号按"全校唯一"落地**：工位编码只由实训室编号派生，而工位编码全校唯一；
   若允许两个校区都用 `LAB-01`，工位编码空间会重叠。已按更严的一方实现，冲突待契约裁决。
2. **从未上报 = `offline`**：宁可显示"不可用"也不猜成"空闲"。若产品希望显示"未知"，
   需要新增第五态——那属于契约变更，不在本包自行扩态。
3. **历史 `limit` 取最新 N 条**（返回仍升序）：看板历史面板要的是"最近现场"，不是"最早 N 条"。
4. **`PARAM-MAP-RECONCILE` 只提供读取**：对账执行与偏差告警归 S05，避免两处对账口径不一致。

---

## 7. 工位上下文（S01.3，现场接入新增）

S01.3 要求"工位详情、任务、租约及脱敏占用人员展示"。接入前本包只有状态源带来的 6 个必需字段
（`REQUIRED_DETAIL_FIELDS`），任务 / 租约 / 占用人员**在源码里找不到实现**（计划 §3.2）。

新增一个**注入式端口**（无缺省实现，与 `OccupancyLookup` 同纪律）：

```ts
interface StationContextLookup { contextOf(stationCode: string): StationContextInput; }
```

`stationDetail()` 输出新增四项：`task`、`lease`、`occupants`、`contextSource`。

| 纪律 | 说明 |
|---|---|
| **脱敏在出口做** | 数据源**允许给原始学号**，本包一律 `maskStudentId` 后才输出。详情响应会被前端缓存、被截图、被浏览器历史留存——原始学号绝不进去（用例断言整份响应里不含原始学号） |
| **"没有人" ≠ "查不到"** | `contextSource: 'ok' \| 'unavailable' \| 'not-configured'`。缺了它，页面会把数据源故障渲染成"工位空着" |
| **数据源报错不拖垮详情** | 抛错时 `contextSource: 'unavailable'`，状态字段照常返回——状态才是看板的核心 |
| **占用人数有界** | 上限 `PARAM-BOARD-DETAIL-MAX-OCCUPANTS`（默认 20），防异常数据源把响应撑大 |
| **脏数据不产出脏字段** | 空学号跳过、空 `taskId`/`leaseId` 视为"无任务/无租约"、缺 `expiresAtMs` 记 `null` |

字段清单分两张：`REQUIRED_DETAIL_FIELDS`（说明书 §3.4.4 的 6 项）与
`S01_3_CONTEXT_FIELDS`（`task`/`lease`/`occupants`）。**刻意不合并**——两者来源不同：
前者唯一来源是状态源投影，后者来自平台调度与 S03 连接器，可以"查不到"。
`http.ts` 无需改动：原样返回 `view.stationDetail(...)`，新字段自动流到 `/stations/:code`。

---

## 8. 多工位真机总览页（部署层启动器）

```bash
cd peripheral/services/board-web
node --import tsx public/site-live.ts 8731
```

| 入口 | 内容 |
|---|---|
| `/` | **正式看板**（默认口径）：三级浏览 + 筛选统计 + SSE |
| `/site`（旧链接 `/station1` 等价） | 真机总览：**每工位一块**（工位状态卡 + 7 单元表 + 设备参数卡 + 报警列表） |
| `/site/data.json`（`/station1/data.json` 兼容旧形状） | 按工位分组的真机快照：工位状态 / 7 单元 / 设备参数 / 报警 |
| `/board/v1/*` | 标准数据接口与 SSE |

**LAB-01 四个工位**（工位1/3/4 同在 `192.168.0.0/24`，工位2 在 `192.168.1.0/24`）：

| 工位 | 编码 | 网段 | 台账 | 站点配置参数 |
|---|---|---|---|---|
| 工位1 | `ST-LAB01-01` | `192.168.0` | `config/station1-identity.json` | `--subnet=` / `--identity=` |
| 工位2 | `ST-LAB01-02` | `192.168.1` | `config/station2-identity.json` | `--subnet2=` / `--identity2=` |
| 工位3 | `ST-LAB01-03` | `192.168.0` | `config/station3-identity.json` | `--subnet3=` / `--identity3=` |
| 工位4 | `ST-LAB01-04` | `192.168.0` | `config/station4-identity.json` | `--subnet4=` / `--identity4=` |

**LAB-05 工业机器人应用技术实训室（ABB）**（2026-09-23 接入，共 12 个工位，**逐个接线实测后逐个接入**）：

| 工位 | 编码 | 网段 | 台账 | 站点配置参数 |
|---|---|---|---|---|
| 工位2 | `ST-LAB05-02` | `192.168.101` | `config/abb-station02-identity.json` | `--abb-subnet=` / `--abb-identity02=` |

> ⚠️ **"12 个工位"不等于"12 个工位都在采"**：本室目前**只接入 1 个**（上表）。
> 其余 11 个工位出现在目录与 `/site/data.json` 的 `pendingLab` 里，`collector: false` 如实标注——
> **既不是"空闲"，也不是"在采但没采到设备"**。看板按 `collectorStations` / `stations[].collector` 换词，
> 不靠"有没有数据"去猜（`campuses[].labs[]` 里 `stationCount` 与 `collectorStations` 是两个字段，就是这个原因）。

工位清单由 `site-live.ts` 的 `STATIONS`（LAB-01）与 `ABB_STATIONS`（LAB-05，第二个实训室）给出，
二者合成 `ALL_STATIONS` 跑采集（**配置/数组驱动**）：加一个工位 = 加一条数组项 + 一组 CLI 参数；
采集、桥接、聚合、页面渲染都不需要改。

**两室的差别只有三处，且全部由数据给出**（不是散落的分支判断）：

| # | 差别 | 载体 |
|---|---|---|
| 1 | 本室网段 | `StationSpec.subnet` |
| 2 | 本室来源标识（决定 S07 授权前缀 `ST-LAB01-` / `ST-LAB05-`）与跨工位编码 | `LAB_REGISTRY` |
| 3 | 本室单元清单（LAB-01 是 7 个功能单元，**LAB-05 是 6 个执行模块**） | `UNIT_BASE` / `ABB_UNIT_BASE` |

> ⚠️ 第 3 条最容易做错：LAB-05 的旋转供料/立体仓库/变位机/行走轴/RFID/自定义数据与 LAB-01 的
> 总控/执行/仓储/加工/打磨/分拣/检测**不是同一套划分**，硬套会在看板上出现"本室根本没有的单元"。
> **「复用做法」不等于「照抄内容」**。
>
> 另：工位编码归属的实训室若不在 `LAB_REGISTRY` 里，`labOfStation()` **直接抛错**——
> 不兜底成 LAB-01（兜底会把 LAB-05 的报警盖上 LAB-01 的授权前缀，S07 只会说"越权"，极难定位）。

**三条现场纪律**（页面与数据接口都遵守）：

1. **同网段 ⇒ 归属只能靠 MAC**：一次采集看到别工位的设备是正常的，进「待处理（unmapped）」如实列出，
   **不静默丢弃**；不属于本工位的设备**绝不写进台账**（写进去会污染该工位状态聚合）。
2. **单网口 ⇒ 一次只有一个工位在线**：未接线的工位显示「未上报 = 不可用（offline）」，
   **绝不显示成"空闲"**；本页不推工位级 offline 的条件（采集失败 / 网段未覆盖）也在页面上写明。
3. **单元状态只认证据**：7 个功能单元里**只有归属有证据的单元才套设备状态**，其余如实写「归属未确认」
   （工位1 目前只有"分拣单元"有 LLDP 邻居链证据；工位3/工位4 **暂无一条单元级归属证据**）。

### 8.1「未上报」≠「离线」（2026-09-22 现场修正）

| 情形 | 看板状态 | 页面文案 | `updatedAt` |
|---|---|---|---|
| 状态源从未上报 | `offline` | **未上报**（无数据） | `null` |
| 曾有上报、之后停更 | `offline`（判离线窗口判出） | 离线 | 有值 |
| 本轮观测到设备 | `available`/`occupied`/`maintenance` | 空闲/占用/维护 | 有值 |

**修的是什么**：`device-collector` 在"本轮一个设备都没匹配上台账"时会**自己**下发一条
`status=offline` 的**空 MAC 上报**——那是**数据缺席推断**（"本轮什么都没看到"），
是**设备侧**判离线，不是工位在线状态。`site-live.ts` 早先把这条上报照单全收地聚合成工位状态，
后果有两条：① 网线拔掉/未接线时工位被推到"当前时刻的 offline"，**抢在 `PARAM-OFFLINE-JUDGE`
判离线窗口之前**下结论；② 「从未上报」与「曾上报后不可用」在前端**分不开**。
现在 `bridgeStation` **只在"本轮确实匹配到设备"时才推状态**，两个问题同时消失。

> ⚠️ 这不等于"工位永远不显示不可用"：有过上报的工位停更 → 由看板的判离线窗口判出 `offline`
> （`updatedAt` 有值）；从未上报的工位 → 由看板 `recordOf` 缺省给出 `offline + updatedAt=null`
> （数据缺席即不可用）。**恰好是"不推"才让这两者可分**，二者都不显示成 `available`。
> 口径随 `/site/data.json` 的 `conventions` 字段一起下发，前端不必猜。

### 8.2 已知缺口（如实登记，不绕过）

| 缺口 | 影响 | 现状 |
|---|---|---|
| `plugins/netdev-discovery/scripts/scan.ps1` **不产出 `coverage` 字段** | `cycle.offlineSuppressed` 在真实数据路径上**恒为 false** ⇒ "网段未覆盖 → 抑制 offline 推断"这条红线**在该路径不触发**（`coverage` 判定在 DSH 插件 Host 层，不在脚本里） | 未修（改脚本不属本包）。本页**不掩饰**：`/site/data.json` 与页面上如实回传每轮的 `coverage` / `offlineSuppressed`，并在 `conventions.coverageGap` 里写明 |
