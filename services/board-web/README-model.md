# `@peripheral/board-web`（S01 实训室与工位看板）· 模型详版

> 面向模型/审查者的实现说明：精确签名、判定顺序、边界条件、不变量、错误码、扩展点与已知冲突。
> 人读简版见 `README.md`；替身登记见 `README-doubles.md`。
>
> 依据：说明书 §3.4（三级看板、§3.4.4 工位详情、FR-MAP-02 四状态）、
> `contracts/coding-spec.md`（编码，已冻结）、`contracts/if-01-device-status.md`（上行契约）、
> `contracts/error-codes.md`（`GEN-*` / `DEV-*`）、`contracts/doubles-registry.md`（替身纪律）。

---

## 1. 模块边界与依赖

```
src/
  types.ts        共享类型 + 入参解析/校验（唯一允许 import core 校验器的地方）
  params.ts       BoardParams 参数门面：契约参数（ParamRegistry）+ 本包参数（LocalParams）
  catalog.ts      三级目录（纯结构，无状态）
  projection.ts   状态投影 + 判离线/判在线 + 订阅（状态的唯一写入点）
  filter-stats.ts 筛选与统计（纯函数）
  history.ts      历史状态（保留窗口 + 条数上限 + 升序查询）
  board.ts        看板视图（结构 × 状态 → 对外字段）
  realtime.ts     1Hz 广播 / 6s 兜底 / 断线重连恢复
  http.ts         只读 HTTP 端点
  production.ts   生产装配入口（SP-3A）：createProductionBoard(cfg)，只接线
  index.ts        `export *` 汇总
```

依赖方向（**单向，无环**）：

```
http → board → { catalog, projection, filter-stats, params }
         ↑
realtime → { projection(可选), params }
history  → { projection(类型), params }
projection → { catalog(仅 KnownStations 接口), params, types }
```

- 各模块之间只传递 `types.ts` 的结构类型；`projection.ts` 只要求注入方实现
  `KnownStations { hasStation(code): boolean; campusCodeOfStation?(code): string|undefined }`，
  因此投影不依赖 `CampusCatalog` 的具体实现（可替换为远程目录代理）。
- 外部依赖仅 `@peripheral/core` 与 Node 内置（`node:http` / `node:test` / `node:assert/strict`）。
  **无第三方依赖**。

---

## 2. 最重要不变量：状态只做投影（A-02）

### 2.1 静态层面

- 状态的写入点**只有** `StationProjection.applyState`，取值**只有** `input.state`；
- 另有两处显式写入，且都不是推导：
  `evaluate()` 中 `state:'offline'`（静默超窗判离线）、`judgedOffline` 记录里的 `state:'offline'`（恢复中保持）；
- 本包**不含**任何 `used/capacity/occupancy` 参与状态判断的分支；
  `test/states.test.ts` 对 `src/*.ts`（去注释后）做正则审计：
  `used\s*[<>]=?\s*capacity`、`capacity\s*-\s*used`、`occupanc(y|e)\s*[<>]=?\s*[\d.]`、
  `occupied\s*[:=]\s*(used|inUse|allocated)`、`available\s*[:=]\s*(capacity|free)`、`occupied\s*\?\?\s*`
  任一命中即失败。

### 2.2 运行期层面

- `assertNoPoolLevelDerivation(input)`：载荷**没有 `state`** 却带
  `POOL_LEVEL_FIELDS = ['used','capacity','usedSeats','capacitySeats','allocated','inUse','occupancy','poolLevel']`
  中任一字段 → `GEN-1001`，`details.reason = 'state-required-not-derived-from-pool-level'`。
  **带 `state` 的载荷即使附带这些字段也不报错**（那是设备方的诊断信息，忽略即可）。
- 投影实例**不暴露**任何名字含 `pool|level|capacity|water|occupanc|used` 的方法（单测对原型做审计）。
- `test/states.test.ts`「A-02：资源池水位变化不改工位状态显示」用例把池子从 `4/4` 改到 `0/4`、`4/0`，
  逐一断言 `stationDetail().state`、`stateOf()`、占用计数**全部不变**；
  反向也断言"池空但设备报占用 → 仍为 occupied"。

---

## 3. 状态机

### 3.1 四状态

`StationState = 'available' | 'occupied' | 'maintenance' | 'offline'`（`STATION_STATES` 为唯一清单）。

契约别名表 `CONTRACT_STATE_ALIASES = { idle: 'available' }`：
IF-01 §1 的设备侧 `idle` 在**入口**归一化，内部与输出只保留展示口径。

### 3.2 记录双态

`StationRecord` 同时保存：

| 字段 | 含义 |
|---|---|
| `state` | **展示态**（判离线后为 `offline`） |
| `upstreamState` | 状态源**最近一次上报**的原始态 |
| `judgedOffline` | 当前 `offline` 是否为"静默判出" |

分离原因：恢复时要回到"设备自己报的状态"，而不是恢复到一个推导/猜测值。

### 3.3 迁移规则（`applyState` 的判定顺序）

1. `assertNoPoolLevelDerivation(input)`（A-02 守卫）；
2. `assertStationCode` → 格式非法 `GEN-1001`；
3. `catalog.hasStation` → 未知工位 `GEN-1001 {reason:'unknown-station'}`（**脏数据不进看板**）；
4. `parseStationState`（接受 `idle`）→ 非法 `GEN-1001`；`parseAtMs` / `parseSourceKind` /
   `parseRealtimeParams`（只允许标量）/ `parseAlarmLevel` / 文本字段同理；
5. 乱序（`atMs < 记录.atMs`）**照样收下**，仅 `outOfOrder += 1` 留痕（不静默丢弃，对齐 IF-01 §4.2 口径）；
   `atMs` 取 `max(旧, 新)`；
6. `params` 合并：`{...旧, ...新}`（"最近已知值"语义：未再上报的键保留）；
7. 若 `judgedOffline === true`（恢复流程）：
   - 若与上一次上报的间隔 `>= PARAM-OFFLINE-JUDGE` → 恢复计时**清零**（断续心跳不算恢复）；
   - 若 `atMs - recoveryStart >= PARAM-ONLINE-JUDGE` → 恢复：`state = upstreamState`，发 `recovered` 事件；
   - 否则展示态仍为 `offline`（但参数/报警/来源仍是最新值）；
8. 否则写记录；`from = 旧展示态 ?? 'offline'`，`from !== to` 时才发 `upstream` 事件
   （"首次上报的起点是无数据=offline"，与 `stateOf` 的读法一致）。

### 3.4 判离线（`evaluate(nowMs?)`，幂等）

- 对每条记录：`now - atMs >= PARAM-OFFLINE-JUDGE`
  - 未判过 → 置 `state:'offline'`、`judgedOffline:true`，发 `no-report` 事件；
  - 已判过 → 删除恢复计时（静默期内再次中断，重新计时）；
- 无迁移时返回 `[]`；重复调用不重复产出；
- `stateOf` / `recordOf` / `snapshot` **惰性调用** `evaluate`，因此读看板与收事件必然一致；
- 从未上报的工位：`stateOf → 'offline'`，但**不产生迁移**（没有"从什么变成什么"）。

### 3.5 事件

```ts
ProjectionEvent { stationCode, from, to, atMs, reason: 'upstream'|'no-report'|'recovered', record }
```

- 监听器异常被隔离（`try/catch` + `stats().listenerErrors` 计数），
  保证"某个订阅者写日志失败"不会拖垮看板读路径（对齐 IF-01 §6 NFR-REL-03 的同源原则）。

---

## 4. 目录（`catalog.ts`）的编码纪律

| 层级 | 校验 | 备注 |
|---|---|---|
| 校区 | core `isValidCampusCode`（`CAMPUS-<2位>`） | 重复 → `GEN-1001 {reason:'duplicate-campus'}` |
| 实训室 | core `isValidLabCode`（`LAB-<2位>`） | 实训室编号**全局唯一**（见 §9.1） |
| 工位 | core `isValidStationCode`（`ST-LAB<2位>-<2位>`） | 前缀必须等于 `stationPrefixOf(labCode)`，否则 `{reason:'station-lab-mismatch'}` |

- 编码一律走 core 校验器，**不在本包重写正则**（避免口径漂移）；
- 名称必填非空（`{reason:'name-required'}`）：留空会产生"无名实训室"，比直接拒更糟；
- 未登记实训室/校区一律拒（`unknown-lab` / `unknown-campus`）；
- 目录是**纯结构**：不持有任何状态，状态一律问 `StationProjection`。

---

## 5. 实时通道（`realtime.ts`）

### 5.1 时间语义（**单位差异只在一处换算**）

| 参数 | 单位 | 换算 |
|---|---|---|
| `PARAM-MAP-BROADCAST` | **Hz** | `broadcastPeriodMs() = 1000 / hz` |
| `PARAM-MAP-FALLBACK` | ms | 直接用 |
| `PARAM-RECONNECT-RESTORE` | ms | 直接用 |
| `PARAM-OFFLINE-JUDGE` / `PARAM-ONLINE-JUDGE` | ms | 直接用 |

`BoardParams.#positive(id)` 保证所有节拍参数为正；非法即抛（`createBoardParams` 启动期自检）。

### 5.2 水位线（watermark）

只有一条水位线 `#lastBroadcastAtMs`（**上次成功下发帧的时刻**），
由广播帧、兜底帧、`poll()`、重连补发帧统一推进。

`shouldFallback(now) := now - #lastBroadcastAtMs >= fallbackMs`

因此"1Hz 广播正常时兜底永不触发；广播断层时兜底立刻接手"——这是**有意的**设计，
避免把"兜底时间"也当成一条独立水位线导致两种节拍互相掩盖。

### 5.3 `tick(nowMs?)` 判定顺序

1. 未连接 → `undefined`（断线期间不下发任何帧）；
2. `shouldFallback` → **全量帧**（`reason:'fallback'`, `full:true`，内容为投影快照）；
3. 距上次广播 ≥ 广播周期**且**待下发队列非空 → **增量帧**（`reason:'broadcast'`, `full:false`）；
4. 否则 `undefined`（**无变更不发空帧**，省带宽）。

全量帧取 `projection.snapshot()`（按 `stationCode` 升序），同时清空待下发队列——全量覆盖增量。

### 5.4 断线 / 重连

| 动作 | 语义 |
|---|---|
| `disconnect(atMs?)` | 幂等：已断开时**不重置**断线时刻（否则恢复窗口会被无限续期）；未下发的增量转入 backlog |
| `reconnect(atMs?)` | 未断线 → `{offlineMs:0, withinWindow:true, degraded:false}` 且**不发帧** |
| 窗口内（`offlineMs <= PARAM-RECONNECT-RESTORE`） | **订阅不丢**；`#pending = [...backlog, ...pending]` 作为补发内容；下发一个 `reason:'reconnect', full:false` 的帧（**可能为空帧**，表示"通道已恢复、无需补发"） |
| 超窗 | 置 `degraded`，下发 `reason:'reconnect', full:true` 的**全量帧**；下发后 `degraded` 清零（留痕在 `result.degraded` / `frame.degraded` / `stats().forcedFullRefreshes`） |

- backlog 上限 `PARAM-BOARD-RECONNECT-BACKLOG-MAX`，超限丢**最旧**并累加 `backlogDropped`；
- 超窗不补发增量（`replayedChanges:0`）：断开太久后本地增量已不可信，必须整体替换；
- 重连帧**返回给调用方**（`result.frame`）并同时推给订阅者。

### 5.5 与投影接线

`new RealtimeChannel({ params, clock, projection })` 会订阅投影，
把 `ProjectionEvent` 通过 `toChange()` 压成 `FrameChange { stationCode, state, atMs, sourceKind }`
进入待下发队列；`dispose()` 解除订阅并清空订阅者。

### 5.6 SSE 事件流（`event-stream.ts`，S01.5 现场上屏）

通道负责"多久产生一帧"，事件流负责"怎么把它送到浏览器"——两层刻意分开，
所以 `/events` 可以在**不改通道**的前提下替换传输方式（SSE / 未来的 WebSocket）。

**为什么不引库**：看板是单向只读，SSE 由浏览器 `EventSource` 原生消费，
自带重连、`retry:` 退避与 `Last-Event-ID` 续传——三个验收项都不需要第三方依赖。

| 概念 | 语义 |
|---|---|
| `EventStreamSink` | 连接抽象（真实实现＝`ServerResponse`）：`write(chunk):boolean` 返回 `false` 即背压 |
| `BoardEventHub` | 中枢：订阅通道、维护环形缓冲、向所有连接广播、汇总诊断 |
| `formatSseMessage` | 编码：`retry:` → `id:` → `event:` → `data:`（字段顺序固定，便于比对） |
| `parseLastEventId` | 只认非负安全整数；乱码/负数一律按"新连接"处理 |

**`Last-Event-ID` 判定表**（`decideResume`，本模块"不静默丢事件"的唯一实现处）：

| 客户端 id | 结论 | 动作 |
|---|---|---|
| 无 | `fresh` | `hello` + `snapshot`（全量） |
| 等于当前序号 | `replay`（0 帧） | 只发 `hello`，无缺口 |
| 在环形缓冲内 | `replay` | **逐帧**补发其后所有帧（`replayed:true`），不合并 |
| 早于缓冲最早帧 | `resync / last-event-id-too-old` | `notice` + 全量 `snapshot`（`degraded:true`） |
| 缓冲为空 | `resync / no-history-yet` | 同上 |
| 大于当前序号 | `resync / last-event-id-ahead` | 同上 |
| 区间内但找不到 | `resync / last-event-id-unknown` | 同上 |

**背压合并**：连接维护 `Map<stationCode, FrameChange>` 待发队列，
同工位**后到覆盖先到**（状态是最新值，不是流水）；一旦 `write` 返回 `false` 即停止灌注，
`drain` 时把合并结果打成**一帧**下发，并带上 `merged`（被合并条数）。
合并批里只要混进过全量帧，下发就**必须**仍是全量——否则前端会停在一个拼不回去的视图上。
队列到达 `PARAM-BOARD-EVENT-STREAM-COALESCE-MAX` 时丢**最旧**的工位并计数（`droppedChanges`），
保证内存不随客户端变慢而增长。

**保活**：空闲超过 `PARAM-BOARD-EVENT-STREAM-KEEPALIVE` 发 `: keepalive` 注释行；
心跳**不产生新序号**，因此重连时的 `Last-Event-ID` 不会被虚高推进。
定时器只在**首个连接打开**时启动、最后一个连接关闭即停，不空转。

**关停**：`board.close()` 会先断所有推流连接再 `server.close()`——
否则长连接会让关停一直等到客户端超时。

---

## 6. 筛选、统计与历史

### 6.1 `normalizeFilter`

- `campusCode` 走 `isValidCampusCode`、`labCode` 走 `isValidLabCode` → 非法 `GEN-1001`（**不静默忽略**）；
- `state` 走 `normalizeStationState`（`idle → available`）；
- `keyword` 去空白，空串丢弃，超长 `PARAM-BOARD-KEYWORD-MAX-LENGTH` → `GEN-1001 {reason:'too-long'}`；
- 返回**新对象**，不修改入参。

`matchesKeyword`：大小写不敏感，匹配 `stationCode | labCode | campusCode | state | name`。

### 6.2 统计

- `countByState` 返回四状态**齐全**的 `StateCount`（缺项补 0），前端可直接照图例渲染；
- 记录里的 `state` 非法 → `GEN-1001 {reason:'invalid-item-state'}`（不信任外部构造的条目）；
- `statsOf` 输出 `{total, byState, byLab, byCampus}`；`byLab/byCampus` 按 key 升序（**确定性输出**）；
- 分组统计的 `count` 之和恒等于 `total`（单测断言）。

### 6.3 历史

| 行为 | 规则 |
|---|---|
| 写入 | `stationCode` / `state` / `atMs` / `sourceKind` 全校验；`labCode` **由工位编码推导**（显式传入必须一致，否则 `{reason:'lab-station-mismatch'}`）；`params` 只允许标量 |
| 排序 | 二分插入保持**升序**（同刻后写者在后） |
| 保留窗口 | `PARAM-BOARD-HISTORY-KEEP`，以**时钟当前时刻**为基准；写入与查询都会触发清理 |
| 条数上限 | `PARAM-BOARD-HISTORY-MAX-ENTRIES`，超限丢最旧 |
| 查询 | `{stationCode?, fromMs?, toMs?, limit?}`；`fromMs > toMs` → `GEN-1001 {reason:'from-after-to'}`；`limit` 必须为正整数且 ≤ `PARAM-BOARD-HISTORY-MAX-LIMIT` |
| `limit` 语义 | 取窗口内**最新** N 条，返回仍**升序**（看板要"最近现场"） |
| 接投影 | `history.listener()` 可直接 `projection.subscribe(...)`；**只记状态迁移**（状态没变时不落历史） |

---

## 7. 看板视图（`board.ts`）

### 7.1 工位详情（说明书 §3.4.4）

`REQUIRED_DETAIL_FIELDS = ['stationCode','labCode','state','updatedAt','sourceKind','params']`，
另加 `campusCode / updatedAtMs / sourceLabel / sourceId? / alarmCode? / alarmLevel? / judgedOffline / name?`。

- `updatedAt = toIso(record.atMs)`；**从未上报 → `null`**（不伪造时间）；
- `sourceKind` 缺失时取 `'manual'` 且 `sourceLabel = '无状态源数据'`（单测同时断言该文案与 `params:{}`）；
- 未知/非法工位 → `GEN-1001 {reason:'unknown-station'}`（HTTP 层映射 404 / 400，见 §8）。

### 7.2 三级浏览

- 每级带 `StateCount`；统计**从投影结果反向数出来**，不会写回状态；
- 筛选后：命中工位保留；**被显式点名的**实训室/校区即使为空也保留
  （否则前端切换筛选后会"丢掉用户点开的实训室"）；
- 从未上报的工位状态为 `offline` 且 `updatedAt/atMs/sourceKind` 为 `null`。

---

## 8. HTTP 层

### 8.1 路由与状态码

| 场景 | 状态码 | 错误码 |
|---|---|---|
| 成功 | 200 | —（`{ok:true, serverTime, ...}`） |
| 方法非 GET | 405 | `GEN-1001 {reason:'method-not-allowed', allowed:'GET'}` |
| 编码/查询参数格式非法 | 400 | `GEN-1001`（`details.field` 指明字段） |
| 格式合法但目录里没有 | 404 | `GEN-1001 {reason:'unknown-lab'\|'unknown-station'\|'route-not-found'}` |
| 路径与查询参数冲突（`/labs/LAB-01?labCode=LAB-02`） | 400 | `GEN-1001 {reason:'path-query-mismatch'}` |
| `/stations/:code/history` 未注入历史存储 | 503 | `GEN-1099 {reason:'history-not-configured'}` |
| `/events` 未注入事件流（`eventStream`） | 503 | `GEN-1099 {reason:'event-stream-not-configured'}` |
| `/events` 并发连接达 `PARAM-BOARD-EVENT-STREAM-MAX-CONNECTIONS` | 503 | `GEN-1099 {reason:'event-stream-full'}`（写响应头**之前**判定，因此仍能给出正确状态码） |
| 其他未预期异常 | 500 | `GEN-1099`（`safeErrorSummary`） |

错误体**一律**由 `ServiceError.toResponse(serverTime, requestId)` 生成，不手工拼装。
响应头含 `content-type: application/json; charset=utf-8`、`cache-control: no-store`。
例外只有 `/events`：成功时是 `text/event-stream` 长连接（`cache-control: no-store, no-transform`
+ `x-accel-buffering: no`），失败（503）时仍是上面的 JSON 错误体——**不假装推流**。

### 8.2 日志

`deps.logger` 收到的是 `filterLogFields(...)`（core 白名单）过滤后的字段：
`requestId / serverTime / ok / action / durationMs / errorClass / errorCode / message / retryable`。
**不记录**请求体、凭据、令牌（单测断言键名不含 `token|ticket|credential|authorization|password`）。

---

## 9. 边界条件与已知冲突

### 9.1 实训室编号全局唯一（**待契约裁决**）

工位编码只由实训室**编号**派生（`LAB-01 → ST-LAB01-`），而工位编码**全校唯一**。
`coding-spec.md` §1 写"实训室编号在**校区内**唯一"，两者在"两个校区都有 `LAB-01`"时会冲突。
本实现取**更严**的一方（全局唯一）并在 `addLab` 抛 `{reason:'duplicate-lab'}`。
若裁决为"校区内唯一"，需要给工位编码引入校区段——那是**编码规范变更**，不得由本包自行改动。
另外 `coding-spec.md` §1 提到 `VU-xxx` 虚拟调试单元编码，本包（S01 看板）不涉及。

### 9.2 其他边界

| 情形 | 行为 | 理由 |
|---|---|---|
| 从未上报的工位 | 展示 `offline`，`updatedAt=null` | 数据缺席即不可用，不猜成"空闲"；若要"未知"态属契约变更 |
| 乱序上行（`atMs` 早于已记） | 收下 + 计数告警，不丢弃 | 对齐 IF-01 §4.2「不能恢复顺序时保留并告警」 |
| 同状态重复上报 | 不产生迁移事件、不落历史 | "变化驱动"语义；参数变化由 `record.params` 承载 |
| 参数键消失 | 保留"最近已知值" | 看板展示需要稳定面板，避免键闪断 |
| 空目录 | 返回空树，不报错 | 加校区/实训室只改配置（A-16：扩容不改代码） |
| 广播无变更 | 不下发空帧 | 省带宽；兜底周期仍会全量对齐 |
| 断线超过 10s | 强制全量刷新（不补增量） | 本地增量已不可信，避免前端停在拼不回去的状态 |

---

## 10. 参数与配置注入

```ts
const params = createBoardParams({
  core: {                                  // 说明书 §11 契约参数（覆盖即生效）
    [PARAM.MAP_BROADCAST]: 2,              // 2 Hz
    [PARAM.MAP_FALLBACK]: 3_000,           // 3 s
    [PARAM.RECONNECT_RESTORE]: 5_000,      // 5 s
    [PARAM.OFFLINE_JUDGE]: 60_000,
    [PARAM.ONLINE_JUDGE]: 30_000,
  },
  own: {                                   // 本包 PARAM-BOARD-*
    [BOARD_PARAM.HISTORY_KEEP]: 6 * 60 * 60 * 1000,
    [BOARD_PARAM.HISTORY_MAX_ENTRIES]: 5_000,
  },
});
```

- 业务代码**只**通过 `BoardParams` 取数（`base/number/text/offlineJudgeMs/...`）；
- `BoardParams.snapshot()` 输出 `{core, own}` 便于诊断（不含任何凭据）；
- 单测覆盖：改 `PARAM-MAP-BROADCAST` → 广播周期随之变化（`intervalMs()` 断言 500ms）；
  非法值（`0` / 负数）→ 构造期即抛。

**生产装配入口（SP-3A，`src/production.ts`）**：`createProductionBoard({ catalog, params?, context?, logger?, clock? })`
按上文依赖方向接线（projection → history / realtime → eventStream → view → createBoardServer），
返回 `{ params, clock, catalog, projection, history, realtime, eventStream, view, server, dispose() }`。
三条边界：①**目录与工位上下文必须注入**（本包不猜结构、不猜占用）；②**不调 `listen()`**（端口绑定与
优雅关停属部署层）；③本服务**没有 `productionMode`**——只读服务没有模拟入口可关，
构建期由 `verification/production-graph.test.ts` 断言闭包内**不得**出现 `productionMode: true` 这类半接线开关。

---

## 11. 测试矩阵（64 个用例）

| 文件 | 用例数 | 关键断言语义 |
|---|---|---|
| `browse.test.ts` | 6 | 结构/双向查询/编码拒绝/每级统计/筛选保留点名节点/空目录 |
| `states.test.ts` | 8 | 四状态读写、脏数据拒绝（编码/状态/时间/来源/参数）、判离线、判在线、恢复清零、**A-02 运行期 + 静态审计**、订阅与异常隔离 |
| `detail.test.ts` | 6 | 6 必需字段全覆盖、真机 vs 孪生可区分、报警可选、无数据 `null`、参数合并、未知工位 |
| `refresh.test.ts` | 6 | 999ms/1000ms 边界、6s 兜底、广播正常时兜底不触发、参数化节拍、不重不漏、投影接线与退订 |
| `reconnect.test.ts` | 5 | 窗口内不丢订阅 + 补发（含断线前待发）、超窗 degraded + 全量、backlog 上限、幂等/无操作、投影联动补发内容 |
| `filter-stats.test.ts` | 8 | 四维筛选与组合、非法编码/状态/超长关键词、三种分布与计数自洽、历史全条件、窗口/上限/limit、投影落库、口径一致 |
| `http.test.ts` | 6 | 5 端点 + health、serverTime、400/404/405 边界、路径-查询冲突、无历史存储 503、日志白名单 |
| `event-stream.test.ts` | 11 | SSE 编码/`Last-Event-ID` 解析、首屏 retry+hello+snapshot、≤5s 上屏、窗口内逐帧补发 + 订阅不减、过旧/超前/未知 → `notice` + 全量、慢客户端背压合并（全量不被降级）、队列上限丢最旧计数、心跳不推进 id、真实 server 端到端首屏/续传/health、连接满 503 |

运行：

```bash
cd peripheral/services/board-web
npx tsc -p tsconfig.test.json   # 0 error
npm test                        # 64 pass / 0 fail
```

> 说明：`npm test` 只跑 `package.json` 里固定的 9 个用例文件；
> `test/helpers.ts` 是共享夹具（固定 2 校区 / 3 实训室 / 9 工位 + `FakeClock`），不单独作为用例文件。

---

## 12. 扩展点（不破坏现有不变量）

| 需求 | 改哪里 | 注意 |
|---|---|---|
| 新增状态来源（如 PLC 直连） | 新增 `SourceKind` 枚举值 + `PARAM-BOARD-SOURCE-LABEL-*` + 归一化入口 | `SourceKind` 是联合类型，需同步 `SOURCE_KINDS` 与标签映射（`sourceLabel` 的 `never` 检查会强制处理） |
| 新增筛选维度 | `BoardFilter` + `normalizeFilter` + `applyFilter` | 必须先校验再使用，禁止静默忽略非法值 |
| 换真实现数据源 | 把 S05 `device-adapter` 的出站事件接到 `projection.applyState` | **不得**在 board-web 内加"按水位补状态"的兜底（A-02） |
| 加持久化历史 | 替换 `HistoryStore` 的实现，保持 `append/query` 语义 | `limit` 语义为"最新 N 条、返回升序"，替换时不得改口径 |
| 加工位级 WebSocket 推送 | 复用 `RealtimeChannel.subscribe` | 帧序号 `sequence` 单调递增，前端据此丢弃乱序帧 |
| 加对账 | 归 S05，本包只用 `params.reconcileMs()` 展示周期 | 防止两处对账口径不一致（IF-01 §6） |

**禁止**：
- 在 `board-web` 内直接读设备/PLC/网关；
- 用资源池水位推导工位状态（A-02）；
- 在业务代码里写 `PARAM-*` 的数值（全部经 `BoardParams`）；
- 自造第二套编码正则（一律用 core 校验器）。

---

## 13. 工位上下文（S01.3，现场接入新增）

| 类型 | 结构 |
|---|---|
| `StationContextLookup` | `contextOf(stationCode): StationContextInput`（**注入式端口，无缺省实现**） |
| `StationContextInput` | `{ task?, lease?, occupants? }`；**允许原始学号**（脱敏由本包做） |
| `StationTaskInfo` | `{ taskId, title?, startedAtMs? }` |
| `StationLeaseInfo` | `{ leaseId, kind, state, expiresAtMs: number \| null, operatorIdMasked? }` |
| `StationOccupant` | `{ userIdMasked, taskId?, sinceMs? }` |
| `ContextSource` | `'ok' \| 'unavailable' \| 'not-configured'` |

`StationDetail` 新增 `task` / `lease` / `occupants` / `contextSource` 四项；
`S01_3_CONTEXT_FIELDS = ['task','lease','occupants']` 与 `REQUIRED_DETAIL_FIELDS` **分开列**
（来源不同：前者来自平台调度与 S03 连接器，可以"查不到"）。

**新增参数**：`PARAM-BOARD-DETAIL-MAX-OCCUPANTS`（默认 20）——工位详情的占用人数展示上限。

**为什么必须有 `contextSource`**：没有它，前端无法区分"这个工位确实没人"与"调度服务挂了"，
会把故障渲染成空闲。这与 A-02 是同一类错误：**不要用缺席当结论**
（状态源缺席显示 `offline` 而不是 `available`，上下文缺席必须标注而不是静默为空）。

**脱敏分工**：数据源给事实（原始学号），出口统一 `maskStudentId`。
与 `alarm-svc` 的 `OccupancyLookup` 同口径；两侧都不允许把原始学号写进对外载荷。

---

## 14. 多工位真机总览页（部署层启动器，**不属于本包运行期闭包**）

`public/` 下的 `site-live.ts` / `site.html` / `station1-live.ts`（一行转发）是**现场部署层**的
真机总览启动器：它把「二层观测 → 真实 DeviceReport → device-adapter 真实 ingest → 本包真实状态 + SSE 上屏」
在一个进程里跑起来。三条与本包有关的边界：

| 边界 | 口径 |
|---|---|
| **不进运行期闭包** | `public/*.ts` 不被 `src/index.ts` 引用，也不在 `src/production.ts` 的依赖闭包内（`verification/production-graph.test.ts` 因此看不到它）；它是**部署脚本**，不是服务代码 |
| **A-02 不被绕过** | 它不直接改看板状态，而是作为**各工位的状态源适配器**把「已观测设备」聚合成一条 `state` 再经 `projection.applyState` 上报——聚合规则写在**状态源侧**（`bridgeStation`），随 `params.aggregation` 一起透出可核对 |
| **单元不是目录节点** | 7 个功能单元（总控/执行/仓储/加工/打磨/分拣/检测）只是工位详情的 `params`（`unitN.name/component/powerPlc/code/state/evidence`），**不是** `ST-LAB01-0N` 这种编码——后者是已废弃的借用口径 |

**工位清单是数组/配置驱动的**：`STATIONS` 每项 = `{ 工位号, 名称, 网段, 台账路径, 7 个单元的归属 }`，
加一个工位只需加一条数组项 + 一组 `--subnetN/--identityN` 参数，采集/桥接/聚合/页面渲染都不动。

| 工位 | 编码 | 网段 | 台账 |
|---|---|---|---|
| 工位1 | `ST-LAB01-01` | `192.168.0` | `config/station1-identity.json` |
| 工位2 | `ST-LAB01-02` | `192.168.1` | `config/station2-identity.json` |
| 工位3 | `ST-LAB01-03` | `192.168.0` | `config/station3-identity.json` |
| 工位4 | `ST-LAB01-04` | `192.168.0` | `config/station4-identity.json` |

⚠️ **工位1/3/4 同网段**（只有工位2 在 `192.168.1.0/24`）⇒ 归属只能靠 MAC：一次采集里看到别工位的设备
是正常现象，它们进 `pending`（待处理）并逐条打印，**不静默丢弃**；不属于本工位的设备**绝不写进台账**。
本机只有一块网口，一次只有一个工位在线；未接线的工位显示「未上报（offline）」，**不得写成"空闲"**。

### 14.1 「不推状态」的判定顺序（本启动器唯一一处会输出工位状态的地方）

`bridgeStation(runtime, cycle)` 的输出只有两种：**推**一条工位状态，或**什么都不推**。
「什么都不推」的四种情形（**都不写"空闲"**）：

| 情形 | 判据 | 为什么不推 |
|---|---|---|
| 本轮无有效抓包窗口 | `cycle.valid === false` | 采集失败 ⇒ "没观测到"只能说明探测不到（纪律 7） |
| 网段未覆盖 | `cycle.offlineSuppressed === true` | 同上；**但见下方缺口：该字段在真实路径上恒为 false** |
| **本轮一个设备都没匹配上台账** | `cycle.observations.length === 0` | 采集器此时会自己下发一条空 MAC 的 `status=offline` 上报（**数据缺席推断**）——它是"设备侧判离线"，不是工位在线状态 |
| 其余无设备轮次 | 同上 | 数据缺席不能推出"工位离线"，更不能推出"工位空闲" |

**第 3 条是本轮修的现场缺陷**（2026-09-22）：早先版本把采集器那条空上报照单全收地聚合，
于是①网线拔掉时工位被推到"当前时刻的 offline"，**抢在 `PARAM-OFFLINE-JUDGE` 判离线窗口之前**；
②「未上报」与「离线」在前端分不开。现在只有"确实匹配到设备"的轮次才推，
两类情形靠 `updatedAt` 区分：`offline + updatedAt=null` = **未上报**；
`offline + updatedAt 有值` = **离线（判离线窗口判出）**。
这不削弱"不可用"的表达：从未上报的工位由看板 `recordOf` 缺省给 `offline`，有过上报的走判离线窗口。

### 14.2 已知缺口（如实登记，不绕过）

`plugins/netdev-discovery/scripts/scan.ps1` **不产出 `coverage` 字段** ⇒
`cycle.offlineSuppressed` 在真实数据路径上**恒为 false**，"网段未覆盖 → 抑制 offline 推断"
这条红线**在该路径不触发**（`coverage` 判定在 DSH 插件 Host 层，不在脚本里）。
本启动器**不掩饰**：`/site/data.json` 的 `conventions.coverageGap` 与页面上都如实回传每轮的
`coverage` / `offlineSuppressed`；修脚本不属本包范围，故按缺勤登记而非"靠改判定把红点亮绿"。
