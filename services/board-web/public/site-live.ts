/**
 * 多工位真机看板启动器（现场装配 / 联调用，不参与 `npm test`，不被 `npm run typecheck` 扫）
 * ============================================================================
 * 原名 `station1-live.ts`（工位1 单工位版）；本版把**工位2 / 工位3 / 工位4**接进来并把
 * 「设备 ↔ 工位」映射模型掰正，旧文件名保留为一行转发（见 `station1-live.ts`）。
 *
 * 一句话：把「现场二层观测 → 真实 DeviceReport → device-adapter 真实 ingest →
 * 看板真实状态 + SSE 上屏」**在一个进程里**跑起来，且**每个工位一套独立采集器**。
 *
 * ```
 *   netdev-discovery/scan.ps1 · listen.ps1            （真实 PowerShell + Npcap，仅只读探测）
 *            │  L2Snapshot（每个工位各自一轮）
 *            ▼
 *   device-collector ×4   createProductionCollector(subnet=192.168.0 / 192.168.1 / 192.168.0 / 192.168.0,
 *            │               identityMapPath=<工位1 / 工位2 / 工位3 / 工位4 台账>, sourceId=SRC-NETDEV-LAB01,
 *            │               uplinkTarget=<注入：直接调 adapter.ingestReport>)   ← 不新造 HTTP 客户端
 *            │  CollectorCycleResult.observations（**逐台设备**的观测）+ DeviceReport（变化驱动）
 *            ▼
 *   本文件（**状态源侧聚合器**）  工位级状态 = 该工位已观测设备聚合
 *            │            聚合规则写在 `bridgeStation`，**不进 board-web**（守 A-02）
 *            ▼
 *   device-adapter ×1     createProductionAdapterStateOnly（**只装配状态链路**，无执行端）
 *            │            presence → projection → ingest；control: 'unavailable'
 *            │  audit=JSONL 真实落盘 · alarm=POST alarm-svc /alarm/v1/events
 *            ▼
 *   board-web ×1          createProductionBoard（三级目录：CAMPUS-01 → LAB-01 → 工位1..工位4）
 *            │  projection.applyState(...) → realtime.tick() → SSE /board/v1/events
 *            ▼
 *   页面 `/station1` = `/site`（来源=真机 real；按工位分块：状态卡 + 7 单元表 + 设备参数卡 + 报警）
 *   正式看板 `/`（用户的默认口径）照常可用 · `/board/v1/*`
 * ```
 *
 * ## 「未上报」与「离线」必须分得开（现场口径，2026-09-22 修）
 *
 * | 情形 | 看板状态 | 页面文案 | `updatedAt` |
 * |---|---|---|---|
 * | 状态源从未上报 | `offline` | **未上报**（数据缺席） | `null` |
 * | 曾有上报、之后停更 | `offline`（判离线窗口判出） | 离线 | 有值 |
 * | 本轮观测到设备 | `available`/`occupied`/`maintenance` | 空闲/占用/维护 | 有值 |
 *
 * 关键实现（`bridgeStation`）：**本轮一个设备都没匹配上台账时，本文件不推任何状态**。
 * 采集器在那种轮次会自己下发一条空的 `status=offline` 上报（**数据缺席推断**），
 * 若照单全收地聚合成工位状态，就会①抢在判离线窗口之前下结论、②把"未上报"与"离线"搅成一样。
 * 因此只有"确实匹配到设备"的轮次才推状态。
 *
 * ## 目录（三级浏览，`coding-spec` 口径）
 *
 * ```
 * CAMPUS-01 海宁校区
 *   ├─ LAB-01 智能制造系统集成实训室
 *   │    ├─ ST-LAB01-01 工位1   （网段 192.168.0/24，台账 config/station1-identity.json）
 *   │    ├─ ST-LAB01-02 工位2   （网段 192.168.1/24，台账 config/station2-identity.json）
 *   │    ├─ ST-LAB01-03 工位3   （网段 192.168.0/24，台账 config/station3-identity.json）
 *   │    └─ ST-LAB01-04 工位4   （网段 192.168.0/24，台账 config/station4-identity.json）
 *   └─ LAB-05 工业机器人应用技术实训室（ABB）
 *        └─ ST-LAB05-01 .. ST-LAB05-12   （12 工位；网段 192.168.101/24；**尚未接线，无采集器**）
 *             单工位组成：**12 个工位完全相同**（用户 2026-09-23 确认）
 *               → 见 `ABB_STATION_COMPOSITION`（教材抽取：BOM / 网络规划 / 执行模块 / 数据区）
 * CAMPUS-02 滨江校区
 *   └─（本期无实训室接入）
 * ```
 *
 * ★ **两室都在海宁校区**（用户 2026-09-23 口径）；滨江校区本期无接入，登记为空节点。
 *
 * ★ **工位1 / 工位3 / 工位4 同在 `192.168.0.0/24`**（只有工位2 在 `192.168.1.0/24`）。
 * 三个工位同网段 ⇒ **归属只能靠 MAC**：一次采集里看到别工位的设备是**正常现象**，
 * 它们会如实进『待处理（unmapped）』并打印出来，**不静默丢弃**（见 `reportScan`）。
 *
 * ★ **废弃的旧口径**：`ST-LAB01-0N` 曾被借用为「工位1 的第 N 个单元位」（6 个单元 → 6 个编码）。
 * `coding-spec` 没有「单元」这一级，且现场一个工位本来就有多台设备；本版起
 * **`stationCode` 一律表示工位编码**，单元（7 个功能单元）只作为 **工位详情的 `params`** 呈现。
 *
 * ## 现场事实（2026-09-22 实测，**不再重扫网核对该清单**）
 *
 * | 工位 | IP | MAC | 身份 |
 * |---|---|---|---|
 * | 工位1 | .100 | E0-DC-A0-74-F1-06 | S7-1200，LLDP `.plcxb2d1ad`，**分拣单元控制器** |
 * | 工位1 | .101 | E0-DC-A0-72-39-99 | S7-1200，LLDP `.plcxb1d0ed`（单元归属未证实） |
 * | 工位1 | .237 | E4-54-E8-D4-73-7B | 工位 PC / HMI `STU-02` |
 * | 工位1 | .51 | 00-00-0A-BB-EA-A1 | IIS 服务器（仅 80/21） |
 * | 工位2 | 192.168.1.20 | E0-DC-A0-72-39-BE | S7-1200，站名 `.plcxb2d1ad`，**102 + 502** |
 * | 工位2 | 192.168.1.21 | 00-A0-45-00-20-42 | Phoenix PROFINET IO 从站，DCP 站名 `HDC` |
 * | 工位3 | 192.168.0.110 | 00-1C-06-4B-EC-5A | SINUMERIK 828D PPU241.3，deviceType `ncu1`，端口 102/22/4840/5900 |
 * | 工位3 | 192.168.0.103 | 28-63-36-7B-63-50 | S7-1200，FW V4.2.1，S/N `C-K2LL1185` |
 * | 工位3 | 192.168.0.121 | E0-DC-A0-74-F1-2D / …-2E | **同 IP 两台** S7-1200（S/N `V-L3D49539` / `V-L3C44733`，站名都 `plcxb2d1ad`）→ IP 冲突 |
 * | 工位3 | 192.168.0.2 / .3 / .5 | 00-A0-45-00-15-04 / …-18-26 / …-18-73 | Phoenix IO 从站，站名 `HDC`，deviceType `fj` / `dm` / `jg` |
 * | 工位3 | 192.168.16.12 | 00-A0-45-00-14-C2 | Phoenix IO 从站，站名 `HDC`，deviceType `zxxxb19ddb`，掩码 `0.0.0.0` |
 * | 工位4 | 192.168.0.5 | 00-A0-45-00-18-1D | Phoenix IO 从站，站名 `HDC`，deviceType `xn--dqun75f` |
 * | 工位4 | 192.168.0.101 | 28-63-36-7B-6B-4A | S7-1200，站名 `plcxb1d0ed`（LLDP chassis 为 `…-4B`，**以接口 MAC 为键**） |
 * | 工位4 | 192.168.0.103 | E0-DC-A0-72-39-09 | S7-1200，S/N `V-L3A84342`（LLDP chassis `…-0A`，以接口 MAC 为键） |
 * | 工位4 | （仅 LLDP，无 IP） | E4-54-E8-D4-78-27 | 戴尔 OptiPlex 3060 工位机 `STU-02`（与工位1 的 STU-02 `…-73-7B` **同名不同机**） |
 *
 * ★ **站名跨工位重名 ⇒ 站名不是唯一键，MAC 才是**（计划 §1.2）：
 * 工位1 `.100` 与工位2 `.20` 的站名**都**是 `plcxb2d1ad`；`plcxb1d0ed` 至少三台；
 * `HDC` 每工位内即重复；主机名 `STU-02` 两台。按站名归位必然串台。
 * ★ **IP 跨工位复用**：`.103` 在工位1/3/4 是三台不同设备；`.101` 在工位1/4 是两台；`.5` 在工位3/4 两台
 * ⇒ 归属只能由「MAC + 接到哪台交换机」共同确定。
 * ★ 跨工位可见、**不属本工位** 的设备：`192.168.0.103`（S7-1200 `plcxb1d0ed`）—— 工位2 只经 LLDP 邻居看到，
 * **故意不写进工位2 台账**（写了就会算进工位2 的状态聚合）；工位1/3/4 **同在 `192.168.0.0/24`**，
 * 别工位的设备会进 pending，**如实打印、不静默丢弃**。
 * ★ 网卡必须用 `-IfKeyword "PCIe GbE"` 指定：用 `Realtek` 会命中 WiFi 网卡（实测已踩过）。
 *
 * ## 纪律（为什么这样写）
 *
 *   1. **时钟用 core 的 `SystemClock`**：本文件绝不注入 `FakeClock`；页面上的"更新时刻"
 *      必须是真的挂钟时间。
 *   2. **所有数值取自各服务 `params.ts`**：采集周期 / 监听窗口 / 心跳 / 变化阈值全部
 *      从 `device-collector/src/config/params.ts` 与 `device-adapter/src/params.ts` 的
 *      `DEV_DEFAULTS` 取；命令行只允许**部署层覆盖**，不允许就地写业务阈值。
 *   3. **只读探测**：只跑 `scan.ps1`（ARP/DCP/LLDP/TCP 端口）与 `listen.ps1`（被动监听，
 *      不发帧）。本启动器不写任何设备参数、不改网卡地址。
 *   4. **端口由外层 pageServer 持有**（与 `public/serve.ts` 同一装配方式）：
 *      `board.server.server` 只作为 `/board/v1/*` 的请求处理器（`emit('request', ...)`）。
 *   5. **单进程上行**：`uplinkTarget` 直接调 `adapter.ingestReport(report)`（组件级调用），
 *      不在这里新造一份 HTTP 客户端（重试/超时/信封解析各一份 = 两个口径）。
 *   6. **工位状态聚合在状态源侧**：board-web 的状态唯一入口是状态源上报的 `state`，
 *      在 board-web 里做聚合会违反 A-02。本文件就是各工位的状态源适配器，所以聚合规则
 *      写在这里、随 `params.aggregation` 一起透出，可核对（见 `bridgeStation`）。
 *   7. **"扫不到" ≠ "不存在"**：某轮采集无效、或采集器自报 `offlineSuppressed`（网段未覆盖）时，
 *      本文件**不推**工位级 `offline`——那时"没观测到"只能说明探测不到，不能说明设备不在。
 *      从未上报的工位在看板上本来就是 `offline`（数据缺席即不可用），不会显示成"空闲"。
 *   8. **audit / alarm 都是真实现**：审计追加写 JSONL（写失败只计数，不抛穿采集）；
 *      告警 POST 到 alarm-svc（服务不可达只计数 + 记日志，**绝不让采集停摆**）。
 *
 * ## 四个工位不会同时在网（现场约束，必须如实理解）
 *
 * 本机只有一块以太网口。接工位4 时网卡地址在 `192.168.0.0/24`（工位2 的 `192.168.1.0/24` 不再配置）；
 * 反过来同理。**工位1/3/4 同在 `192.168.0.0/24`**——即使网线接在工位4，工位1/3 的采集器也可能
 * 「看到」一部分地址（同网段二层可见），但**没有接线位置佐证就不算归属**：不属于该工位的设备进 pending，
 * 属于该工位但物理不在线的设备则根本不出现。因此**未接线的工位在看板上显示 `offline`（未上报）**，
 * 走判离线窗口，**绝不会显示成 available**。
 * `scan.ps1` 当前**不产出 `coverage` 字段**（网段覆盖判定在 DSH 插件 Host 层，不在脚本里），
 * 所以采集器侧的"网段未覆盖 → 抑制 offline 推断"在真实路径上不生效——本文件不掩饰这一点，
 * 而是在 `/site/data.json` 里如实回传各工位最近一轮的 `coverage` 与 `offlineSuppressed`。
 *
 * 用法：
 *   node --import tsx public/site-live.ts [端口] [--key=value]
 *     --port=        HTTP 端口（等同首个位置参数）
 *     --poll-ms=     采集轮周期（缺省 `MIN_POLL_INTERVAL_MS`）
 *     --listen-sec=  被动监听窗口秒数（缺省 `DEFAULT_LISTEN_SECONDS`）
 *     --listen-ms=   被动监听周期（缺省 `DEFAULT_LISTEN_INTERVAL_MS`）
 *     --audit=       审计 JSONL 路径（缺省 `peripheral/data/station1-live/audit.jsonl`，与单工位版同路径）
 *     --alarm-base=  alarm-svc 基址（缺省 http://127.0.0.1:8087，路径由转发侧补）
 *     --script-dir=  netdev-discovery 的 scripts 目录（缺省按工作区相对位置推导）
 *     --identity=    工位1 身份台账 JSON 路径（缺省 `peripheral/config/station1-identity.json`）
 *     --identity2=   工位2 身份台账 JSON 路径（缺省 `peripheral/config/station2-identity.json`）
 *     --identity3=   工位3 身份台账 JSON 路径（缺省 `peripheral/config/station3-identity.json`）
 *     --identity4=   工位4 身份台账 JSON 路径（缺省 `peripheral/config/station4-identity.json`）
 *     --subnet=      工位1 目标网段前三段（缺省 192.168.0）
 *     --subnet2=     工位2 目标网段前三段（缺省 192.168.1）
 *     --subnet3=     工位3 目标网段前三段（缺省 192.168.0，与工位1/4 同段）
 *     --subnet4=     工位4 目标网段前三段（缺省 192.168.0，与工位1/3 同段）
 *     --if-keyword=  网卡驱动描述关键字（缺省 `PCIe GbE`）
 *
 * 工位清单由 `STATIONS`（数组驱动）给出，每项 = `{ 工位号, 名称, 网段, 台账路径, 单元归属 }`；
 * 加第 N 个工位只需加一条 `readArgs` 的 flag + 一条数组项，**不需要**再动采集/桥接/页面逻辑。
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PARAM, SystemClock, isValidStationCode, labCodeOfStation, parseIso, toIso } from '@peripheral/core';

import { DEV_DEFAULTS, DEV_PARAM } from '../../device-adapter/src/params.js';
import { createProductionAdapterStateOnly } from '../../device-adapter/src/production.js';
import type {
  AlarmSink,
  AuditEntry,
  AuditSink,
  DeviceAlarmEvent,
  DeviceReport,
  DeviceStatus,
} from '../../device-adapter/src/types.js';
import {
  DEFAULT_ALARM_FORWARD_TIMEOUT_MS,
  DEFAULT_HELLO_STORM_MIN_FRAMES,
  DEFAULT_HELLO_STORM_RATE_PER_SECOND,
  DEFAULT_LISTEN_INTERVAL_MS,
  DEFAULT_LISTEN_SECONDS,
  DEFAULT_SCAN_CAPTURE_SECONDS,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  DEFAULT_UPLINK_INTERVAL_MS,
  DEFAULT_UPLINK_TIMEOUT_MS,
  MIN_POLL_INTERVAL_MS,
} from '../../device-collector/src/config/params.js';
import type { AlarmFinding } from '../../device-collector/src/alarm-source.js';
import type { CollectorCycleResult, DeviceObservation } from '../../device-collector/src/index.js';
import type { ListenCycleResult } from '../../device-collector/src/index.js';
import { createProductionCollector } from '../../device-collector/src/production.js';
import type { ProductionCollector } from '../../device-collector/src/production.js';
import { makeEventId } from '../../device-collector/src/report-builder.js';
import { createUplinkTargetFromIngest, createHttpUplinkTarget } from '../../device-collector/src/reporter.js';
import type { DrainResult, UplinkResult, UplinkTarget } from '../../device-collector/src/reporter.js';
import { buildCatalog, createBoardParams } from '../src/index.js';
import { createProductionBoard } from '../src/production.js';
import type { AlarmLevel, StationState } from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `peripheral/` 根目录（public/ → board-web → services → peripheral） */
const PERIPHERAL_ROOT = join(HERE, '..', '..', '..');
/** 工作区根（`机电实训平台项目/`） */
const WORKSPACE_ROOT = join(PERIPHERAL_ROOT, '..');

/* ------------------------------------------------------------------ 部署参数 */

const DEFAULT_PORT = 8731;
const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_SUBNET_STATION1 = '192.168.0';
const DEFAULT_SUBNET_STATION2 = '192.168.1';
/**
 * ★ LAB-05 工业机器人应用技术实训室（ABB）实测网段 = `192.168.101.0/24`。
 *
 * 依据：2026-09-23 现场直连工位2 控制器时，**被动监听 LLDP `managementAddress`** 推得该网段
 * （当时本机网卡并未配置该段地址，属"看得见的别网段设备"）；
 * 随后 `192.168.101.13` 被上位机 ping 通（0% 丢包）。见 KB《ABB 实训室 工位2 现场实测》。
 *
 * ⚠️ 该网段**只对 LAB-05 有效**：与 `192.168.0.0/24`（LAB-01）没有任何继承关系，
 * 两室地址不可互换——即便日后同号 IP 出现，也必须按「LAB + MAC」共同定性。
 */
const DEFAULT_SUBNET_ABB = '192.168.101';
/** ★ 工位1 / 工位3 / 工位4 **同网段**（192.168.0.0/24）：工位归属不能靠网段，只能靠 MAC */
const DEFAULT_SUBNET_STATION3 = '192.168.0';
const DEFAULT_SUBNET_STATION4 = '192.168.0';
/** ★ 必须指定到这块网卡：用 `Realtek` 会命中 WiFi 网卡（实测已踩过） */
const DEFAULT_INTERFACE_KEYWORD = 'PCIe GbE';
const DEFAULT_ALARM_BASE_URL = 'http://127.0.0.1:8087';

/** 来源标识：四个工位**同属 LAB-01**，因此共用同一个授权来源（前缀 `ST-LAB01-`）。 */
const SOURCE_ID = 'SRC-NETDEV-LAB01';

/**
 * 校区口径（用户 2026-09-23 明确）：本项目分**海宁校区**与**滨江校区**，
 * 而**这两个实训室（LAB-01 / LAB-05）都在海宁校区**。
 *
 * ⚠️ 滨江校区（`CAMPUS-02`）当前**没有任何实训室**：本期现场只覆盖海宁这两个室，
 * 不凭空给它编工位。看板会如实渲染成一个没有实训室的校区节点
 * （而不是"隐藏"——隐藏会让人误以为该校区不存在）。
 */
const CAMPUS_CODE = 'CAMPUS-01';
const CAMPUS_NAME = '海宁校区';
/** 滨江校区：本期无实训室接入，仅作为目录节点登记 */
const CAMPUS2_CODE = 'CAMPUS-02';
const CAMPUS2_NAME = '滨江校区';
const LAB_CODE = 'LAB-01';
const LAB_NAME = '智能制造系统集成实训室';
const STATION1_CODE = 'ST-LAB01-01';
const STATION2_CODE = 'ST-LAB01-02';
const STATION3_CODE = 'ST-LAB01-03';
const STATION4_CODE = 'ST-LAB01-04';
/** 跨工位（不落在单一工位）的报警归属编码：`${stationPrefix}00`，与 AlarmForwarder 同口径 */
const LAB_WIDE_STATION_CODE = 'ST-LAB01-00';

/* ------------------------------------------------ 第二个实训室：工业机器人应用技术实训室（ABB） */

/**
 * `LAB-05` 工业机器人应用技术实训室（ABB）——**独立实训室，12 个工位**。
 *
 * 为什么编号是 `LAB-05` 而不是"接着 LAB-02"：
 * 实训室编号**全局唯一**（见 `catalog.ts` 文件头纪律 2），工位编码由实训室编号派生
 * （`LAB-05` → `ST-LAB05-`），因此必须避开已占用的 `LAB-01`~`LAB-04`。
 *
 * ⚠️ 本室的 12 个工位**当前一台设备都未接入台账**（现场只实测过"工位2"这一台口的设备，
 * 且那批设备是**工位2 的控制器直连**，不是 12 工位全量）。因此：
 * 12 个工位全部按「从未上报」呈现 `offline`（**不是"空闲"**），直到现场逐工位接线并补台账。
 * 这不是占位造假——目录结构是真的，状态如实为"无数据"。
 *
 * ★ 组成已补齐（2026-09-23）：本室 12 个工位**组成完全相同**（用户确认），
 * 单工位 BOM / 网络规划 / 执行模块 / 数据区见下方 `ABB_STATION_COMPOSITION`
 * （来源 = 教材《ABB中级工业机器人应用编程》，属**设计规划**，**不是实测状态**）。
 *
 * ⚠️ 但"**组成相同 ≠ 地址相同**"：教材只给了一套 IP（`.100/.13/.10/.50/.75`），
 * 12 个工位是「各自独立网络 ⇒ 可复用同号 IP」还是「同一扁平网络 ⇒ IP 必须逐位不同」，
 * **目前没有证据裁决** —— 见 `ABB_STATION_COMPOSITION.designNote`。
 * 因此**不得**把这套 IP 当成"12 个工位各自的地址"下发或入台账。
 */
const ABB_CAMPUS_CODE = 'CAMPUS-01';
const ABB_LAB_CODE = 'LAB-05';
const ABB_LAB_NAME = '工业机器人应用技术实训室（ABB）';
/** 本室 12 个工位的授权来源（前缀 `ST-LAB05-`）。与 LAB-01 的 `SRC-NETDEV-LAB01` 相互独立。 */
const ABB_SOURCE_ID = 'SRC-NETDEV-LAB05';
/** 本室工位数量（现场口径：12 个工位） */
const ABB_STATION_COUNT = 12;
/** 本室跨工位报警归属编码 */
const ABB_LAB_WIDE_STATION_CODE = 'ST-LAB05-00';

/**
 * ★★ LAB-05 **单工位组成**（教材抽取，2026-09-23）——本室 **12 个工位组成完全相同**。
 *
 * 用户 2026-09-23 明确："这个实训室的工位资料……这里的 12 个工位组成都是一样的"。
 * 因此**只存一份**：12 个工位节点各自带 `compositionKey` 指向本对象，
 * **不在 payload 里重复 12 份**（内容一致，重复只会制造不一致风险）。
 *
 * ⚠️ 两条口径**写在数据里**，避免调用方误读：
 *
 *   1. `sourceKind: 'design-plan'` —— 教材是**设计/教学规划**，不是实测状态。
 *      `networkPlan` 里的 IP 是**教材给这一套平台的设计值**，
 *      **不代表 12 个工位各自的地址**（见 `designNote`）。
 *
 *   2. `fieldCheck` —— 2026-09-23 **只实测过一个工位**，且该工位编号来自用户口述，
 *      **未与工位标牌/MAC 核验**，故**不绑定到具体 `stationCode`**
 *      （KB《LAB-05 工位2 现场实测台账》记「工位归属未确认」）。
 *
 * 需要"某工位此刻有哪些设备"时，用台账（将来 `config/abb-stationN-identity.json`）+ 采集器，
 * **不要**拿本对象当设备清单，也不要拿它判在线/离线。
 */
const ABB_STATION_COMPOSITION_KEY = 'ABB-STATION-COMPOSITION-V1';

const ABB_STATION_COMPOSITION = {
  key: ABB_STATION_COMPOSITION_KEY,
  scope:
    '本室 12 个工位共用同一份组成（用户 2026-09-23 确认）；故只存一份，' +
    '各工位节点用 compositionKey 指向本对象。',
  sourceKind: 'design-plan',
  source:
    '教材《ABB中级工业机器人应用编程-教材课程用.pptx》（149 页，' +
    '江苏汇博机器人技术股份有限公司 · 工业机器人应用编程 1+X 项目团队）',
  extractedAt: '2026-09-23',
  extractionMethod:
    '直接解析 pptx 包内 ppt/slides/*.xml（149 页 / 7237 个文本串）+ 提取内嵌器件图片逐张核对；未使用自动摘要',

  /**
   * 单工位硬件构成（BOM）。
   * 来源 = 教材「PLC通讯功能设计——网络视图」页（硬件表 + PLC 机架图实拍）。
   */
  hardware: [
    { item: 'PLC', model: 'SIMATIC S7-1200 CPU 1215C DC/DC/DC', firmware: '4.2（考核环境 4.1）', note: '' },
    { item: 'RFID', model: 'RF120C', firmware: '1.0', note: '插槽 101（教材注：仅此唯一通道）' },
    { item: 'RS485/422 通讯', model: 'CM 1241（RS422/485）', firmware: '2.1', note: '插槽 102' },
    { item: 'HMI', model: 'TP700 Comfort（精智面板）', firmware: '15.0.0.0', note: '组态名 HMI_1' },
    {
      item: '相机（视觉）',
      model: 'In-Sight IS2XXX（教材另称 IS2000）',
      firmware: '5.3.0',
      note: '★ ABB 平台下由机器人直接控制、不经 PLC；教材组态页显示"未分配"',
    },
    {
      item: '机器人',
      model: 'ABB（教材实拍控制器外形为 IRC5 Compact）',
      firmware: '',
      note: '教学内容含 RobotStudio 与 Socket 编程',
    },
  ],

  /**
   * 单工位网络规划。来源 = 教材「系统网络架构介绍（ABB）」页（IP 标注 + 器件图标逐张核对）。
   * ⚠️ **教材设计值**，不是 12 个工位各自的地址 —— 见 `designNote`。
   */
  networkPlan: [
    {
      ip: '192.168.101.100',
      device: 'ABB 机器人控制器',
      role: 'Socket 客户端 → PLC',
      evidence: '教材通讯设计页明确"客户端：192.168.101.100"',
    },
    {
      ip: '192.168.101.13',
      device: 'PLC 1215C',
      role: 'Socket 服务器 :2001；Modbus-TCP 从站 :502',
      evidence: '教材「推荐配置 192.168.101.13」',
    },
    {
      ip: '192.168.101.10',
      device: 'HMI TP700 Comfort',
      role: '—',
      evidence: '教材 HMI 组态页「推荐配置 192.168.101.10」',
    },
    {
      ip: '192.168.101.50',
      device: '相机 In-Sight',
      role: '—',
      evidence: '教材网络架构图（与 HMI/PLC 同图；PLC/HMI 已由教材正文占位 .13/.10，消去法确定）',
    },
    {
      ip: '192.168.101.75',
      device: '工业以太网 I/O 模块 TCP-507T',
      role: 'Modbus-TCP :502；8 路 DI，寄存器起始 10001',
      evidence: '教材「以太网 IO 模块的数据采集」页（仓储库位检测）',
    },
  ],

  /** ★ 关键未决问题：写进数据，防止调用方把"一套设计值"当成"12 份工位地址" */
  designNote:
    '教材**只给了这一套 IP**。⚠️ **不得**据此认定「12 个工位各自的地址就是这 5 个」：' +
    '若各工位是互相隔离的独立网络，同号 IP 可以复用；若 12 工位在同一扁平网络，' +
    '则 IP 必然逐工位不同、教材那套只是"推荐配置示例"。**该问题目前无证据裁决**' +
    '（旁证：2026-09-23 单工位实测 .13/.10 干净在线、无 IP 冲突告警、无 DCP Hello 风暴 —— ' +
    '若 12 工位 PLC 同处扁平网络且同为 .13，必然出现大规模冲突与 Hello 风暴）。' +
    '裁决前本室台账必须**逐工位现场实测、MAC 为主键**，**严禁**按教材批量复制 12 份。',

  /** 单工位机械/执行模块。来源 = 教材「2 执行机构与数据接口」章（第 7–13 页） */
  modules: [
    '旋转供料模块',
    '立体仓库 / 仓储模块（6 库位）',
    '变位机模块',
    '行走轴',
    'RFID（读写头控制 + 工序管理）',
    '自定义数据（INT×16 + REAL×16）',
  ],

  /** 单工位 PLC 数据区（机器人 ↔ PLC 走 Socket :2001） */
  dataBlocks: [
    {
      block: 'DB_RB_CMD',
      number: 46,
      layout: 'PLC_RCV_Data（160B，offset 0）+ RB_CMD（160B，offset 160）',
      note: '机器人 → PLC（原始数据 + 解析后命令）',
    },
    {
      block: 'DB_PLC_STATUS',
      number: 45,
      layout: 'PLC_Send_Data（160B，offset 0）+ PLC_Status（160B，offset 160）',
      note: 'PLC → 机器人（原始数据 + 实际状态）',
    },
    {
      block: 'DB_TCP_DIO',
      number: null,
      layout: 'MODBUS_TCP-CONNECT（TCON_IP_v4）+ DI Array[0..7] of Bool',
      note: '仓储模块库位检测（Modbus-TCP）',
    },
    { block: 'RFID_DATA_DB', number: 47, layout: '—', note: '教材注：考核环境中提供' },
  ],

  /** 数值解析规则（教材明确） */
  parsingRules: [
    'WORD/INT 等两位以上数值需高低位交换（SWAP_WORD）；FANUC 平台不需要',
    'REAL 收发前须经 DWORD 转换（DWORD_TO_REAL(SWAP_DWORD(…)) / SWAP_DWORD(REAL_TO_DWORD(…))），并遵循上一条',
    '解析推荐在 PLC 侧完成',
  ],

  /** 教材自身的错漏（引用教材时一并带上，避免照抄） */
  caveats: [
    '教材第 10 页（行走轴）的变量映射照抄了变位机，第 13 页汇总表已更正为「行走轴命令/目标位置/目标速度」——以汇总表为准',
    '教材 Modbus 页有笔误（写成 192.169.101.13 / 192,168.101.13），以 192.168.x 为准',
    '教材中的 192.168.101.105 是教学用 PC 地址，**不是设备地址**',
  ],

  /**
   * 2026-09-23 单工位现场抽检（**只测过一个工位**）。
   * ★ 不绑定 stationCode：工位编号来自用户口述，未与工位标牌/MAC 核验。
   */
  fieldCheck: {
    at: '2026-09-23 11:11–11:21',
    stationLabel: '用户口述「工位2」——未与工位标牌/MAC 核验，故**不绑定 stationCode**',
    subnet: DEFAULT_SUBNET_ABB,
    coverage: 'coverage.mandatory=false（已覆盖 192.168.101.0/24 与 192.168.0.0/24）⇒ 该段设备清单完整',
    online: [
      {
        ip: '192.168.101.13',
        mac: 'E0-DC-A0-BE-A0-72',
        identity: 'S7-1200 CPU 1215C，6ES7 215-1AG40-0XB0，FW V4.4.0，S/N V-M4C65321，PROFINET 站名 plcxb1d0ed',
        ports: '102',
      },
      {
        ip: '192.168.101.10',
        mac: 'E0-DC-A0-CE-AD-B0',
        identity: 'S7-1200（西门子 OUI）；**无 DCP/LLDP 自报身份**，型号/序列号/站名未知',
        ports: '102',
      },
    ],
    absent: ['192.168.101.100', '192.168.101.50', '192.168.101.75'],
    conclusion:
      '教材规划的 5 台里当时只有 2 台在网：.100 机器人 / .50 相机 / .75 IO 模块 **0 应答**' +
      '（未上电或未接网）。⚠️「0 应答」只说明**当时不在网**，**不等于不存在**。' +
      '另：实测两台 PLC **只开 102**，**未监听教材所述的 2001/502**' +
      '（PLC 程序当时未运行该通讯逻辑，或组态未下载）。',
    methodLesson:
      '★ 本段 S7-1200 **不应答 PROFINET DCP**、**ARP 响应不稳定**：首次 netdev_scan 与 /16 全段 sweep 均为 0 台，' +
      '只有 netdev_listen 被动监听的 LLDP 宣告能稳定发现设备。换线到新工位必须**先跑 listen（≥45s）再 scan**，' +
      '**不得**把"首次 scan 0 台"当成"没有设备"。',
  },
} as const;

/* ------------------------------------------------------- 实训室登记表（多室来源的唯一出处） */

/**
 * 一个实训室在本启动器里需要的**全部室级口径**，集中一处：
 * 工位挂哪个来源标识（决定 S07 授权前缀）、不属于单一工位时的跨工位编码。
 *
 * 为什么要有这张表：LAB-05 接入后，"来源标识"不再是一个全局常量——**按工位归属取**。
 * 若散落成 `stationCode.startsWith('ST-LAB05') ? … : …` 这样的三元表达式，
 * 加第三个实训室时必然漏改一处，且漏改的表现是"报警用错授权前缀"（静默、难查）。
 */
interface LabRegistry {
  readonly labCode: string;
  readonly labName: string;
  /** 本室的状态/报警来源标识。S07 侧的授权前缀由它推导（`SRC-NETDEV-LAB05` → `ST-LAB05-`）。 */
  readonly sourceId: string;
  /** 本室跨工位（不落单一工位）的编码：`${工位前缀}00`，与 `AlarmForwarder.labWideStationCode` 同口径。 */
  readonly labWideStationCode: string;
  /** 本室工位总数（现场口径；不等于"已接入采集的工位数"） */
  readonly stationCount: number;
}

const LAB_REGISTRY: Readonly<Record<string, LabRegistry>> = {
  [LAB_CODE]: {
    labCode: LAB_CODE,
    labName: LAB_NAME,
    sourceId: SOURCE_ID,
    labWideStationCode: LAB_WIDE_STATION_CODE,
    stationCount: 4,
  },
  [ABB_LAB_CODE]: {
    labCode: ABB_LAB_CODE,
    labName: ABB_LAB_NAME,
    sourceId: ABB_SOURCE_ID,
    labWideStationCode: ABB_LAB_WIDE_STATION_CODE,
    stationCount: ABB_STATION_COUNT,
  },
};

/**
 * 按工位编码取本室登记。**未知实验室 fail-fast**，不兜底。
 *
 * 兜底（比如"认不出就用 LAB-01"）看着稳，实际会把 LAB-05 的报警盖上 LAB-01 的授权前缀，
 * 而 S07 侧只会说"越权"，不会说"你认错了实训室"——比直接抛出来难查得多。
 */
function labOfStation(stationCode: string): LabRegistry {
  const lab = LAB_REGISTRY[labCodeOfStation(stationCode)];
  if (lab === undefined) {
    throw new Error(
      `工位 ${stationCode} 的实训室不在登记表中（labCode=${labCodeOfStation(stationCode)}）：` +
        '无法确定来源标识与跨工位编码。新增实训室请先补 LAB_REGISTRY。',
    );
  }
  return lab;
}

/** 某来源标识对应的跨工位编码（用于"报警没带工位"这一情形——只能按来源定室） */
function labWideStationCodeOfSource(sourceId: string): string {
  for (const lab of Object.values(LAB_REGISTRY)) {
    if (lab.sourceId === sourceId) return lab.labWideStationCode;
  }
  return LAB_WIDE_STATION_CODE;
}

/** 单元状态占位词（**不得**写成"空闲"） */
const UNIT_STATE_UNATTRIBUTED = '归属未确认';
const UNIT_STATE_UNREPORTED = '未上报';
/** 未观测到的现场站名代号占位词 */
const UNIT_CODE_UNOBSERVED = '未观测';

/** 审计正文的 JSONL 每行一条；审计写入失败只计数（不抛穿采集循环） */
const AUDIT_FAILURE_LOG_EVERY = 10;
/** 最近报警台账（内存）保留条数 */
const LIVE_ALARM_KEEP = 30;

interface LaunchConfig {
  port: number;
  auditPath: string;
  alarmBaseUrl: string;
  /** 可选：显式指定判离线窗口（毫秒）；缺省按契约默认值 × 现场节奏倍数 */
  offlineJudgeMs?: number;
  scriptDir: string;
  identity1Path: string;
  identity2Path: string;
  identity3Path: string;
  identity4Path: string;
  subnet1: string;
  subnet2: string;
  subnet3: string;
  subnet4: string;
  /**
   * LAB-05（ABB）工位 02 的台账与本室网段。
   *
   * ⚠️ 为什么只有"工位 02"一组：LAB-05 共 12 个工位，**目前只有工位 2 逐台接线实测过**
   * （其余 11 位一台设备都没实测）。按纪律**不为没实测的工位编台账**——
   * 后续每实测一位，就在这里补一组 `--abb-identityNN=`，与 LAB-01 的做法完全一致。
   */
  abbSubnet: string;
  /**
   * LAB-05 工位1 的台账路径（2026-09-24 接入页签；**台账为空**）。
   *
   * ⚠️ **空台账 ≠ 无设备**：工位1 现场作业受阻（总电源开关坏，设备未上电），
   * 一台设备都未实测。给它建台账是让**页签与设备组成**能展示（组成是设计事实），
   * 而 `entries: []` 如实表示「本轮未取得数据」。见该文件 `_meta.why_empty`。
   */
  abbIdentity01Path: string;
  /** LAB-05 工位1 的网段前三段（该工位未实测 ⇒ 取本室主网段 `.101` 作占位，**不是实测值**） */
  abbSubnet01: string;
  abbIdentity02Path: string;
  /** LAB-05 工位3 的台账路径（**台账为空**：网线不通，链路未建立，未实测到任何设备） */
  abbIdentity03Path: string;
  /** LAB-05 工位3 的网段前三段（未实测 ⇒ 取本室主网段 `.101` 作占位，**不是实测值**） */
  abbSubnet03: string;
  /** LAB-05 工位4 的台账路径（2026-09-23 实测归档：本室**首次实证 ABB 机器人存在**的工位） */
  abbIdentity04Path: string;
  /** LAB-05 工位4 的网段前三段（实测 `.101`） */
  abbSubnet04: string;
  /** LAB-05 工位5 的台账路径（**台账为空**：设备开关有问题，设备未能正常上电） */
  abbIdentity05Path: string;
  /** LAB-05 工位5 的网段前三段（未实测 ⇒ 取本室主网段 `.101` 作占位，**不是实测值**） */
  abbSubnet05: string;
  /** LAB-05 工位6 的台账路径（2026-09-23 实测归档：本室**第二个网段** `.1` 的工位） */
  abbIdentity06Path: string;
  /** LAB-05 工位6 的实测网段前三段（★ `192.168.1`，与其余工位不同） */
  abbSubnet06: string;
  /**
   * LAB-05 工位7 的台账路径。
   *
   * ⚠️ 本室**各工位网段可能不同**（实测：工位2/4/7 在 `.101`，**工位6 在 `.1`**），
   * 因此每个工位的 `subnet` 必须按其**实测网段**给，**不得**统一套 `--abb-subnet`。
   */
  abbIdentity07Path: string;
  /** LAB-05 工位7 的实测网段前三段（与工位2 同为 `.101`，但仍独立给出以便逐位覆盖） */
  abbSubnet07: string;
  /** LAB-05 工位8 的台账路径（2026-09-23 现场实测接入：首个抓到 In-Sight 相机的工位） */
  abbIdentity08Path: string;
  /** LAB-05 工位8 的实测网段前三段（与工位2/7 同为 `.101`，仍独立给出以便逐位覆盖） */
  abbSubnet08: string;
  /**
   * LAB-05 工位9 的台账路径（2026-09-23 现场实测接入）。
   *
   * ⚠️ 本工位是本室**第三个网段** `192.168.0.0/24`，且**该网段与 LAB-01 完全相同** ——
   * 因此 `subnet` 必须逐工位给（`--abb-subnet09`），**绝不能**统一套默认值。
   */
  abbIdentity09Path: string;
  /** LAB-05 工位9 的实测网段前三段（★ `192.168.0`，与 LAB-01 网段碰撞） */
  abbSubnet09: string;
  /** LAB-05 工位10 的台账路径（2026-09-23 现场实测接入） */
  abbIdentity10Path: string;
  /** LAB-05 工位10 的实测网段前三段（与工位2/4/7/8 同为 `.101`，仍独立给出以便逐位覆盖） */
  abbSubnet10: string;
  /** LAB-05 工位11 的台账路径（2026-09-23 现场实测接入） */
  abbIdentity11Path: string;
  /** LAB-05 工位11 的实测网段前三段（`.101`；★ 该工位疑HMI 在 `.101.2` 而非常规 `.10`） */
  abbSubnet11: string;
  /** LAB-05 工位12 的台账路径（2026-09-23 现场实测接入，本轮逐台实测的最后一个） */
  abbIdentity12Path: string;
  /** LAB-05 工位12 的实测网段前三段（`.101`） */
  abbSubnet12: string;
  /**
   * S03 上游（`connector-svc-http`）的入站令牌。
   *
   * 缺省**不设**：那时看板 S03 页签会拿到 403 并如实显示「需令牌」——
   * 比塞一个占位令牌（每次调用都失败、看起来像"上游故障"）更容易定位。
   */
  connectorToken?: string;
  /**
   * `seat-svc` 的令牌（头名 `X-Seat-Token`），用于代理 `/seat/*` 取**席位明细**。
   *
   * 为什么单独一个：seat-svc 与 connector-svc 是**两套令牌**
   * （前者 `SEAT_MANAGER_TOKEN`/`--token`，后者 `--connector-token`），
   * 混用会得到一个"看起来令牌不对、其实是拿错了"的 401。
   * 缺省不设：那时席位明细表会显示不可用并如实说明，而不是假装没有席位。
   */
  seatToken?: string;
  interfaceKeyword: string;
  pollIntervalMs: number;
  listenIntervalMs: number;
  listenSeconds: number;
  /**
   * 可选：device-adapter（S05）基址，如 `http://127.0.0.1:8734`。
   * 给出时采集结果**额外**投一份到 S05；缺省不投（单进程模式）。
   */
  deviceBaseUrl?: string;
}

function readArgs(argv: readonly string[]): LaunchConfig {
  const flags = new Map<string, string>();
  let positionalPort: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const index = arg.indexOf('=');
      if (index > 0) flags.set(arg.slice(2, index), arg.slice(index + 1));
      continue;
    }
    if (positionalPort === undefined) positionalPort = arg;
  }

  const numberFlag = (name: string, fallback: number): number => {
    const raw = flags.get(name);
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`--${name} 必须是正数（收到 ${JSON.stringify(raw)}）`);
    }
    return value;
  };
  const textFlag = (name: string, fallback: string): string => {
    const raw = flags.get(name);
    return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
  };

  return {
    port: Number(flags.get('port') ?? positionalPort ?? DEFAULT_PORT),
    auditPath: textFlag('audit', join(PERIPHERAL_ROOT, 'data', 'station1-live', 'audit.jsonl')),
    alarmBaseUrl: textFlag('alarm-base', DEFAULT_ALARM_BASE_URL),
    ...(flags.has('offline-judge-ms') ? { offlineJudgeMs: numberFlag('offline-judge-ms', 0) } : {}),
    scriptDir: textFlag('script-dir', join(WORKSPACE_ROOT, 'plugins', 'netdev-discovery', 'scripts')),
    identity1Path: textFlag('identity', join(PERIPHERAL_ROOT, 'config', 'station1-identity.json')),
    identity2Path: textFlag('identity2', join(PERIPHERAL_ROOT, 'config', 'station2-identity.json')),
    identity3Path: textFlag('identity3', join(PERIPHERAL_ROOT, 'config', 'station3-identity.json')),
    identity4Path: textFlag('identity4', join(PERIPHERAL_ROOT, 'config', 'station4-identity.json')),
    subnet1: textFlag('subnet', DEFAULT_SUBNET_STATION1),
    subnet2: textFlag('subnet2', DEFAULT_SUBNET_STATION2),
    subnet3: textFlag('subnet3', DEFAULT_SUBNET_STATION3),
    subnet4: textFlag('subnet4', DEFAULT_SUBNET_STATION4),
    abbSubnet: textFlag('abb-subnet', DEFAULT_SUBNET_ABB),
    abbIdentity01Path: textFlag('abb-identity01', join(PERIPHERAL_ROOT, 'config', 'abb-station01-identity.json')),
    // 工位1 未实测（作业受阻）⇒ 网段只能给本室主网段作占位，**不是实测值**
    abbSubnet01: textFlag('abb-subnet01', DEFAULT_SUBNET_ABB),
    abbIdentity02Path: textFlag('abb-identity02', join(PERIPHERAL_ROOT, 'config', 'abb-station02-identity.json')),
    abbIdentity03Path: textFlag('abb-identity03', join(PERIPHERAL_ROOT, 'config', 'abb-station03-identity.json')),
    abbSubnet03: textFlag('abb-subnet03', DEFAULT_SUBNET_ABB),
    abbIdentity04Path: textFlag('abb-identity04', join(PERIPHERAL_ROOT, 'config', 'abb-station04-identity.json')),
    abbSubnet04: textFlag('abb-subnet04', DEFAULT_SUBNET_ABB),
    abbIdentity05Path: textFlag('abb-identity05', join(PERIPHERAL_ROOT, 'config', 'abb-station05-identity.json')),
    abbSubnet05: textFlag('abb-subnet05', DEFAULT_SUBNET_ABB),
    abbIdentity06Path: textFlag('abb-identity06', join(PERIPHERAL_ROOT, 'config', 'abb-station06-identity.json')),
    // ★ 缺省**不是** DEFAULT_SUBNET_ABB：工位6 实测在 `192.168.1`（本室第二个网段）
    abbSubnet06: textFlag('abb-subnet06', '192.168.1'),
    abbIdentity07Path: textFlag('abb-identity07', join(PERIPHERAL_ROOT, 'config', 'abb-station07-identity.json')),
    abbSubnet07: textFlag('abb-subnet07', DEFAULT_SUBNET_ABB),
    abbIdentity08Path: textFlag('abb-identity08', join(PERIPHERAL_ROOT, 'config', 'abb-station08-identity.json')),
    abbSubnet08: textFlag('abb-subnet08', DEFAULT_SUBNET_ABB),
    abbIdentity09Path: textFlag('abb-identity09', join(PERIPHERAL_ROOT, 'config', 'abb-station09-identity.json')),
    // ★ 缺省**不是** DEFAULT_SUBNET_ABB：工位9 实测在 `192.168.0`（本室第三个网段）
    abbSubnet09: textFlag('abb-subnet09', '192.168.0'),
    abbIdentity10Path: textFlag('abb-identity10', join(PERIPHERAL_ROOT, 'config', 'abb-station10-identity.json')),
    abbSubnet10: textFlag('abb-subnet10', DEFAULT_SUBNET_ABB),
    abbIdentity11Path: textFlag('abb-identity11', join(PERIPHERAL_ROOT, 'config', 'abb-station11-identity.json')),
    abbSubnet11: textFlag('abb-subnet11', DEFAULT_SUBNET_ABB),
    abbIdentity12Path: textFlag('abb-identity12', join(PERIPHERAL_ROOT, 'config', 'abb-station12-identity.json')),
    abbSubnet12: textFlag('abb-subnet12', DEFAULT_SUBNET_ABB),
    ...(flags.has('connector-token') && String(flags.get('connector-token')).trim() !== ''
      ? { connectorToken: String(flags.get('connector-token')).trim() }
      : {}),
    // seat-svc 的令牌（与 connector-token 是两回事，见字段注释）
    ...(flags.has('seat-token') && String(flags.get('seat-token')).trim() !== ''
      ? { seatToken: String(flags.get('seat-token')).trim() }
      : {}),
    interfaceKeyword: textFlag('if-keyword', DEFAULT_INTERFACE_KEYWORD),
    pollIntervalMs: numberFlag('poll-ms', MIN_POLL_INTERVAL_MS),
    listenIntervalMs: numberFlag('listen-ms', DEFAULT_LISTEN_INTERVAL_MS),
    listenSeconds: numberFlag('listen-sec', DEFAULT_LISTEN_SECONDS),
    // 缺省**不启用**：单进程模式下没有 8734，硬投会刷满失败日志。
    // 四节看板形态下由启动命令显式给出 `--device-base=http://127.0.0.1:8734`。
    ...(flags.has('device-base') && String(flags.get('device-base')).trim() !== ''
      ? { deviceBaseUrl: String(flags.get('device-base')).trim() }
      : {}),
  };
}

const CONFIG = readArgs(process.argv.slice(2));

function log(line: string): void {
  console.log(`[site-live] ${line}`);
}

/* --------------------------------------------------------------- 审计出口 */

/** 追加写 JSONL 的审计出口：真实落盘；写失败只计数 + 限频记日志，绝不抛穿采集循环。 */
function createJsonlAuditSink(path: string): AuditSink & { stats(): { written: number; failed: number } } {
  let written = 0;
  let failed = 0;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    log(`审计目录创建失败（后续每条审计都会计入 failed）：${describe(error)}`);
  }
  return {
    record(entry: AuditEntry): void {
      try {
        appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
        written += 1;
      } catch (error) {
        failed += 1;
        if (failed === 1 || failed % AUDIT_FAILURE_LOG_EVERY === 0) {
          log(`审计写入失败 ${failed} 次（已计数，不影响采集）：${describe(error)}`);
        }
      }
    },
    stats: () => ({ written, failed }),
  };
}

/* --------------------------------------------------------------- 告警出口 */

/**
 * 到 alarm-svc 的最小事件形状（`services/alarm-svc/src/types.ts` 的 `AlarmEvent` 镜像）。
 *
 * 与 `device-collector/src/alarm-forwarder.ts` 同一做法：**本地镜像声明**而不是跨包
 * import——采集/装配侧与报警服务是两个包，反向 import 会让依赖图成环；契约一致性由
 * 真调真实 HTTP 入口来证明。
 */
interface AlarmServiceEvent {
  eventId: string;
  stationCode: string;
  labCode: string;
  alarmCode: string;
  alarmLevel: 'info' | 'warning' | 'fault';
  message: string;
  atMs: number;
  sourceKind: 'real';
  simulated: boolean;
  params: Record<string, unknown>;
}

/** `DeviceAlarmEvent.kind` → 默认等级（S07 侧未给等级时的兜底；改这里一处即可）。 */
const LEVEL_BY_KIND: Readonly<Record<DeviceAlarmEvent['kind'], AlarmServiceEvent['alarmLevel']>> = {
  'source-violation': 'fault',
  'mass-offline': 'fault',
  deviation: 'warning',
  'device-alarm': 'info',
};

/** 未带 `alarmCode` 的告警用确定性码位（alarm-svc 对未登记码标记 `unmapped`，不拒收）。 */
const FALLBACK_ALARM_CODE_PREFIX = 'DSH-ADAPTER';

interface AlarmSinkStats {
  attempted: number;
  accepted: number;
  failed: number;
  lastError?: string;
}

/**
 * POST 到 alarm-svc `/alarm/v1/events` 的告警出口。
 *
 * fire-and-forget（`AlarmSink.raise` 是同步签名）：**永不抛出、永不 reject**，网络失败、
 * 上游拒绝、超时都收敛成计数 + 日志——与 `AlarmForwarder` 同一条纪律：报警是旁路，
 * 它挂了不能让采集停摆。
 */
function createHttpAlarmSink(options: {
  baseUrl: string;
  sourceId: string;
  timeoutMs: number;
}): AlarmSink & { stats(): AlarmSinkStats } {
  const endpoint = `${options.baseUrl.trim().replace(/\/+$/, '')}/alarm/v1/events`;
  let attempted = 0;
  let accepted = 0;
  let failed = 0;
  let lastError: string | undefined;

  async function send(event: AlarmServiceEvent): Promise<void> {
    attempted += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      const text = await response.text();
      let envelope: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) envelope = parsed as Record<string, unknown>;
      } catch {
        envelope = undefined;
      }
      const result = envelope?.['result'];
      const acceptedByUpstream =
        response.ok && envelope?.['ok'] === true &&
        typeof result === 'object' && result !== null && (result as Record<string, unknown>)['accepted'] === true;
      if (acceptedByUpstream) {
        accepted += 1;
        return;
      }
      failed += 1;
      lastError = `上游未接收（HTTP ${response.status}）：${text.slice(0, 200)}`;
      log(`告警未送达 alarm-svc（已计数）：${lastError}`);
    } catch (error) {
      failed += 1;
      lastError = describe(error);
      log(`告警未送达 alarm-svc（已计数，采集继续）：${lastError}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    raise(alarm: DeviceAlarmEvent): void {
      void send(toAlarmServiceEvent(alarm, options.sourceId));
    },
    stats: () => ({
      attempted,
      accepted,
      failed,
      ...(lastError !== undefined ? { lastError } : {}),
    }),
  };
}

/**
 * S05 告警事件 → alarm-svc 事件。
 *
 * 四处必须显式决定、不能靠缺省：
 *   1. **来源标识**：LAB-05 接入后，"来源"不再是一个全局常量——**按报警归属的工位取**。
 *      报警带有效工位 → 用该工位所属实训室的来源标识；带不出工位 → 用调用方给的兜底来源。
 *      ⚠️ 这条不能省：`SRC-NETDEV-LAB01` 的授权前缀是 `ST-LAB01-`，**装不下 `ST-LAB05-02`**，
 *      用错来源会被 S07 判越权，而错误信息只会说"越权"、不会说"你用错了来源"。
 *   2. `stationCode`：S05 的偏差/批量离线告警**没有工位归属**，而 S07 契约要求工位编码；
 *      归不到工位就落**本室的跨工位编码**（LAB-01 → `ST-LAB01-00`，LAB-05 → `ST-LAB05-00`，
 *      与 `AlarmForwarder.labWideStationCode` 同口径），**不编造**一个具体工位。
 *   3. `alarmCode`：设备级告警用设备自己的码；结构级告警没有码位，用 `kind` 派生确定性码位。
 *   4. `eventId`：复用采集器的确定性 id 构造（同一次告警重发得到同一 id）→ 上游
 *      `PARAM-EVENT-DEDUP` 幂等命中，重试安全。
 *
 * ⚠️ **已知局限（如实登记）**：本函数的兜底来源是**单值**的——一个 S05 告警若**既没有工位归属、
 * 又来自 LAB-05 的工位**，在"站内显示"这条路径上会被归到兜底来源的跨工位码。
 * 真实送达 alarm-svc 的主路径**不经这里**：采集器自带 `alarmBaseUrl` 转发，其 `sourceId`
 * 已按工位归属取（见 `createStationRuntime`），因此 S07 侧的授权前缀是正确的。
 * 本条只影响本启动器内存里那份 `liveAlarms` 展示台账。
 */
function toAlarmServiceEvent(alarm: DeviceAlarmEvent, fallbackSourceId: string): AlarmServiceEvent {
  const raw = alarm.stationCode ?? '';
  const stationLab = isValidStationCode(raw) ? LAB_REGISTRY[labCodeOfStation(raw)] : undefined;
  const sourceId = stationLab?.sourceId ?? fallbackSourceId;
  const stationCode = isValidStationCode(raw) ? raw : labWideStationCodeOfSource(sourceId);
  const alarmCode = alarm.alarmCode ?? `${FALLBACK_ALARM_CODE_PREFIX}-${alarm.kind}`;
  const observedAt = toIso(alarm.atMs);
  return {
    eventId: makeEventId(sourceId, stationCode, observedAt, `${alarm.kind}|${alarmCode}|${alarm.message}`),
    stationCode,
    labCode: labCodeOfStation(stationCode),
    alarmCode,
    alarmLevel: alarm.alarmLevel ?? LEVEL_BY_KIND[alarm.kind],
    message: alarm.message,
    atMs: alarm.atMs,
    sourceKind: 'real',
    simulated: alarm.simulated,
    params: {
      sourceId,
      kind: alarm.kind,
      reason: alarm.message,
      ...(alarm.expected !== undefined ? { expected: JSON.stringify(alarm.expected).slice(0, 200) } : {}),
      ...(alarm.actual !== undefined ? { actual: JSON.stringify(alarm.actual).slice(0, 200) } : {}),
    },
  };
}

/* ------------------------------------------------------------- S05 → S01 桥接 */

/**
 * device-adapter（S05）四状态 → board-web（S01）四状态。
 *
 * 依据（读了这两处，不凭空发明）：
 *   - `device-adapter/src/types.ts` `DeviceStatus = 'idle'|'occupied'|'maintenance'|'offline'`（IF-01 §1 契约口径）；
 *   - `board-web/src/types.ts` `StationState = 'available'|'occupied'|'maintenance'|'offline'`
 *     且 `CONTRACT_STATE_ALIASES = { idle: 'available' }`——`idle` 即 `available`，其余三个词两侧逐字相同。
 *
 * 因此这不是"两套词表要翻译"，而是**契约别名在入口处归一化**：本函数把该归一化放在
 * 装配侧一处显式写出（而不是散落 `?? 'available'`），改口径时只需改这一张表。
 */
const STATE_S05_TO_S01: Readonly<Record<DeviceStatus, StationState>> = {
  idle: 'available',
  occupied: 'occupied',
  maintenance: 'maintenance',
  offline: 'offline',
};

/* ------------------------------------------------------------------ 单元清单 */

/**
 * 7 个功能单元的**权威清单**（用户提供口径，每个工位都是这 7 个）。
 *
 * | # | 功能单元 | 主要器件 | 对应 PLC |
 * |---|---|---|---|
 * | 1 | 总控 | S7-1200（PLC1/PLC2 板载）+ 按钮 / E-STOP / 三色灯 | PLC1 |
 * | 2 | 执行 | ABB IRB 120 + IRC5 Compact + 三菱 MR-JE-40A 伺服滑台 | PLC2 / PLC3 |
 * | 3 | 仓储 | 亚德客气缸与磁性开关 + 光电传感器 | PLC2 |
 * | 4 | 加工 | SINUMERIK 828D + 三菱伺服 | PLC3 |
 * | 5 | 打磨 | 亚德客气缸 + 翻转工装 | PLC3 |
 * | 6 | 分拣 | 三菱 FR-D720S 变频器（皮带）+ 亚德客气缸 | PLC2 |
 * | 7 | 检测 | 欧姆龙 FH 视觉（CCD）+ 相机/光源控制器 | PLC2（无远程 IO） |
 *
 * ⚠️ 旧版是 6 个单元（"机器人执行单元"独立成第 6 个、且缺"检测"）：本版按用户口径改为 7 个，
 * **机器人执行归入"执行单元"**，并补上"检测单元"。
 */
interface UnitBase {
  readonly index: number;
  /** 权威中文名 */
  readonly name: string;
  /** 主要器件（用户口径原文） */
  readonly component: string;
  /** 对应 PLC */
  readonly powerPlc: string;
}

const UNIT_BASE: readonly UnitBase[] = [
  { index: 1, name: '总控单元', component: 'S7-1200（PLC1/PLC2 板载）+ 按钮 / E-STOP / 三色灯', powerPlc: 'PLC1' },
  { index: 2, name: '执行单元', component: 'ABB IRB 120 + IRC5 Compact + 三菱 MR-JE-40A 伺服滑台', powerPlc: 'PLC2 / PLC3' },
  { index: 3, name: '仓储单元', component: '亚德客气缸与磁性开关 + 光电传感器', powerPlc: 'PLC2' },
  { index: 4, name: '加工单元', component: 'SINUMERIK 828D + 三菱伺服', powerPlc: 'PLC3' },
  { index: 5, name: '打磨单元', component: '亚德客气缸 + 翻转工装', powerPlc: 'PLC3' },
  { index: 6, name: '分拣单元', component: '三菱 FR-D720S 变频器（皮带）+ 亚德客气缸', powerPlc: 'PLC2' },
  { index: 7, name: '检测单元', component: '欧姆龙 FH 视觉（CCD）+ 相机/光源控制器', powerPlc: 'PLC2（无远程 IO）' },
];

/**
 * 某工位某单元的**归属证据**。
 *
 * `observedMac` **只有归属有证据时才写**：写空 = 归属未证实 →
 * 单元状态显示「归属未确认」，**不套用任何设备状态**（既不当作在线，也不当作空闲）。
 */
interface UnitSite {
  /** 现场观测到的站名代号（拼音首字母推断，未经厂商确认）；未观测到写 `UNIT_CODE_UNOBSERVED` */
  readonly code: string;
  /** 归属依据（可追溯，不得空） */
  readonly evidence: string;
  readonly observedMac?: string;
}

const STATION1_UNIT_SITE: Readonly<Record<number, UnitSite>> = {
  1: {
    code: 'zx',
    evidence:
      '接线图前缀 ZK=总控单元（PLC1/PLC2 板载 E-STOP、按钮、三色灯）。工位1 已观测的 4 台设备中**无一台**有指向本单元的证据 ⇒ 归属未确认',
  },
  2: {
    code: UNIT_CODE_UNOBSERVED,
    evidence:
      '出厂点表 执行模块（ABB IRB 120 + IRC5 Compact + 三菱 MR-JE-40A 伺服滑台）。ABB 机器人在 192.168.126/125 两个网段 ARP+DCP 均 0 台（不在网）⇒ 归属未确认',
  },
  3: {
    code: 'cc',
    evidence: '接线图前缀 CC=仓储单元；出厂点表 仓储模块。已观测设备中无指向本单元的证据 ⇒ 归属未确认',
  },
  4: {
    code: 'cnc',
    evidence:
      '出厂点表 加工模块（SINUMERIK 828D + 三菱伺服）。工位1 本轮未观测到 CNC（828D 实测在工位3 `.110`）⇒ 归属未确认',
  },
  5: {
    code: 'dm',
    evidence: '接线图前缀 DM=打磨单元；出厂点表 打磨模块。本轮未观测到对应设备 ⇒ 归属未确认',
  },
  6: {
    code: 'fj',
    evidence:
      'LLDP 邻居 `fj`(.3) port-001 ↔ plcxb2d1ad ⇒ `.100` 是分拣单元控制器（台账 §2.3 / §1.5-5）；`.100` 的接口 MAC E0-DC-A0-74-F1-06 属本工位台账 ⇒ 归属已确认',
    observedMac: 'E0-DC-A0-74-F1-06',
  },
  7: {
    code: UNIT_CODE_UNOBSERVED,
    evidence: '出厂资料：欧姆龙 FH 视觉（CCD）+ 相机/光源控制器（对应 PLC2，无远程 IO）。已观测设备中无指向本单元的证据 ⇒ 归属未确认',
  },
};

const STATION2_UNIT_SITE: Readonly<Record<number, UnitSite>> = {
  1: { code: UNIT_CODE_UNOBSERVED, evidence: '工位2 已观测的 2 台设备（S7-1200 `.20`、Phoenix IO 从站 `.21`）均无指向本单元的证据 ⇒ 归属未确认' },
  2: { code: UNIT_CODE_UNOBSERVED, evidence: '工位2 实测未发现 ABB 机器人（其网段 192.168.126/125 未纳入本次观测）⇒ 归属未确认' },
  3: { code: UNIT_CODE_UNOBSERVED, evidence: '工位2 实测仅 1 台 IO 从站（`.21`，DCP 站名 `HDC`、类型字段 `hdcxb1c90f`），无单元级线索 ⇒ 归属未确认' },
  4: { code: UNIT_CODE_UNOBSERVED, evidence: '工位2 实测未发现 SINUMERIK 828D（工位2 无数控系统）⇒ 归属未确认' },
  5: { code: UNIT_CODE_UNOBSERVED, evidence: '工位2 实测未发现对应设备（IO 从站仅 1 台，站名 `HDC` 不能指向具体单元）⇒ 归属未确认' },
  6: { code: UNIT_CODE_UNOBSERVED, evidence: '工位2 实测未发现分拣单元对应设备（对比工位1：分拣的硬证据是 LLDP 邻居 `fj`(.3) ↔ plcxb2d1ad，工位2 无同类证据）⇒ 归属未确认' },
  7: { code: UNIT_CODE_UNOBSERVED, evidence: '工位2 实测未发现视觉/相机控制器 ⇒ 归属未确认' },
};

/**
 * 工位3 的单元归属：**7 个单元全部「归属未确认」**（一轮实测量都写在 evidence 里，逐条可回溯）。
 *
 * ⚠️ 为什么不一刀切套设备状态（本轮最关键的一条纪律）：
 * 工位3 **确实**观测到了"能对上单元"的嫌疑设备（`00-A0-45-00-15-04` 的 `deviceType` 是 `fj`＝分拣、
 * `…-18-26` 是 `dm`＝打磨、`…-18-73` 是 `jg`＝加工、`.110` 是 SINUMERIK 828D＝加工），
 * 但**本工位没有任何接线台账佐证**：这些"代号"是拼音首字母推断，`HDC` 每工位内即重复，
 * 且 8 台设备的物理位置（接在哪台 PLC 的哪个端口）无人核对过。
 * 因此按任务口径：**只有归属有证据的单元才套设备状态**，其余如实写「归属未确认」——**不瞎配**。
 * （工位1 保持现状：仅"分拣单元"有 LLDP 邻居链证据。）
 */
const STATION3_UNIT_SITE: Readonly<Record<number, UnitSite>> = {
  1: {
    code: UNIT_CODE_UNOBSERVED,
    evidence:
      '工位3 实测 8 台设备（828D `.110`、S7-1200 `.103`、`.121` 双机、IO 从站 `.2/.3/.5/192.168.16.12`）中**无一台**有指向总控单元的证据；站名 `HDC` 每工位内重复，不能指向具体单元 ⇒ 归属未确认',
  },
  2: {
    code: UNIT_CODE_UNOBSERVED,
    evidence:
      '执行单元 = ABB IRB 120 + IRC5 Compact + 三菱 MR-JE-40A 伺服滑台。工位3 本轮未在 192.168.0/24 观测到 ABB 机器人（其通常在 192.168.125/126）⇒ 归属未确认',
  },
  3: { code: UNIT_CODE_UNOBSERVED, evidence: '工位3 实测未观测到可指向仓储单元的确定设备（IO 从站站名均为 `HDC`，无单元级线索）⇒ 归属未确认' },
  4: {
    code: 'jg',
    evidence:
      '工位3 **有嫌疑设备**：`192.168.0.110`（SINUMERIK 828D PPU241.3，MAC `00-1C-06-4B-EC-5A`，端口 102/22/4840/5900）是数控系统，加工单元的主要器件；`00-A0-45-00-18-73`(.5) 的 `deviceType` 为 `jg`。**但本工位无接线台账佐证**（代号靠拼音首字母推断、`HDC` 重复、物理接线未核对）⇒ 归属未确认，不套设备状态',
  },
  5: { code: 'dm', evidence: '工位3 `00-A0-45-00-18-26`(.3) 的 `deviceType` 为 `dm`（疑＝打磨）。同上：**无接线台账佐证** ⇒ 归属未确认，不套设备状态' },
  6: { code: 'fj', evidence: '工位3 `00-A0-45-00-15-04`(.2) 的 `deviceType` 为 `fj`（疑＝分拣）。同上：**无接线台账佐证**（工位1 的分拣归属是靠 LLDP 邻居链 `fj`(.3) ↔ plcxb2d1ad 证实的，工位3 无同类证据）⇒ 归属未确认，不套设备状态' },
  7: { code: UNIT_CODE_UNOBSERVED, evidence: '工位3 实测未观测到视觉/相机/光源控制器（检测单元对应 PLC2，无远程 IO，属"看不见"的单元）⇒ 归属未确认' },
};

/**
 * 工位4 的单元归属：**7 个单元全部「归属未确认」**。
 *
 * 工位4 只观测到 4 台设备：1 台 IO 从站（`.5`，`deviceType xn--dqun75f`）、2 台 S7-1200（`.101`/`.103`）、
 * 1 台工位机（`STU-02`，无 IP）。其中唯一有可能指向单元的线索是 `xn--dqun75f`，
 * 而它是 punycode 形态、**未解码确认**，且与工位3 的拼音首字母代号（`fj`/`dm`/`jg`）**不同源** ⇒ 不猜。
 */
const STATION4_UNIT_SITE: Readonly<Record<number, UnitSite>> = {
  1: { code: UNIT_CODE_UNOBSERVED, evidence: '工位4 实测 4 台设备（IO 从站 `.5`、S7-1200 `.101`/`.103`、工位机 STU-02）中无一台有指向总控单元的证据 ⇒ 归属未确认' },
  2: { code: UNIT_CODE_UNOBSERVED, evidence: '执行单元 = ABB IRB 120 + IRC5 Compact + 三菱 MR-JE-40A 伺服滑台。工位4 本轮未观测到 ABB 机器人 ⇒ 归属未确认' },
  3: { code: UNIT_CODE_UNOBSERVED, evidence: '工位4 实测未观测到可指向仓储单元的确定设备（仅 1 台 IO 从站，站名 `HDC`）⇒ 归属未确认' },
  4: { code: UNIT_CODE_UNOBSERVED, evidence: '工位4 实测未观测到 SINUMERIK 828D（828D 实测在工位3 `.110`）⇒ 归属未确认' },
  5: {
    code: UNIT_CODE_UNOBSERVED,
    evidence:
      '工位4 **有嫌疑设备但证据不足**：唯一那台 IO 从站 `192.168.0.5`（MAC `00-A0-45-00-18-1D`，站名 `HDC`）的 `deviceType` 为 `xn--dqun75f`——**punycode 形态，未解码确认**，且与工位3 的拼音首字母代号不同源 ⇒ 归属未确认，不套设备状态',
  },
  6: { code: UNIT_CODE_UNOBSERVED, evidence: '工位4 实测未观测到分拣单元对应设备（分拣的硬证据形态是 LLDP 邻居链，工位4 无同类证据）⇒ 归属未确认' },
  7: { code: UNIT_CODE_UNOBSERVED, evidence: '工位4 实测未观测到视觉/相机/光源控制器 ⇒ 归属未确认' },
};


interface UnitSpec extends UnitBase, UnitSite {}

/** 某工位的 7 个单元（权威名 + 主要器件 + PLC + 现场站名代号 + 归属证据） */
function unitsOf(site: Readonly<Record<number, UnitSite>>): readonly UnitSpec[] {
  return UNIT_BASE.map((base) => {
    const entry = site[base.index];
    if (entry === undefined) throw new Error(`单元清单缺第 ${base.index} 个单元的归属证据`);
    return { ...base, ...entry };
  });
}

/* ------------------------------------- LAB-05 的设备组成（**教材口径的 7 类器件**） */

/**
 * ★★ LAB-05 单工位的**设备组成**（教材《ABB中级工业机器人应用编程》口径）。
 *
 * 用户 2026-09-24 明确：**12 个工位的组成是同一套**，这是**设计事实**，不是推测。
 * 一套工位 = 7 类器件：
 *
 * | # | 器件 | 型号 | 固件 | 作用 | 二层扫描能否看到 |
 * |---|---|---|---|---|---|
 * | 1 | PLC | CPU 1215C DC/DC/DC | 4.2（考核环境 4.1） | 工位总控 | ✅ 能（主键） |
 * | 2 | RFID | RF120C | 1.0 | 读写电子标签、记工序 | ❌ 看不到 |
 * | 3 | 串口通讯 | CM 1241（RS422/485） | 2.1 | 驱动伺服/步进 | ❌ 看不到 |
 * | 4 | HMI | TP700 Comfort | 15.0.0.0 | 人机操作面板 | ✅ 能 |
 * | 5 | 相机（视觉） | In-Sight IS2XXX / IS2000 | 5.3.0 | 视觉定位检测 | ✅ 能 |
 * | 6 | 机器人 | ABB（IRC5 Compact 控制器） | — | 执行本体 | ✅ 能 |
 * | 7 | 以太网 I/O 模块 | TCP-507T | — | 8 路 DI，采库位信号 | ✅ 能 |
 *
 * ## 为什么替换掉原来的「6 个执行模块」
 *
 * 原实现列的是教材「2 执行机构与数据接口」章的 6 个**功能模块**
 * （旋转供料/仓储/变位机/行走轴/RFID/自定义数据）。那是**机器人↔PLC 的数据接口划分**，
 * 不是**设备组成**；而且它把 PLC 机架上的 RFID 与"自定义数据报文段"混在一起当"模块"列，
 * 现场对着设备盘点时对不上号。
 *
 * 现在按用户要求改为**按器件列**（PLC / RFID / CM1241 / HMI / 相机 / 机器人 / IO 模块），
 * 与现场实物一一对应。
 *
 * ## ⚠️ 二层可见性必须标出来（否则必然被误读成"缺失"）
 *
 * 7 类里 **RFID 与 CM1241 是 PLC 机架上的插槽模块**（101 / 102 槽），
 * **没有独立 IP、不走以太网** ⇒ 任何 ARP/DCP/LLDP/端口探测都**不可能**看到它们。
 * 不写明这一点，现场看到"扫不到 RFID"就会以为设备缺了 —— 这是"看不见 ≠ 不存在"。
 */
const ABB_UNIT_BASE: readonly UnitBase[] = [
  {
    index: 1,
    name: 'PLC',
    component: 'CPU 1215C DC/DC/DC（固件 4.2，考核环境 4.1）— 工位总控',
    powerPlc: '本器件即控制器本体',
  },
  {
    index: 2,
    name: 'RFID',
    component: 'RF120C（固件 1.0）— 读写电子标签、记工序｜机架插槽 101',
    powerPlc: '本器件为 PLC 机架上的插槽模块，无独立 IP / 不走以太网 ⇒ 二层扫描看不到',
  },
  {
    index: 3,
    name: '串口通讯',
    component: 'CM 1241（RS422/485，固件 2.1）— 驱动伺服 / 步进｜机架插槽 102',
    powerPlc: '本器件为 PLC 机架上的插槽模块，无独立 IP / 不走以太网 ⇒ 二层扫描看不到',
  },
  {
    index: 4,
    name: 'HMI',
    component: 'TP700 Comfort（固件 15.0.0.0）— 人机操作面板',
    powerPlc: '接入工位以太网',
  },
  {
    index: 5,
    name: '相机（视觉）',
    component: 'In-Sight IS2XXX / IS2000（固件 5.3.0）— 视觉定位检测',
    powerPlc: '接入工位以太网（ABB 平台下由机器人直接控制，不经 PLC）',
  },
  {
    index: 6,
    name: '机器人',
    component: 'ABB（控制器 IRC5 Compact）— 执行本体',
    powerPlc: '接入工位以太网（Socket 客户端）',
  },
  {
    index: 7,
    name: '以太网 I/O 模块',
    component: 'TCP-507T — 8 路 DI，采库位信号（Modbus-TCP，寄存器起始 10001）',
    powerPlc: '接入工位以太网（Modbus-TCP 从站）',
  },
];

/**
 * LAB-05 工位2 各器件的**归属证据**。
 *
 * ⚠️ 七条全部「归属未确认」，理由分四类（**逐条写清是哪一类，不写套话**）：
 *   ① 该器件在二层**根本观测不到**（RF120C / CM1241 是 PLC 机架插槽模块，没有自己的 IP/MAC）
 *      —— 这是"看不见 ≠ 不存在"，**不能**因为没扫到就说它不在；
 *   ② 该器件**依赖的 IP 设备当时不在网**（如视觉相机、IO 模块实测 0 应答）；
 *   ③ 该器件**与其他器件共用同一台 PLC**，二层观测不到"是哪一类器件在通信"；
 *   ④ 工位2 实测只到 PLC + 一台身份未证实的西门子设备，不足以把任何一类器件判为"已归属"。
 *
 * ★ 判据：**只有归属有证据的器件才套设备状态**；否则既不当作在线，也不当作空闲。
 */
const STATION_ABB02_UNIT_SITE: Readonly<Record<number, UnitSite>> = {
  1: {
    code: UNIT_CODE_UNOBSERVED,
    evidence:
      '★ 工位2 实测到 **S7-1200 CPU 1215C**（`192.168.101.13`，MAC `E0-DC-A0-BE-A0-72`，站名 `plcxb1d0ed`，固件 V4.4.0）。' +
      '器件型号与教材一致（1215C），但**固件为 V4.4.0**（教材写 4.2 / 考核环境 4.1）—— 属实测事实，如实记录',
  },
  2: {
    code: UNIT_CODE_UNOBSERVED,
    evidence:
      '★ **本器件在二层根本观测不到**：RFID RF120C 是 PLC **机架插槽 101** 上的模块，**没有自己的 IP/MAC**，' +
      '任何 ARP/DCP/LLDP/端口探测都不可能看到它 ⇒ 归属未确认。' +
      '⚠️ 这是"看不见 ≠ 不存在"的典型：不得因为扫描结果里没有 RFID 就写它缺失',
  },
  3: {
    code: UNIT_CODE_UNOBSERVED,
    evidence:
      '★ **本器件在二层根本观测不到**：CM 1241（RS422/485）是 PLC **机架插槽 102** 上的串口模块，' +
      '**没有独立 IP、不走以太网** ⇒ 二层扫描永远看不到，属正常现象，**不代表缺失**',
  },
  4: {
    code: UNIT_CODE_UNOBSERVED,
    evidence:
      '工位2 实测有**一台身份未证实的西门子设备**（`192.168.101.10`，MAC `E0-DC-A0-CE-AD-B0`，仅开 102，无 DCP/LLDP 自报）。' +
      '教材规划 HMI 在 `.10`，**地址吻合**，但该设备**没有任何自报身份**，无法确证它就是 TP700 ⇒ 归属未确认',
  },
  5: {
    code: UNIT_CODE_UNOBSERVED,
    evidence:
      '★ **依赖设备当时不在网**：教材规划视觉相机在 `192.168.101.50`（In-Sight）。2026-09-23 实测该地址 **0 应答**。' +
      '按纪律「0 应答只说明当时不在网，不等于不存在」，**不能据此认定该器件缺失**，故只写归属未确认',
  },
  6: {
    code: UNIT_CODE_UNOBSERVED,
    evidence:
      '教材规划机器人控制器在 `192.168.101.100`（Socket 客户端）。工位2 实测该地址 **0 应答**（ARP 无、端口全关），' +
      '也未在被动监听中抓到 ABB 厂商 OUI（`00-00-23`）的 MAC ⇒ 当时不在网，归属未确认',
  },
  7: {
    code: UNIT_CODE_UNOBSERVED,
    evidence:
      '★ **依赖设备当时不在网**：教材规划以太网 IO 模块 TCP-507T 在 `192.168.101.75`（Modbus-TCP，8 路 DI）。' +
      '2026-09-23 实测 `.75` **0 端口应答且无 ARP** ⇒ 当时不在网。按纪律「0 应答只说明当时不在网，不等于不存在」，' +
      '**不能据此认定该器件缺失**，故只写归属未确认',
  },
};

/**
 * LAB-05 工位2 的 7 类器件。
 *
 * 与 `unitsOf` 同形但**用本室自己的清单**；调用方按工位归属选清单（见 `ALL_STATIONS`）。
 * 目前本室只有工位2 接入，故不需按工位区分 site 表；日后多工位实测时
 * 把 `site` 提成参数即可（形如 `unitsOf`）。
 */
function abbUnitsOf(
  site: Readonly<Record<number, UnitSite>> = STATION_ABB02_UNIT_SITE,
): readonly UnitSpec[] {
  return ABB_UNIT_BASE.map((base) => {
    const entry = site[base.index];
    if (entry === undefined) throw new Error(`LAB-05 器件清单缺第 ${base.index} 项器件的归属证据`);
    return { ...base, ...entry };
  });
}

/* ------------------------------------------------------------------ 工位定义 */

interface StationSpec {
  readonly stationCode: string;
  readonly name: string;
  /**
   * 本工位所属实训室。**决定来源标识与跨工位报警编码**（见 `LAB_REGISTRY`），
   * 采集、上报、S07 授权前缀全部由它推导——不再有"全局 SOURCE_ID"这回事。
   */
  readonly labCode: string;
  readonly subnet: string;
  readonly identityPath: string;
  readonly units: readonly UnitSpec[];
}

/**
 * LAB-01（智能制造系统集成实训室）的工位清单（**数组/配置驱动**）：
 * 目录、采集器、页面分块全部由这张表生成。
 *
 * 加一个工位 = 这里加一条 + `readArgs` 加一组 `--subnetN/--identityN`。
 * 采集、桥接、聚合、页面渲染**都不需要改**——它们只看 `StationSpec`。
 *
 * ⚠️ 顺序即页面顺序；`runtimes[0]` 被 `/station1/data.json` 当作"工位1"用（旧扁平形状兼容），
 * 因此**工位1 必须排在第一位**。
 *
 * ★ 本表**只管 LAB-01**。第二个实训室的工位在 `ABB_STATIONS`，两者由 `ALL_STATIONS` 合起来跑采集——
 * 这是 LAB-05 接入时唯一需要"新增"的结构（既有采集/桥接/聚合/页面代码一行未改）。
 */
const STATIONS: readonly StationSpec[] = [
  {
    stationCode: STATION1_CODE,
    name: '工位1',
    labCode: LAB_CODE,
    subnet: CONFIG.subnet1,
    identityPath: CONFIG.identity1Path,
    units: unitsOf(STATION1_UNIT_SITE),
  },
  {
    stationCode: STATION2_CODE,
    name: '工位2',
    labCode: LAB_CODE,
    subnet: CONFIG.subnet2,
    identityPath: CONFIG.identity2Path,
    units: unitsOf(STATION2_UNIT_SITE),
  },
  {
    stationCode: STATION3_CODE,
    name: '工位3',
    labCode: LAB_CODE,
    subnet: CONFIG.subnet3,
    identityPath: CONFIG.identity3Path,
    units: unitsOf(STATION3_UNIT_SITE),
  },
  {
    stationCode: STATION4_CODE,
    name: '工位4',
    labCode: LAB_CODE,
    subnet: CONFIG.subnet4,
    identityPath: CONFIG.identity4Path,
    units: unitsOf(STATION4_UNIT_SITE),
  },
];

/**
 * ★ 登记表与工位表**必须一致**，不一致就拒绝启动。
 *
 * 为什么要有这条断言：`LAB_REGISTRY` 定义在文件更早处（那时 `STATIONS` 还在 TDZ 里，
 * 取不到 `.length`），所以 LAB-01 的 `stationCount` 是**手写常量**。
 * 手写常量会漂——加了工位却忘改登记表，启动日志和目录里的"已接入 N/M"就会骗人，
 * 而这种骗人是**静默**的。宁可直接抛出来。
 */
if (LAB_REGISTRY[LAB_CODE]?.stationCount !== STATIONS.length) {
  throw new Error(
    `LAB_REGISTRY 的 ${LAB_CODE} 工位数（${String(LAB_REGISTRY[LAB_CODE]?.stationCount)}）` +
      `与 STATIONS 实际条数（${STATIONS.length}）不一致：请同步登记表`,
  );
}

/**
 * ★ LAB-05（工业机器人应用技术实训室 ABB）**已接入采集**的工位清单。
 * 目前只有 1 条 —— **工位2**：2026-09-23 现场逐台接线实测过，台账
 * `config/abb-station02-identity.json`（MAC 主键，2 台设备）。
 * 其余 11 个工位**一台设备都没实测**，按纪律**不编台账、不建 runtime**，
 * 只在目录与 `pendingLab` 里如实呈现为「未接入采集」。
 *
 * ★ 这就是"复用 LAB-01 的做法"的全部含义：**同一种台账 + 同一套采集器**，
 * 差别只有"本室有自己的网段、自己的来源标识、自己的单元清单"三点，且三点都由数据给出。
 *
 * ⚠️ 工位编号的**证据等级**：编号来自用户口述（探测机当时接在工位2），
 * 未与工位标牌/接线图核对 —— 完整 provenance 见台账 `_meta.station_attribution_provenance`。
 * ⚠️ 本室 12 个工位**组建模相同、但地址是否相同无证据裁决**（见 `ABB_STATION_COMPOSITION.designNote`）：
 * 本清单里 `subnet` 取本室实测网段 `192.168.101`，**不是**把教材的 5 个 IP 复制 12 份。
 */
const ABB_STATIONS: readonly StationSpec[] = [
  {
    /**
     * ★ 工位1（2026-09-24 接入）：**现场作业受阻**，台账为空。
     *
     * 受阻原因：设备总电源开关损坏，整个工位设备上不了电。
     * 给它建页签是为了让**设备组成**（教材口径 7 类器件）能展示 ——
     * 组成是**设计事实**，与是否实测到设备无关；
     * 而设备台账 `entries: []` 如实表示「本轮未取得数据」，**不是**「该工位没有设备」。
     */
    stationCode: 'ST-LAB05-01',
    name: '工位1',
    labCode: ABB_LAB_CODE,
    subnet: CONFIG.abbSubnet01,
    identityPath: CONFIG.abbIdentity01Path,
    units: abbUnitsOf(),
  },
  {
    stationCode: 'ST-LAB05-02',
    name: '工位2',
    labCode: ABB_LAB_CODE,
    subnet: CONFIG.abbSubnet,
    identityPath: CONFIG.abbIdentity02Path,
    units: abbUnitsOf(),
  },
  {
    /**
     * ★ 工位3（2026-09-24 接入）：**现场作业受阻**，台账为空。
     *
     * 受阻原因：网线连接不通（LinkSpeed=0 bps、AdminStatus=Up ⇒ 物理链路未建立）。
     * 同工位1：页签与设备组成照常展示，设备清单如实标「本轮未取得数据」。
     */
    stationCode: 'ST-LAB05-03',
    name: '工位3',
    labCode: ABB_LAB_CODE,
    subnet: CONFIG.abbSubnet03,
    identityPath: CONFIG.abbIdentity03Path,
    units: abbUnitsOf(),
  },
  {
    /**
     * ★ 工位4（2026-09-24 接入）：2026-09-23 现场实测归档。
     *
     * 本室**首次实证 ABB 机器人存在**的工位（`00-00-23-38-55-C0` = ABB 厂商 OUI）。
     * 另测得：PLC `…-A3-F8`（**开放 2001 ⇒ PLC 程序在跑**）+ 疑HMI `…-B1-4D` + 研华 `74-FE-48-…`。
     * ⚠️ 后三台**都没有 IP**，二层 scan 采不到，靠页面的「无法采集」通道如实展示。
     */
    stationCode: 'ST-LAB05-04',
    name: '工位4',
    labCode: ABB_LAB_CODE,
    subnet: CONFIG.abbSubnet04,
    identityPath: CONFIG.abbIdentity04Path,
    units: abbUnitsOf(),
  },
  {
    /**
     * ★ 工位5（2026-09-24 接入）：**现场作业受阻**，台账为空。
     *
     * 受阻原因：设备开关有问题（设备未能正常上电）。
     * ⚠️ 另登记一次采样纠错：16:07 曾把**同一口的重复扫描**误记为工位5 ⇒ 数据作废；
     * 16:15–16:20 那轮「工位5」**实为工位6**，已按工位6 归档。⇒ 工位5 至今无有效数据。
     */
    stationCode: 'ST-LAB05-05',
    name: '工位5',
    labCode: ABB_LAB_CODE,
    subnet: CONFIG.abbSubnet05,
    identityPath: CONFIG.abbIdentity05Path,
    units: abbUnitsOf(),
  },
  {
    /**
     * ★ 工位6（2026-09-24 接入）：2026-09-23 现场实测归档，本室**第二个网段** `192.168.1.0/24`。
     *
     * PLC **自己在 LLDP 里自报 `managementAddress = 192.168.1.50`** —— 设备自报的硬证据。
     * 另测得：疑HMI `…-CD-43-99`（`.101.10`）+ 树莓派 `DC-A6-32-…`（**教材 BOM 无此设备**）。
     * ⚠️ 该工位**同时可见**一台 `192.168.101.10` 的设备 ⇒ 本口两层域跨两个网段，
     * 不能因为看到 `.101.10` 就说「工位6 也在 `.101` 段」。
     */
    stationCode: 'ST-LAB05-06',
    name: '工位6',
    labCode: ABB_LAB_CODE,
    subnet: CONFIG.abbSubnet06,
    identityPath: CONFIG.abbIdentity06Path,
    units: abbUnitsOf(),
  },
  {
    // ★ 工位7（2026-09-23 现场实测接入）：PLC `E0-DC-A0-BE-B2-AE` + ABB 机器人 `00-00-23-38-44-C5`
    //   + 研华工控机 `74-FE-48-47-03-2A`。网段与工位2 同段（`.101`），但仍逐位给出以便覆盖。
    stationCode: 'ST-LAB05-07',
    name: '工位7',
    labCode: ABB_LAB_CODE,
    subnet: CONFIG.abbSubnet07,
    identityPath: CONFIG.abbIdentity07Path,
    units: abbUnitsOf(),
  },
  {
    // ★ 工位8（2026-09-23 现场实测接入）：本室**首个抓到 In-Sight 相机**的工位。
    //   PLC `E0-DC-A0-BE-A0-B2` + 相机 `00-D0-24-72-00-93`（未配 IP，仅 DCP+LLDP 可见）
    //   + ABB 机器人 + 研华 + 树莓派 + 疑HMI。
    //   ⚠️ 其中 4 台**无 IP** ⇒ 二层 scan 采不到，靠页面的「无法采集」通道如实展示。
    stationCode: 'ST-LAB05-08',
    name: '工位8',
    labCode: ABB_LAB_CODE,
    subnet: CONFIG.abbSubnet08,
    identityPath: CONFIG.abbIdentity08Path,
    units: abbUnitsOf(),
  },
  {
    // ★ 工位9（2026-09-23 现场实测接入）：本室**第三个网段** `192.168.0.0/24`。
    //   PLC `E0-DC-A0-BE-B1-CC`（IP `192.168.0.1`） + 疑HMI + 树莓派。
    //   ⚠️⚠️ 该网段与 **LAB-01 完全相同** ⇒ 归属只能靠 MAC，仅凭 IP 必然串台。
    //   ⚠️ 本轮**未观测到**相机 / ABB 机器人 / 研华（可能未上电），按纪律不编写台账。
    stationCode: 'ST-LAB05-09',
    name: '工位9',
    labCode: ABB_LAB_CODE,
    subnet: CONFIG.abbSubnet09,
    identityPath: CONFIG.abbIdentity09Path,
    units: abbUnitsOf(),
  },
  {
    // ★ 工位10（2026-09-23 现场实测接入）：PLC `E0-DC-A0-BF-0A-0E`（S/N `V-M4CB7718`）
    //   + 疑HMI + ABB 机器人 + 研华 + 树莓派。网段 `.101`。
    //   ⚠️ 后 3 台**无 IP** ⇒ 靠页面的「无法采集」通道如实展示。
    stationCode: 'ST-LAB05-10',
    name: '工位10',
    labCode: ABB_LAB_CODE,
    subnet: CONFIG.abbSubnet10,
    identityPath: CONFIG.abbIdentity10Path,
    units: abbUnitsOf(),
  },
  {
    // ★ 工位11（2026-09-23 现场实测接入）：PLC `E0-DC-A0-BE-9E-07`（S/N `V-M4C62623`，
    //   站名 `xczbc-plc-keba`）+ 疑HMI（★ IP `.101.2`，非常规 `.10`）+ ABB 机器人 + 研华。
    stationCode: 'ST-LAB05-11',
    name: '工位11',
    labCode: ABB_LAB_CODE,
    subnet: CONFIG.abbSubnet11,
    identityPath: CONFIG.abbIdentity11Path,
    units: abbUnitsOf(),
  },
  {
    // ★ 工位12（2026-09-23 现场实测接入，本轮最后一个）：PLC `E0-DC-A0-BE-A8-7C`
    //   （S/N `V-M4C70299`，站名 `xczbc-plc-keba`）+ ABB 机器人 + 研华 + 树莓派。
    stationCode: 'ST-LAB05-12',
    name: '工位12',
    labCode: ABB_LAB_CODE,
    subnet: CONFIG.abbSubnet12,
    identityPath: CONFIG.abbIdentity12Path,
    units: abbUnitsOf(),
  },
];

/**
 * 目录、采集、桥接、聚合、页面**共用的全部工位**（两室合并）。
 *
 * ⚠️ 不要拿它当"LAB-01 的工位"用：`/station1/data.json`（旧扁平形状）与
 * LAB-01 的目录节点都只认 `STATIONS`——`runtimes[0]` 必须仍是工位1。
 */
const ALL_STATIONS: readonly StationSpec[] = [...STATIONS, ...ABB_STATIONS];

/**
 * LAB-05 **全部 12 个工位的目录节点**（编码 + 名称 + 组成引用 + 是否已接入采集）。
 *
 * ★ 与 LAB-01 的差别只有一处：**目录节点 ≠ 都有采集器**。
 * 本室已接入的工位（`ABB_STATIONS`，目前只有工位2）状态来自真机上报；
 * 其余工位在同一目录下但**不建 runtime、不跑采集**，读屏时是「未接入」——
 * `collector: false` 就是给前端换词用的标志，**不让前端靠"有没有数据"去猜**
 * （"没采到"与"没在采"是两码事，与 A-02 的 `offline` vs `available` 同一条纪律）。
 *
 * ★ 每个节点带 `compositionKey`：本室 12 个工位**组成完全相同**，
 * 因此共用 `ABB_STATION_COMPOSITION` 这一份（**不重复 12 份**，避免内容各说各话）。
 * 注意：组成相同**不代表地址相同**（见该常量的 `designNote`）。
 *
 * 现场每实测一个工位，就往 `ABB_STATIONS` 加一条 + 补 `config/abb-stationNN-identity.json`
 * —— 与 LAB-01 的工位完全同构，页面与采集代码都无需改动。
 */
interface AbbStationNode {
  stationCode: string;
  name: string;
  /** 指向共享的单工位组成（`ABB_STATION_COMPOSITION.key`）；本室 12 工位取值相同 */
  compositionKey: string;
  /**
   * true = 该工位**已接入采集**（有 MAC 台账 + 采集运行时，状态来自真机上报）；
   * false = **未接入**（同一目录下但无采集器）——看板据此换词，不靠"有没有数据"猜。
   */
  collector: boolean;
}

function buildAbbStationNodes(): AbbStationNode[] {
  const measured = new Set(ABB_STATIONS.map((station) => station.stationCode));
  const nodes: AbbStationNode[] = [];
  for (let index = 1; index <= ABB_STATION_COUNT; index += 1) {
    const stationCode = `ST-LAB05-${String(index).padStart(2, '0')}`;
    nodes.push({
      stationCode,
      name: `工位${index}`,
      compositionKey: ABB_STATION_COMPOSITION_KEY,
      collector: measured.has(stationCode),
    });
  }
  return nodes;
}

/**
 * 目录 = 三级浏览：校区 → 实训室 → 工位。
 *
 * ⚠️ 7 个**功能单元不是工位**：它们是工位详情里的 `params`（`unitN.*`），不是目录节点。
 * 旧版把 `ST-LAB01-0N` 借用为"工位1 的第 N 个单元位"，那是错的口径（见文件头 ★）。
 *
 * 本版是**两校区 / 两实训室**：
 * - `CAMPUS-01` 海宁校区 → `LAB-01`（智能制造系统集成，4 工位，有采集器）
 *                         + `LAB-05`（工业机器人应用技术实训室 ABB，12 工位，目录占位）
 * - `CAMPUS-02` 滨江校区 → **本期无实训室接入**（如实登记为空，不编工位）
 *
 * 两室工位编码空间互不重叠（`ST-LAB01-*` vs `ST-LAB05-*`），因此归属天然可分辨。
 */
function buildSiteCatalog(): ReturnType<typeof buildCatalog> {
  return buildCatalog([
    {
      campusCode: CAMPUS_CODE,
      campusName: CAMPUS_NAME,
      labs: [
        {
          labCode: LAB_CODE,
          labName: LAB_NAME,
          stations: STATIONS.map((station) => ({ stationCode: station.stationCode, name: station.name })),
        },
        {
          labCode: ABB_LAB_CODE,
          labName: ABB_LAB_NAME,
          stations: buildAbbStationNodes(),
        },
      ],
    },
    {
      // 滨江校区：本期没有任何实训室/工位接入现场，**不是遗漏**，是如实登记
      campusCode: CAMPUS2_CODE,
      campusName: CAMPUS2_NAME,
      labs: [],
    },
  ]);
}

/* ------------------------------------------------------------------ 主装配 */

const clock = new SystemClock();
const audit = createJsonlAuditSink(CONFIG.auditPath);
const alarm = createHttpAlarmSink({
  baseUrl: CONFIG.alarmBaseUrl,
  sourceId: SOURCE_ID,
  timeoutMs: DEFAULT_ALARM_FORWARD_TIMEOUT_MS,
});

// ① 状态链路（**无执行端**）：控制链路声明 unavailable，LAB-01 四个工位与 LAB-05 十二个工位都没有真机执行端
const adapter = createProductionAdapterStateOnly({
  sources: [
    {
      sourceId: SOURCE_ID,
      kind: 'real',
      labCodes: [LAB_CODE],
      description:
        '智能制造系统集成实训室 二层观测采集器（工位1/3/4 192.168.0/24 + 工位2 192.168.1/24，只读探测）',
    },
    {
      // 授权前缀 `ST-LAB05-`：与 LAB-01 完全隔离，本室工位不会被 LAB-01 采集器写脏，反之亦然
      sourceId: ABB_SOURCE_ID,
      kind: 'real',
      labCodes: [ABB_LAB_CODE],
      description:
        '工业机器人应用技术实训室（ABB）二层观测采集器（192.168.101/24，只读探测）——' +
        `已接入 ${ABB_STATIONS.length} 个工位（${ABB_STATIONS.map((station) => station.stationCode).join(', ')}），` +
        `其余 ${ABB_STATION_COUNT - ABB_STATIONS.length} 个工位待现场逐位接线后按同样方式补台账`,
    },
  ],
  audit,
  alarm,
  clock,
});

interface StationRuntime {
  readonly spec: StationSpec;
  readonly collector: ProductionCollector;
  /** 最近一轮**已观测设备**（mac → 观测）；"无变化"不等于"没看到"，故每轮整体替换 */
  devices: Map<string, DeviceObservation>;
  /** 最近一轮的采集结果（诊断用，供 `/site/data.json` 如实回传） */
  lastCycle: CollectorCycleResult | undefined;
  /** 已完成的采集轮数 */
  passes: number;
  /**
   * 台账里**登记**的设备（mac → 标签），启动时从 `identityPath` 读出。
   *
   * ★ 为什么必须留一份（2026-09-23 现场要求）：
   * 本室的 ABB 机器人 / 研华工控机 / 树莓派等**没有 IP、不对 DCP 应答**，
   * 二层 `scan`（ARP+DCP+LLDP+端口）**采不到它们**。若只看 `devices`，
   * 这些台账里明明登记过的设备会**从页面上凭空消失**，
   * 让人误以为"这个工位只有 PLC"。
   * 因此保留台账条目，用于把「**登记了但本轮采不到**」如实标成"无法采集"
   * ——区别于「从未登记」（那压根不该出现在页面）。
   */
  ledger: Map<string, { label: string }>;
}

/**
 * 上行目标：**同一份报文同时投两处**。
 *
 * | 去向 | 用途 | 形态 |
 * |---|---|---|
 * | 本进程内 adapter | 供看板 S01 页签（`/board/v1/stations`）即时可用 | 进程内调用 |
 * | device-adapter HTTP（8734） | 供四节看板的 **S05 页签**（`/device/v1/stations`） | `POST /device/v1/reports` |
 *
 * **为什么必须两个都投**：
 * S05 是**独立进程**（`serve-upstreams.ts`）。看板进程内的采集结果**到不了它** ——
 * 表现就是 S05 页签永远显示"当前没有已登记工位设备"（`stations: []`），
 * 而 `data/upstreams/device-adapter-audit.jsonl` 根本不会生成（从未收到任何 ingest）。
 * 这两件事**不是故障**，是两个进程之间缺一条上行链路。
 *
 * 投递纪律：
 * 1. **两路都投、互不阻塞失败**：S05 不可达时只看它那一路 `ok:false`，
 *    绝不影响本进程内的 S01 链路（反之亦然）。
 * 2. 只有当 `--device-base=` 显式给出时才启用 HTTP 一路（缺省不启用，
 *    避免单进程模式下把不存在的 8734 当成必投目标而刷满失败日志）。
 */
function createFanoutUplinkTarget(deviceBaseUrl: string | undefined): UplinkTarget {
  const inProcess = createUplinkTargetFromIngest((report: DeviceReport) => adapter.ingestReport(report));
  if (deviceBaseUrl === undefined || deviceBaseUrl.trim() === '') return inProcess;

  const http = createHttpUplinkTarget({
    baseUrl: deviceBaseUrl.trim(),
    timeoutMs: DEFAULT_UPLINK_TIMEOUT_MS,
  });

  return {
    async send(report: DeviceReport): Promise<UplinkResult> {
      // 本进程内那一路是先决条件：它失败说明报文本身有问题，直接如实回传
      const local = await inProcess.send(report);
      if (!local.ok) return local;

      // S05 那一路：失败**只如实上报**，不掩盖本路的成功
      const remote = await http.send(report);
      if (!remote.ok) {
        log(
          `[uplink] S05（${deviceBaseUrl}）投递失败：${remote.reason ?? 'unknown'}` +
            `${remote.errorClass !== undefined ? `（${remote.errorClass}）` : ''} —— ` +
            'S01 不受影响；S05 页签将缺本条报文',
        );
      }
      return remote;
    },
  };
}

/**
 * 读台账里的**登记设备清单**（mac → 标签），供"无法采集"标记使用。
 *
 * 读失败时**返回空表而不是抛错**：台账问题应由采集器的身份映射给出明确报错，
 * 这里只是页面展示用的辅助信息，**不能因为读不到标签就让整个看板起不来**。
 */
function readLedger(path: string): Map<string, { label: string }> {
  const ledger = new Map<string, { label: string }>();
  try {
    const raw = readFileSync(path, 'utf8');
    const root = JSON.parse(raw) as { entries?: Array<{ mac?: unknown; label?: unknown }> };
    for (const item of root.entries ?? []) {
      if (typeof item.mac !== 'string' || item.mac.trim() === '') continue;
      ledger.set(item.mac.toUpperCase(), {
        label: typeof item.label === 'string' ? item.label : '',
      });
    }
  } catch (error: unknown) {
    log(`[ledger] 读台账失败（不影响采集，仅影响"无法采集"标记）：${path} → ${describe(error)}`);
  }
  return ledger;
}

function createStationRuntime(spec: StationSpec): StationRuntime {
  const collector = createProductionCollector({
    // ★ 来源**按工位归属的实训室取**，不再是全局常量：LAB-05 的工位用 `SRC-NETDEV-LAB05`，
    // 于是它往上送的报警自动带 `ST-LAB05-` 授权前缀（S07 侧的越权校验因此天然通过）。
    sourceId: labOfStation(spec.stationCode).sourceId,
    subnet: spec.subnet,
    scriptDir: CONFIG.scriptDir,
    interfaceKeyword: CONFIG.interfaceKeyword,
    captureSeconds: DEFAULT_SCAN_CAPTURE_SECONDS,
    scriptTimeoutMs: DEFAULT_SCRIPT_TIMEOUT_MS,
    identityMapPath: spec.identityPath,
    alarmBaseUrl: CONFIG.alarmBaseUrl,
    clock,
    uplinkTarget: createFanoutUplinkTarget(CONFIG.deviceBaseUrl),
    logSink: (line) => log(`[${spec.stationCode}] ${line}`),
    collector: {
      // 采集参数一律按 PARAM-* 注入；缺省值取自 device-collector 与 device-adapter 的 params 声明处
      pollIntervalMs: CONFIG.pollIntervalMs,
      uplinkIntervalMs: DEFAULT_UPLINK_INTERVAL_MS,
      listenIntervalMs: CONFIG.listenIntervalMs,
      listenSeconds: CONFIG.listenSeconds,
      heartbeatFallbackMs: DEV_DEFAULTS[DEV_PARAM.HEARTBEAT_FALLBACK],
      paramChangeThreshold: DEV_DEFAULTS[DEV_PARAM.PARAM_CHANGE_THRESHOLD],
      dcpHelloStormRatePerSecond: DEFAULT_HELLO_STORM_RATE_PER_SECOND,
      dcpHelloStormMinFrames: DEFAULT_HELLO_STORM_MIN_FRAMES,
    },
  });
  return {
    spec,
    collector,
    devices: new Map(),
    lastCycle: undefined,
    passes: 0,
    ledger: readLedger(spec.identityPath),
  };
}

const runtimes: StationRuntime[] = ALL_STATIONS.map(createStationRuntime);

// ② 看板：真目录 + 真投影 + 真事件流（不自己 listen，端口由外层 pageServer 持有）
//
// ⚠️ 判离线窗口按**现场采集节奏**放宽（部署侧覆盖，不是把常量塞进业务逻辑）：
// 二层单轮 scan 实测 55~65s，且四个工位**串行**跑完一轮更久；而契约默认
// `PARAM-OFFLINE-JUDGE` 只有 2 分钟 —— 余量太小，采集偶慢就出现"真机在线却被判离线"。
// 表达方式是"契约默认值 × 现场节奏倍数"，不用绝对时长字面量（仓库不变量 4 禁止）；
// 需要精确值时用 CLI `--offline-judge-ms=` 覆盖。契约默认值本身不改。
const SITE_OFFLINE_JUDGE_FACTOR = 2.5;
const contractOfflineJudgeMs = createBoardParams().base(PARAM.OFFLINE_JUDGE);
const offlineJudgeMs = CONFIG.offlineJudgeMs ?? Math.round(contractOfflineJudgeMs * SITE_OFFLINE_JUDGE_FACTOR);

const board = createProductionBoard({
  catalog: buildSiteCatalog(),
  params: createBoardParams({ core: { [PARAM.OFFLINE_JUDGE]: offlineJudgeMs } }),
  logger: (record) => log(`[board] ${JSON.stringify(record)}`),
});
log(`判离线窗口 ${offlineJudgeMs}ms（契约默认 ${contractOfflineJudgeMs}ms × ${SITE_OFFLINE_JUDGE_FACTOR}：L2 单轮 55~65s + 工位独立轮转）`);

// ★ 启动即把"每个实训室接入了几个工位"打出来（而不是只打一句全局来源）：
// 两室接入进度不同，"已接入 N/12"是最容易被误读成"12 个都在采"的地方，必须每次启动都写清。
for (const lab of Object.values(LAB_REGISTRY)) {
  const codes = runtimes
    .filter((runtime) => runtime.spec.labCode === lab.labCode)
    .map((runtime) => runtime.spec.stationCode);
  log(
    `实训室 ${lab.labCode}（${lab.labName}）· 来源 ${lab.sourceId} · 授权前缀 ${lab.labWideStationCode.replace(/00$/, '')} · ` +
      `已接入 ${codes.length}/${lab.stationCount} 个工位${codes.length > 0 ? `（${codes.join(', ')}）` : '（尚无采集器）'}`,
  );
}
log(`网卡关键字 "${CONFIG.interfaceKeyword}" · 插件脚本目录 ${CONFIG.scriptDir}`);
for (const runtime of runtimes) {
  const stats = runtime.collector.identityMap.stats();
  const excluded = runtime.collector.identityMap.map.excludedMacs;
  log(
    `工位 ${runtime.spec.stationCode}（${runtime.spec.name}）· ${runtime.spec.labCode} · 网段 ${runtime.spec.subnet} · ` +
      `台账 ${stats.path} → ${stats.entries} 条设备条目` +
      `${excluded.length > 0 ? `，排除 ${excluded.join(',')}` : ''}`,
  );
}
log(`控制链路 control=${adapter.control}（两室的工位都没有真机执行端；本启动器不下发任何控制）`);

/* --------------------------------------------------------------- 循环与桥接 */

let stopping = false;
let roundTimer: ReturnType<typeof setTimeout> | undefined;
let listenTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 单元的 `params`：`unitN.name/code/component/powerPlc/state/device/observedAt/evidence`。
 *
 * **只有归属有证据的单元才套设备状态**（`observedMac` 命中本工位已观测设备时）；
 * 其余如实写「归属未确认」/「未上报」——**绝不**把"没观测到"写成"空闲"。
 */
function unitParamsOf(
  spec: StationSpec,
  byMac: Map<string, DeviceObservation>,
): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};
  for (const unit of spec.units) {
    const key = `unit${unit.index}`;
    params[`${key}.name`] = unit.name;
    params[`${key}.code`] = unit.code;
    params[`${key}.component`] = unit.component;
    params[`${key}.powerPlc`] = unit.powerPlc;
    params[`${key}.evidence`] = unit.evidence;

    const observation = unit.observedMac === undefined ? undefined : byMac.get(unit.observedMac);
    if (observation === undefined) {
      params[`${key}.state`] = unit.observedMac === undefined ? UNIT_STATE_UNATTRIBUTED : UNIT_STATE_UNREPORTED;
      continue;
    }
    params[`${key}.state`] = STATE_S05_TO_S01[observation.status];
    params[`${key}.device`] = `${observation.mac} ${observation.ip}`.trim();
    params[`${key}.observedAt`] = observation.observedAt;
  }
  return params;
}

/**
 * 把**某工位**的「已观测设备」聚合成**一条工位级状态**，喂给看板。
 *
 * 为什么聚合在这里（状态源侧）而不是看板里：看板的状态唯一入口是状态源上报的 `state`，
 * 在 board-web 里做聚合会违反 A-02（状态不得由看板推导）。本文件就是各工位的状态源适配器，
 * 所以聚合规则写在这里、并随 `params.aggregation` 一起透出，可核对。
 *
 * 聚合规则（显式、可复核，逐字对应 `aggregation` 参数）：
 * - 本轮**无任何设备上报** → 工位 `offline`（数据缺席即不可用，**不猜成空闲**）；
 *   但仅当本轮采集有效且**未**被判"网段未覆盖"时才推——
 *   采集失败 / 网段未覆盖时"没观测到"只能说明探测不到，推 offline 就是假离线（纪律 7）。
 * - 任一设备 `occupied` → 工位 `occupied`；
 * - 否则任一设备 `maintenance` → 工位 `maintenance`；
 * - 否则 → 工位 `available`。
 */
const AGGREGATION_RULE =
  '任一设备占用→工位占用；否则有维护→工位维护；否则工位空闲；本轮无设备上报（且采集有效、网段已覆盖）→工位离线';

function bridgeStation(runtime: StationRuntime, cycle: CollectorCycleResult): boolean {
  // 每轮整体替换："无变化"≠"没看到"，未观测到的设备一律不进本轮聚合
  runtime.devices = new Map(cycle.observations.map((observation) => [observation.mac, observation]));
  runtime.lastCycle = cycle;
  runtime.passes += 1;

  const devices = [...runtime.devices.values()];
  const params = unitParamsOf(runtime.spec, runtime.devices);
  params['aggregation'] = AGGREGATION_RULE;
  params['stationName'] = runtime.spec.name;
  params['labName'] = LAB_NAME;
  params['subnet'] = runtime.spec.subnet;
  params['deviceSummary'] = `已观测 ${devices.length} 台设备`;
  params['observedDevices'] =
    devices.length === 0
      ? '（无）'
      : devices.map((device) => `${device.mac} ${device.ip || '-'}${device.stationName === '' ? '' : ` (${device.stationName})`}`).join('；');

  /**
   * ★★ 「登记了但本轮采不到」如实列出（2026-09-23 现场要求）。
   *
   * 本室的 ABB 机器人 / 研华工控机 / 树莓派等**没有 IP、不对 DCP 应答**，
   * 二层 `scan` **采不到它们**。若不显式列出，这些台账里登记过的设备会
   * **从页面凭空消失**，让人误判"这个工位只有 PLC"。
   *
   * ⚠️ **口径（与"未上报 ≠ 离线"同源）**：
   * 这里写的是「**本轮采集不到**」，**不是**「设备不存在」，也**不是**「设备离线」——
   * 它可能只是①无 IP/不应答 DCP（本室常态）②未上电 ③未接网。
   * 判定它到底属于哪种，需要现场核对，**页面不下结论**。
   */
  const unobserved = [...runtime.ledger.entries()]
    .filter(([mac]) => !runtime.devices.has(mac))
    .map(([mac, item]) => `${mac}${item.label === '' ? '' : `（${item.label}）`}`);
  params['unobservedDevices'] = unobserved.length === 0 ? '（无）' : unobserved.join('；');
  params['deviceSummary'] =
    unobserved.length === 0
      ? `已观测 ${devices.length} 台设备`
      : `已观测 ${devices.length} 台设备 · 另有 ${unobserved.length} 台已登记但本轮采集不到`;

  const attributed = runtime.spec.units.filter((unit) => unit.observedMac !== undefined);
  params['unitAttribution'] =
    `单元归属已确认 ${attributed.length}/${runtime.spec.units.length}` +
    (attributed.length === runtime.spec.units.length
      ? ''
      : `；归属未确认：${runtime.spec.units.filter((unit) => unit.observedMac === undefined).map((unit) => unit.name).join('、')}`);

  let occupied = false;
  let maintenance = false;
  let atMs = Number.NaN;
  let alarmCode: string | undefined;
  let alarmLevel: AlarmLevel | undefined;
  for (const device of devices) {
    try {
      const deviceAtMs = parseIso(device.observedAt);
      atMs = Number.isNaN(atMs) ? deviceAtMs : Math.max(atMs, deviceAtMs);
    } catch {
      /* observedAt 不可解析时该设备时间不计入工位时间（下面按无时间兜底） */
    }
    const deviceState = STATE_S05_TO_S01[device.status];
    if (deviceState === 'occupied') occupied = true;
    if (deviceState === 'maintenance') maintenance = true;
    if (alarmCode === undefined && device.alarmCode !== null && device.alarmCode !== '') {
      alarmCode = device.alarmCode;
      alarmLevel = device.alarmLevel;
    }
  }

  /**
   * 「本轮没有数据」= **不推任何状态**（既不是 offline，也不是 available）。
   *
   * 为什么 `devices.length === 0` **也必须**走这一支（2026-09-22 23:xx 现场修）：
   * 采集器在"本轮一个设备都没匹配上台账"时，会**自己**下发一条 `status=offline`
   * 的**空 mac 上报**（`CollectorCycleResult.reports` 里 `params.mac` 为空）——
   * 那是**数据缺席推断**（"本轮什么都没看到"），它把**设备**判成离线，语义上
   * 属于设备侧判离线，不是工位在线状态。早先版本把它照单全收地聚合成工位状态，
   * 于是出现两个错误：
   *   ① 网线拔掉/未接线时，工位被推到 `activeAtMs=now` 的 `offline`，**抢在
   *      `PARAM-OFFLINE-JUDGE` 判离线窗口之前**给出结论；
   *   ② 「**未上报**（从没有过状态源数据）」与「**离线**（曾有数据、现在不可用）」
   *      在页面与接口上分不开 —— 前者必须 `updatedAt=null`。
   * 因此**只有"本轮确实匹配到了设备"的轮次才推工位状态**：有数据才聚合、才推。
   *
   * ⚠️ 这不等于"工位永远不显示不可用"：工位一旦有过上报，之后停更就由看板的
   * 判离线窗口（`PARAM-OFFLINE-JUDGE`）负责判离线；**从未上报**的工位则由看板
   * 的 `recordOf` 缺省给出 `offline + updatedAt=null`（数据缺席即不可用），
   * 二者都不显示成"空闲"（available）。**恰好是本函数"不推"才让这两者可分。**
   *
   * ⚠️ 关于 `cycle.valid` / `cycle.offlineSuppressed`（保持原纪律 7 的判定顺序）：
   * 采集无效或**网段未覆盖**时，"没观测到"只能说明探测不到，同样不推。
   * 现场还会遇到第三种情况：**采集成功（`valid=true`）但确实什么都没看到**
   * （网线没插在任何一个工位上）——这同样只是"没有数据"，
   * 得不出"工位离线"，更得不出"工位空闲"。
   * **已知缺口（如实登记，不绕过）**：
   * `plugins/netdev-discovery/scripts/scan.ps1` 当前**不产出 `coverage` 字段**，
   * 所以 `offlineSuppressed` 在真实路径上恒为 false、"网段未覆盖 → 抑制 offline
   * 推断"这条红线**在这条数据路径上不触发**（`coverage` 判定在 DSH 插件 Host 层）。
   * 本文件不掩饰这一点，而是在 `/site/data.json` 里如实回传每轮的 `coverage`。
   */
  if (devices.length === 0) {
    // 说明为什么"没数据"：`valid=false` 可能是采集失败（例如网卡未连接、脚本超时），
    // 也可能是**采集成功但本来就什么都没看到**（另一块网段什么都没接）。
    // 二者都只能得出"没有数据"，**都得不出"工位离线/空闲"**——所以这里不分叉，都不推。
    const why = cycle.valid
      ? '本轮未匹配到任何本工位台账设备'
      : `本轮采集无效（${cycle.errors.join(' / ') || '未提供原因'}）`;
    log(
      `工位 ${runtime.spec.stationCode} ${why}，按纪律**不推**工位状态（"扫不到"≠"不存在"；` +
        '数据缺席由看板"未上报/判离线窗口"兜底，绝不写成"空闲"）',
    );
    return false;
  }

  const state: StationState = occupied
    ? 'occupied'
    : maintenance
      ? 'maintenance'
      : 'available';

  const effectiveAtMs = Number.isNaN(atMs) ? clock.now() : atMs;
  try {
    board.projection.applyState({
      stationCode: runtime.spec.stationCode,
      state,
      atMs: effectiveAtMs,
      sourceKind: 'real',
      sourceId: labOfStation(runtime.spec.stationCode).sourceId,
      params,
      ...(alarmCode !== undefined ? { alarmCode } : {}),
      ...(alarmLevel !== undefined ? { alarmLevel } : {}),
    });
  } catch (error) {
    // 脏数据不该让整个看板停摆
    log(`看板投影拒绝 ${runtime.spec.stationCode}：${describe(error)}`);
    return false;
  }
  board.realtime.tick();
  return true;
}

/** 轮某一工位的二层采集 + 单进程上行 + 桥接。 */
async function scanPass(runtime: StationRuntime): Promise<void> {
  if (stopping) return;
  try {
    const { cycle, drain } = await runtime.collector.collector.runCycle();
    reportScan(runtime, cycle, drain);
    bridgeStation(runtime, cycle);
  } catch (error) {
    // 循环内异常必须隔离：一次偶发错误不能让采集永久停止。
    // 现场排障需要栈：只有 message 时"哪个字段 undefined"要重跑一遍才能定位。
    log(`工位 ${runtime.spec.stationCode} 采集轮异常（已隔离，下一轮继续）：${describeWithStack(error)}`);
  }
}

/**
 * 一轮采集：四个工位**各自一轮**。
 *
 * 并发而不是串行，理由是可核对的：工位2 在 `192.168.1.0/24`（与其余三个不同网段），
 * 两轮扫描的目标地址空间不相交；工位1/3/4 虽同在 `192.168.0.0/24`，但各自只按自己的
 * **MAC 台账**归位（同一网段的设备对三个工位都是可见的，`pending` 里会如实列出）。
 * 共用同一块网卡只是发送/抓包通道；串行会让"后一个工位"每轮多等一个完整扫描周期
 * （实测单轮 55~65s），现场表现是"另一个工位永远慢一拍"。
 * 被动监听（`listenPass`）仍然**串行**：它是整块网卡的被动窗口，同时开多个没有意义。
 */
async function scanRound(): Promise<void> {
  if (stopping) return;
  try {
    await Promise.all(runtimes.map((runtime) => scanPass(runtime)));
  } finally {
    if (!stopping) roundTimer = setTimeout(() => void scanRound(), CONFIG.pollIntervalMs);
  }
}

/** 一轮被动监听（不发帧，逐工位串行）+ Hello 风暴判定（报警经 AlarmSink 外发）。 */
async function listenPass(runtime: StationRuntime): Promise<void> {
  if (stopping) return;
  try {
    const result = await runtime.collector.collector.collectListenOnce();
    reportListen(runtime, result);
  } catch (error) {
    log(`工位 ${runtime.spec.stationCode} 监听轮异常（已隔离，下一轮继续）：${describeWithStack(error)}`);
  }
}

async function listenRound(): Promise<void> {
  if (stopping) return;
  try {
    for (const runtime of runtimes) {
      if (stopping) return;
      await listenPass(runtime);
    }
  } finally {
    if (!stopping) listenTimer = setTimeout(() => void listenRound(), CONFIG.listenIntervalMs);
  }
}

function reportScan(runtime: StationRuntime, cycle: CollectorCycleResult, drain: DrainResult): void {
  log(
    `[${runtime.spec.stationCode}] 采集 ${cycle.observedAt} valid=${cycle.valid} 已观测设备 ${cycle.observations.length} 台 · ` +
      `上报 ${cycle.reports.length} 条 · 无变化 ${cycle.unchanged.length} · 投递 attempted=${drain.attempted}/delivered=${drain.delivered}` +
      `${drain.blocked ? '（退避中）' : ''}`,
  );
  for (const observation of cycle.observations) {
    log(
      `  [${runtime.spec.stationCode}] 设备 ${observation.mac} ip=${observation.ip || '-'} ` +
        `status=${observation.status} stationName=${observation.stationName || '-'} ` +
        `openPorts=${String(observation.params['openPorts'] ?? '')} alarm=${observation.alarmCode ?? '-'}`,
    );
  }
  for (const report of cycle.reports) {
    log(
      `  [${runtime.spec.stationCode}] 上报 ${report.stationCode} status=${report.status} ` +
        `alarm=${report.alarmCode ?? '-'} mac=${String(report.params['mac'] ?? '')} eventId=${report.eventId}`,
    );
  }
  if (!cycle.valid) log(`  [${runtime.spec.stationCode}] 采集无效：${cycle.errors.join(' / ') || '未提供原因'}`);
  // coverage.mandatory=true 时"未观测到"不足以支撑"离线"，采集器已抑制 offline 推断
  log(`  [${runtime.spec.stationCode}] 网段覆盖 coverage=${JSON.stringify(cycle.coverage)} offlineSuppressed=${cycle.offlineSuppressed}`);
  const pending = cycle.pending.filter((item) => item.reason !== 'excluded-mac');
  for (const item of pending.slice(0, runtime.spec.units.length)) {
    log(`  [${runtime.spec.stationCode}] 待处理 ${item.device.mac} ip=${item.device.ip || '-'} reason=${item.reason} ${item.detail ?? ''}`);
  }
  const excluded = cycle.pending.filter((item) => item.reason === 'excluded-mac');
  if (excluded.length > 0) {
    log(`  [${runtime.spec.stationCode}] 已排除（非身份 MAC，设计内）：${excluded.map((i) => i.device.mac).join(',')}`);
  }
  for (const finding of cycle.alarms) {
    log(`  [${runtime.spec.stationCode}] 报警 ${formatFinding(finding)}`);
    recordAlarm(finding, runtime.spec.stationCode);
  }
  for (const record of cycle.inhibited) {
    log(`  [${runtime.spec.stationCode}] 报警被抑制（${record.inhibitedBy} / 规则 ${record.rule}）：${formatFinding(record.finding)}`);
    recordAlarm(record.finding, runtime.spec.stationCode, record.inhibitedBy);
  }
}

function reportListen(runtime: StationRuntime, result: ListenCycleResult): void {
  log(
    `[${runtime.spec.stationCode}] 被动监听 ${result.observedAt} valid=${result.valid} 窗口 ${result.listenSeconds}s ` +
      `总帧 ${result.totalFrames} · RT 周期帧 ${result.rtCyclicFrames} · ` +
      `判定 ${result.findings.length} 条 / 外发 ${result.emitted.length} 条 / 抑制 ${result.inhibited.length} 条`,
  );
  // 注意：`ListenCycleResult`（device-collector/src/index.ts）**不暴露** `sourceMacs`
  // （逐 MAC 帧计数），它只给 totalFrames / rtCyclicFrames / findings / emitted / inhibited。
  // 逐设备的原始计数在 `finding.evidence` 里 —— 那正是判定 DCP Hello 风暴用的分子与分母，
  // 所以这里从证据里如实打印，不另造数据。
  for (const finding of result.findings) {
    log(`  [${runtime.spec.stationCode}] 报警（判定）${formatFinding(finding)}`);
    recordAlarm(finding, runtime.spec.stationCode);
  }
  for (const record of result.inhibited) {
    log(`  [${runtime.spec.stationCode}] 报警被抑制（${record.inhibitedBy} / 规则 ${record.rule}）：${formatFinding(record.finding)}`);
    recordAlarm(record.finding, runtime.spec.stationCode, record.inhibitedBy);
  }
  if (!result.valid) log(`  [${runtime.spec.stationCode}] 监听无效：${result.errors.join(' / ') || '未提供原因'}`);
}

/* -------------------------------------------------- 最近报警台账（供页面展示） */

/**
 * 最近报警（含被抑制的），只驻内存、供 `/station1` = `/site` 页面好看地展示。
 *
 * 这里**不做任何判定**：`level`/`detail`/`evidence` 全部原样来自采集器的 finding；
 * `inhibitedBy` 来自抑制记录（"被谁抑制"要留痕），`forwarded` 只表示本进程是否投递过。
 * **去重按 `码位 + 工位 + 文案`**（`code|stationCode|detail`）：同一个 DCP Hello 风暴
 * 每轮都会重新判出，不去重会把页面刷成同一条重复几十行；命中时 `seenTimes` 计次。
 */
interface LiveAlarm {
  firstSeenAt: string;
  lastSeenAt: string;
  seenTimes: number;
  code: string;
  level: string;
  /** 报警归属工位编码（跨工位异常为 `ST-LAB01-00`） */
  stationCode: string;
  /** 判出该报警的**采集器所在工位**（跨工位异常时用于回溯是谁看到的） */
  originStationCode: string;
  detail: string;
  evidence: Record<string, unknown>;
  inhibitedBy?: string;
}

const liveAlarms: LiveAlarm[] = [];

function recordAlarm(finding: AlarmFinding, originStationCode: string, inhibitedBy?: string): void {
  const at = toIso(clock.now());
  const raw = finding.stationCode ?? '';
  // ★ 兜底用**采集该异常的那个工位**所属实训室的跨工位码：
  // finding 是哪个工位的采集器看到的，就归到哪个实训室。这样 LAB-05 工位报出的、
  // 本身没有工位归属的结构异常（如网段未覆盖）落 `ST-LAB05-00`，不会被盖成 `ST-LAB01-00`。
  const stationCode = isValidStationCode(raw) ? raw : labOfStation(originStationCode).labWideStationCode;
  const key = `${finding.code}|${stationCode}|${finding.detail}`;
  const existing = liveAlarms.find((item) => `${item.code}|${item.stationCode}|${item.detail}` === key);
  if (existing !== undefined) {
    existing.lastSeenAt = at;
    existing.seenTimes += 1;
    if (inhibitedBy !== undefined) existing.inhibitedBy = inhibitedBy;
    return;
  }
  liveAlarms.unshift({
    firstSeenAt: at,
    lastSeenAt: at,
    seenTimes: 1,
    code: String(finding.code),
    level: String(finding.level),
    stationCode,
    originStationCode,
    detail: String(finding.detail),
    evidence: finding.evidence,
    ...(inhibitedBy !== undefined ? { inhibitedBy } : {}),
  });
  if (liveAlarms.length > LIVE_ALARM_KEEP) liveAlarms.length = LIVE_ALARM_KEEP;
}

function formatFinding(finding: AlarmFinding): string {
  return `${finding.code}[${finding.level}] station=${finding.stationCode ?? '(跨工位)'} ${finding.detail} evidence=${JSON.stringify(finding.evidence)}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 循环级异常用（带栈）：现场排障要能一眼看出是哪个字段 undefined。 */
function describeWithStack(error: unknown): string {
  if (error instanceof Error) return `${error.message}\n${error.stack ?? '<无栈>'}`;
  return String(error);
}

/* ---------------------------------------------------------------- 页面数据 */

const PAGE_ROUTES = new Set(['/', '/index.html']);
const SITE_ROUTES = new Set(['/site', '/site.html', '/station1', '/station1.html']);
const SITE_DATA_PATH = '/site/data.json';
/** 兼容旧调用方（单工位版页面/脚本用过的路径）：返回**工位1** 的旧扁平形状。 */
const LEGACY_STATION1_DATA_PATH = '/station1/data.json';

interface StationView {
  stationCode: string;
  name: string;
  subnet: string;
  state: StationState;
  updatedAt: string | null;
  params: Record<string, unknown>;
  units: Array<Record<string, unknown>>;
  devices: Array<Record<string, unknown>>;
  /**
   * ★ 台账**登记了但本轮采集不到**的设备（页面标「无法采集」）。
   *
   * 与 `devices` 分开成两个字段，是为了**不让调用方误以为它们被观测到了**。
   * 典型：本室 ABB 机器人 / 研华工控机 / 树莓派**没有 IP、不对 DCP 应答**，
   * 二层 `scan` 采不到 ⇒ 必须显式列出，否则会从页面"凭空消失"。
   */
  unobservedDevices: Array<Record<string, unknown>>;
  alarms: LiveAlarm[];
  coverage: CollectorCycleResult['coverage'] | null;
  offlineSuppressed: boolean | null;
  lastObservedAt: string | null;
  passes: number;
}

/**
 * 页面上的「未上报」与「离线」**必须能分开**（现场口径，2026-09-22）：
 *
 * | 看板状态 | 页面上说什么 | 判据 |
 * |---|---|---|
 * | `offline` + `updatedAt === null` | **未上报**（数据缺席） | 状态源从未上报过；`recordOf` 缺省给 `offline` |
 * | `offline` + `updatedAt !== null` | **离线**（不可用） | 曾有数据，之后判离线窗口判出 |
 * | `available` / `occupied` / `maintenance` | 空闲 / 占用 / 维护 | 状态源按已观测设备聚合 |
 *
 * 页面**不做判定**，只按"有没有 `updatedAt`"二选一换词（判定仍在状态源侧与看板侧）。
 */
const STATE_CN_WITH_DATA: Readonly<Record<StationState, string>> = {
  available: '空闲',
  occupied: '占用',
  maintenance: '维护',
  offline: '离线',
};
const STATE_CN_NO_DATA: Readonly<Record<StationState, string>> = {
  ...STATE_CN_WITH_DATA,
  offline: '未上报',
};

/** 由「工位 spec + 看板投影 + 最近一轮观测」拼出页面数据（**只做搬运与分组，不新增判定**）。 */
function stationView(runtime: StationRuntime): StationView {
  const record = board.projection.recordOf(runtime.spec.stationCode);
  const params: Record<string, unknown> = { ...(record?.params ?? {}) };
  const devices = [...runtime.devices.values()].map((device) => ({
    stationCode: runtime.spec.stationCode,
    mac: device.mac,
    ip: device.ip,
    stationName: device.stationName,
    status: device.status,
    observedAt: device.observedAt,
    params: device.params,
    alarmCode: device.alarmCode,
    /** 本设备**本轮采集到了**（该数组里恒为 true；"采集不到"的条目在 `unobservedDevices`） */
    observed: true,
  }));
  /**
   * 台账登记但**本轮采集不到**的设备（页面必须显示并标「无法采集」）。
   * 与 `devices` 分开成两个数组，是为了**不让调用方误以为这些设备被观测到了**。
   */
  const unobservedDevices = [...runtime.ledger.entries()]
    .filter(([mac]) => !runtime.devices.has(mac))
    .map(([mac, item]) => ({
      stationCode: runtime.spec.stationCode,
      mac,
      label: item.label,
      observed: false,
    }));
  const units = runtime.spec.units.map((unit) => {
    const key = `unit${unit.index}`;
    return {
      index: unit.index,
      name: unit.name,
      code: unit.code,
      component: unit.component,
      powerPlc: unit.powerPlc,
      evidence: unit.evidence,
      // 归属未确认 / 未上报的占位词由**状态源侧**给出（与推给看板的 params 同口径）
      state: String(params[`${key}.state`] ?? (unit.observedMac === undefined ? UNIT_STATE_UNATTRIBUTED : UNIT_STATE_UNREPORTED)),
      attributed: unit.observedMac !== undefined,
      device: params[`${key}.device`] ?? null,
      observedAt: params[`${key}.observedAt`] ?? null,
    };
  });
  return {
    stationCode: runtime.spec.stationCode,
    name: runtime.spec.name,
    subnet: runtime.spec.subnet,
    state: record?.state ?? 'offline',
    updatedAt: record === undefined ? null : toIso(record.atMs),
    params,
    units,
    devices,
    alarms: liveAlarms.filter((item) => item.stationCode === runtime.spec.stationCode),
    coverage: runtime.lastCycle === undefined ? null : runtime.lastCycle.coverage,
    offlineSuppressed: runtime.lastCycle === undefined ? null : runtime.lastCycle.offlineSuppressed,
    lastObservedAt: runtime.lastCycle?.observedAt ?? null,
    passes: runtime.passes,
    /** ★ 台账登记但本轮采集不到的设备（页面标「无法采集」） */
    unobservedDevices,
  };
}

function siteData(): Record<string, unknown> {
  return {
    ok: true,
    serverTime: toIso(clock.now()),
    /** 本页数据所属校区（两个实训室都在海宁校区） */
    campus: { campusCode: CAMPUS_CODE, campusName: CAMPUS_NAME },
    /** 全部校区（含本期无接入的滨江校区），供三级浏览核对 */
    campuses: [
      {
        campusCode: CAMPUS_CODE,
        campusName: CAMPUS_NAME,
        labs: [
          {
            labCode: LAB_CODE,
            labName: LAB_NAME,
            stationCount: STATIONS.length,
            /** 已建采集器的工位数（= 已建台账的工位数）；LAB-01 四位齐全 */
            collectorStations: STATIONS.length,
            collector: true,
          },
          {
            labCode: ABB_LAB_CODE,
            labName: ABB_LAB_NAME,
            stationCount: ABB_STATION_COUNT,
            /**
             * ★ 与 `stationCount` **分开**报：本室 12 个工位，当前只有工位2 接入采集。
             * 只报 `stationCount` 会让人读成"12 个工位都在采但没采到设备"，那是两码事。
             */
            collectorStations: ABB_STATIONS.length,
            collector: ABB_STATIONS.length > 0,
          },
        ],
      },
      { campusCode: CAMPUS2_CODE, campusName: CAMPUS2_NAME, labs: [] },
    ],
    lab: { labCode: LAB_CODE, labName: LAB_NAME },
    sourceId: SOURCE_ID,
    stations: runtimes.map(stationView),
    /**
     * 第二个实训室（LAB-05 ABB）的**工位目录**：12 个编码/名称 + 组成引用，
     * 并逐个标明**是否已接入采集**（`stations[].collector`）。
     *
     * ★ 为什么已接入的 LAB-05 工位同时出现在 `stations[]` 里、而这里仍列全 12 个：
     * 二者分工不同——`stations[]` 是**采集运行时**（有 subnet/coverage/passes，只能包含有采集器的工位），
     * `pendingLab` 是**本室的完整目录**（12 个都在，未接入的如实标 `collector:false`）。
     * 因此**不要**把这里读成"12 个工位都没采集"；以 `stations[].stationCode` 为准。
     */
    pendingLab: {
      labCode: ABB_LAB_CODE,
      labName: ABB_LAB_NAME,
      sourceId: ABB_SOURCE_ID,
      subnet: DEFAULT_SUBNET_ABB,
      stationCount: ABB_STATION_COUNT,
      /** ★ 本室**已接入采集**的工位编码（这些同时出现在顶层 `stations[]` 里） */
      measuredStationCodes: ABB_STATIONS.map((station) => station.stationCode),
      reason:
        '① **组成已补齐**：本室 12 个工位**组成完全相同**（用户 2026-09-23 确认），单工位 BOM / 网络规划 / ' +
        '执行模块 / PLC 数据区见 `composition` —— ⚠️ **来源是教材，属设计规划，不是实测状态**。' +
        `② **已接入 ${ABB_STATIONS.length}/${ABB_STATION_COUNT} 个工位**（${ABB_STATIONS.map((station) => station.stationCode).join(', ')}）：` +
        '该工位已有 MAC 台账并跑采集器，其真实状态在顶层 `stations[]` 里（本字段的 `stations[].collector=true` 与之对应）。' +
        `③ **其余 ${ABB_STATION_COUNT - ABB_STATIONS.length} 个工位未接入**：现场尚未逐台接线实测，按纪律**不为未实测的工位编台账**，` +
        '页面按「未接入」如实呈现 —— **不是"空闲"，也不是"采了但没采到"**。' +
        '④ ⚠️ **组成相同 ≠ 地址相同**：教材只给了一套 IP，12 工位是"各自独立网络 ⇒ 可复用同号 IP"还是' +
        '"同一扁平网络 ⇒ IP 必须逐位不同"，**目前无证据裁决**（见 `composition.designNote`），' +
        '**不得**把这套 IP 当成 12 份工位地址使用。',
      /** ★ 12 个工位共用的单工位组成（含教材 BOM / 网络规划 / 执行模块 / 数据区 / 单工位抽检结果） */
      composition: ABB_STATION_COMPOSITION,
      stations: buildAbbStationNodes(),
    },
    /**
     * 口径说明随数据一起下发（前端与调用方**不必**猜"offline 到底是未上报还是真离线"）。
     * `decidedBy` 在**状态源侧**，不在前端——前端只按有无 `updatedAt` 换词。
     */
    conventions: {
      stateSource: '状态源侧聚合（本启动器 bridgeStation），看板只做投影（A-02）',
      neverReported: {
        when: 'state=offline 且 updatedAt=null',
        means: '未上报：状态源从未上报（数据缺席）。本启动器在"本轮未匹配到任何本工位设备"时**不推**状态。',
        notMeans: '不是 available（空闲），也不是设备自报的 offline',
      },
      offline: {
        when: 'state=offline 且 updatedAt!=null',
        means: '离线：曾有过上报，之后由看板判离线窗口（PARAM-OFFLINE-JUDGE）判出',
      },
      aggregation: AGGREGATION_RULE,
      twoLabs:
        'LAB-01（智能制造系统集成，192.168.0/192.168.1）与 LAB-05（工业机器人应用技术实训室 ABB，192.168.101）' +
        '是**两套独立载体**：工位编码前缀不同（ST-LAB01- vs ST-LAB05-）、来源不同、网段不通用。' +
        '同号 IP 在两室之间不具备任何可继承含义，归属一律按「实训室 + MAC」共同定性。' +
        '★ 两室**共用同一套采集/桥接/聚合机制**（同一种 MAC 台账、同一个采集器），' +
        '差别只有"本室网段、本室来源标识、本室单元清单"三点，且三点都由数据给出（见 LAB_REGISTRY / ABB_UNIT_BASE）。',
      labWideCodes:
        '两室各自的**跨工位编码**：LAB-01 → ST-LAB01-00，LAB-05 → ST-LAB05-00。' +
        '内容：站名重复 / IP 冲突 / DCP Hello 风暴 / 网段未覆盖等**不落单一工位**的结构性异常。' +
        '兜底按"采集到该异常的工位属于哪个实训室"决定，不按全局常量（避免把 LAB-05 的异常盖成 LAB-01 的编码）。',
      partialWiring:
        'LAB-05 只有部分工位接入采集（见 pendingLab.measuredStationCodes）：' +
        '**已接入**的工位在顶层 stations[] 里有 subnet/coverage/passes，状态由真机上报；' +
        '**未接入**的工位不建 runtime，不得读成"在采但没采到设备"，也不得读成"空闲"。',
      coverageGap:
        '已知缺口：plugins/netdev-discovery/scripts/scan.ps1 不上报 coverage 字段，' +
        '因此 offlineSuppressed 在真实数据路径上恒为 false，"网段未覆盖 → 抑制 offline 推断"这条红线在该路径不触发；' +
        '本接口如实回传每轮 coverage 供核对。',
    },
    /** 两室的跨工位报警都要下发（旧版只筛 LAB-01 的，会把 LAB-05 的跨工位报警漏掉） */
    labWideAlarms: liveAlarms.filter((item) => {
      for (const lab of Object.values(LAB_REGISTRY)) {
        if (item.stationCode === lab.labWideStationCode) return true;
      }
      return false;
    }),
  };
}

/** 旧形状（`/station1/data.json`）：工位1 的 station/units/devices/alarms/coverage。 */
function legacyStation1Data(): Record<string, unknown> {
  // 工位1 恒为 `STATIONS[0]`（见 STATIONS 的排序纪律）；缺项即装配错误，不静默兜底
  const runtime = runtimes[0];
  if (runtime === undefined) throw new Error('未装配任何工位：STATIONS 为空');
  const view = stationView(runtime);
  return {
    ok: true,
    serverTime: toIso(clock.now()),
    sourceId: SOURCE_ID,
    labName: LAB_NAME,
    station: {
      stationCode: view.stationCode,
      name: view.name,
      state: view.state,
      updatedAt: view.updatedAt,
      params: view.params,
    },
    units: view.units.map((unit) => ({
      index: unit['index'],
      name: unit['name'],
      code: unit['code'],
      evidence: unit['evidence'],
      state: unit['state'],
      device: unit['device'],
      observedAt: unit['observedAt'],
    })),
    devices: view.devices,
    alarms: view.alarms,
    coverage: view.coverage,
  };
}

function sendJson(res: ServerResponse, body: Record<string, unknown>): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text, 'utf8')),
  });
  res.end(text);
}

/* ------------------------------------------- 四节看板的上游（S03 / S05 / S07） */

/**
 * 《工作盘点》四节 → 各自的**既有** JSON 服务。
 *
 * 前缀与端口**照抄 `services/gateway/src/registry.ts: defaultUpstreams()`**，不另立一套：
 * 网关那边已经用这套前缀做了最长前缀优先的路由，本启动器只是把同一份映射
 * 用在自己进程里，好让"一个看板"仍然是**一条命令**。
 *
 * ⚠️ **不新增后端语义**：本表只做"把请求转给谁"，不做任何字段改写、不做聚合、
 * 不做缓存。S01 就在本进程里，所以不在表内。
 */
interface UpstreamSpec {
  /** 路径前缀（与网关一致，不含尾斜杠） */
  readonly prefix: string;
  /** 服务名（进日志与 /board/v1/upstreams） */
  readonly service: string;
  readonly port: number;
  /** 该上游服务《工作盘点》的哪一节 */
  readonly section: string;
  /** 这一节在看板上的页签名（给人看） */
  readonly sectionName: string;
  /**
   * 转发时由**本进程**注入的入站令牌（**不进浏览器**）。
   *
   * 为什么必需：`connector-svc-http` 对**所有**路径（含 `/health`）都做认证，
   * 不在代理侧注入令牌，则看板 S03 页签只会拿到 403，看起来像"服务坏了"。
   */
  readonly inboundToken?: string;
  /** 令牌的 HTTP 头名（不同上游用不同的头） */
  readonly tokenHeader?: string;
  /** 是否按 `Authorization: Bearer <token>` 形式注入（`connector-svc-http` 要求这种） */
  readonly inboundBearer?: boolean;
}

const UPSTREAMS: readonly UpstreamSpec[] = [
  {
    prefix: '/connector',
    service: 'connector-svc-http',
    port: 8732,
    section: 'S03',
    sectionName: '资源',
    ...(CONFIG.connectorToken !== undefined
      ? { inboundToken: CONFIG.connectorToken, tokenHeader: 'authorization', inboundBearer: true }
      : {}),
  },
  /**
   * `seat-svc`（INT-SEAT-01）**直连代理** —— 只用于看板的**席位明细**。
   *
   * 为什么不能只靠 `/connector`：`connector-svc-http` 的 `/v1/status`
   * 按契约**只返回容量/占用/运行态**，**不含 `seats` 数组**
   * （见其 `handleStatus` 的返回体构造）。于是 S03 页签上的席位明细表
   * 永远是空的，而"清理本页租约"这类需要**知道具体哪个席位被哪个租约占着**
   * 的操作也就无从下手 —— 现场表现就是演示室被孤儿租约占住后无法自解。
   *
   * `seat-svc` 的 `/seat/pool/:poolId`（契约 §4.4）本来就带 `seats` 明细，
   * 因此这里**原样转发**它，不新增任何后端语义、不做字段改写。
   *
   * ⚠️ 令牌在代理侧注入、**不进浏览器**（`X-Seat-Token`）。
   */
  {
    prefix: '/seat',
    service: 'seat-svc',
    port: 8799,
    section: 'S03',
    sectionName: '资源（席位明细）',
    ...(CONFIG.seatToken !== undefined
      ? { inboundToken: CONFIG.seatToken, tokenHeader: 'x-seat-token' }
      : {}),
  },
  { prefix: '/device', service: 'device-adapter', port: 8734, section: 'S05', sectionName: '指令' },
  // S07 报警页签已按用户要求从看板撤除（2026-09-24）。这里**保留** /alarm 转发能力
  // （alarm-svc 服务本身在跑，接口仍可独立调用），但不列入看板上游健康横幅。
  { prefix: '/alarm', service: 'alarm-svc', port: 8737, section: 'S07', sectionName: '报警' },
];

/** 上游探测/转发超时。**短超时**：看板不能因为某个上游没起就一直转圈 */
const UPSTREAM_TIMEOUT_MS = 2500;

/**
 * 探一个上游是否可达。
 *
 * 用 `GET /health`（三个服务都有的既有端点）而不是"TCP 能连上就算"：
 * 端口被别的进程占用时会误报"服务在跑"，而 health 会明确回答。
 * ⚠️ 只探不缓存太久——现场是"边起服务边看"，缓存会让"刚起来"看起来还挂在"未启动"。
 */
function probeUpstream(spec: UpstreamSpec, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<{ reachable: boolean; detail: string }> {
  return new Promise((resolveResult) => {
    const req = httpRequest(
      { host: DEFAULT_BIND_HOST, port: spec.port, path: '/health', method: 'GET', timeout: timeoutMs },
      (upstreamRes) => {
        upstreamRes.resume();
        const ok = upstreamRes.statusCode !== undefined && upstreamRes.statusCode < 500;
        resolveResult({ reachable: ok, detail: `HTTP ${String(upstreamRes.statusCode ?? '?')}` });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolveResult({ reachable: false, detail: `探测超时（${timeoutMs}ms）` });
    });
    req.on('error', (error: unknown) => {
      // ECONNREFUSED 是最常见的一种：**服务没起**。如实说明，不写成"无数据"。
      const code = (error as { code?: string }).code;
      resolveResult({
        reachable: false,
        detail: code === 'ECONNREFUSED' ? `端口 ${spec.port} 无应答（服务未启动）` : describe(error),
      });
    });
    req.end();
  });
}

/**
 * 把请求原样转发给上游。
 *
 * **失败必须是失败**：上游没起时回 `502 upstream-unreachable`，
 * **绝不**回 `200 { items: [] }`——空列表会被看板读成"没有报警""没有占用"，
 * 那是把"服务没开"伪装成"一切正常"，正是本项目反复禁止的那类谎报。
 */
function proxyToUpstream(req: IncomingMessage, res: ServerResponse, spec: UpstreamSpec, path: string): void {
  const started = Date.now();

  // 入站令牌由**本进程**注入：浏览器不该持有服务令牌（同源部署，页面只跟看板说话）。
  // 口径与 `connector-svc-http/src/auth.ts` 对齐：标准 `Authorization: Bearer <token>`，
  // 且该服务对**所有**路径（含 /health）都做认证，所以这是必需项而非可选优化。
  const headers: Record<string, string> = { accept: 'application/json' };
  if (spec.inboundToken !== undefined && spec.tokenHeader !== undefined) {
    headers[spec.tokenHeader.toLowerCase()] = spec.inboundBearer === true
      ? `Bearer ${spec.inboundToken}`
      : spec.inboundToken;
  }
  /**
   * ★ **请求体相关头必须显式透传**（2026-09-23 修）。
   *
   * 曾经只透传 `accept`：GET 看不出问题，**POST 一律被上游判成
   * `GEN-1001 malformed-json-body`** —— 看起来像"调用方发的 JSON 格式不对"，
   * 实际是代理把 `content-type`/`content-length` 吞了、上游拿不到可解析的体。
   * 与"丢了查询串"是同一类缺陷：**代理吃掉了参数，却让上游报错**。
   */
  for (const name of ['content-type', 'content-length', 'authorization', 'x-request-id'] as const) {
    const value = req.headers[name];
    if (typeof value === 'string' && value !== '') headers[name] = value;
  }
  // 没有 content-length 时按 chunked 转发（`req.pipe` 会自行分块）
  if (headers['content-length'] === undefined) delete headers['content-length'];

  const proxied = httpRequest(
    {
      host: DEFAULT_BIND_HOST,
      port: spec.port,
      path,
      method: req.method,
      timeout: UPSTREAM_TIMEOUT_MS,
      headers,
    },
    (upstreamRes) => {
      const outHeaders: Record<string, string> = {
        'content-type': upstreamRes.headers['content-type'] ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-board-upstream': spec.service,
      };
      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
      upstreamRes.pipe(res);
    },
  );

  proxied.on('timeout', () => {
    proxied.destroy();
    sendUpstreamFailure(res, spec, path, `转发超时（${UPSTREAM_TIMEOUT_MS}ms）`, 504);
  });
  proxied.on('error', (error: unknown) => {
    const code = (error as { code?: string }).code;
    sendUpstreamFailure(
      res,
      spec,
      path,
      code === 'ECONNREFUSED' ? `端口 ${spec.port} 无应答（服务未启动）` : describe(error),
      502,
    );
  });
  proxied.on('close', () => {
    if (!res.writableEnded) return;
    log(`[proxy] ${spec.service} ${req.method ?? 'GET'} ${path} → ${String(res.statusCode)} (${Date.now() - started}ms)`);
  });

  req.pipe(proxied);
}

/** 上游不可达时的**显式失败响应**（看板据此显示"该节服务未启动"，而不是空数据） */
function sendUpstreamFailure(
  res: ServerResponse,
  spec: UpstreamSpec,
  path: string,
  detail: string,
  status: number,
): void {
  if (res.writableEnded) return;
  const text = JSON.stringify(
    {
      ok: false,
      error: 'upstream-unreachable',
      section: spec.section,
      sectionName: spec.sectionName,
      service: spec.service,
      port: spec.port,
      path,
      detail,
      hint: `请先启动 ${spec.service}（端口 ${spec.port}）。本页面不会用空列表冒充"没有${spec.sectionName}"。`,
    },
    null,
    2,
  );
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text, 'utf8')),
  });
  res.end(text);
}

/** 四节可达性快照（看板顶部据此逐节换词，不靠"有没有数据"猜） */
async function upstreamsHealth(): Promise<Record<string, unknown>> {
  const probes = await Promise.all(
    UPSTREAMS.map(async (spec) => {
      const probe = await probeUpstream(spec);
      return {
        section: spec.section,
        sectionName: spec.sectionName,
        service: spec.service,
        prefix: spec.prefix,
        port: spec.port,
        reachable: probe.reachable,
        detail: probe.detail,
      };
    }),
  );
  return {
    ok: true,
    serverTime: toIso(clock.now()),
    note:
      '四节看板的上游可达性。**未启动的服务在这里如实标 false**——' +
      '看板对应页签显示"该节服务未启动"，不用空列表冒充"没有数据"。',
    sections: [
      // S01 就在本进程，恒定可达
      {
        section: 'S01',
        sectionName: '工位',
        service: 'board-web（本进程）',
        prefix: '/board',
        port: CONFIG.port,
        reachable: true,
        detail: `HTTP 200（采集轮次 ${runtimes.reduce((sum, r) => sum + r.passes, 0)} 次）`,
      },
      ...probes,
    ],
  };
}

function sendHtmlFile(res: ServerResponse, file: string): void {
  void readFile(join(HERE, file))
    .then((html) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(html.byteLength),
      });
      res.end(html);
    })
    .catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`读取 ${file} 失败：${describe(error)}`);
    });
}

/** 看板的静态 JS（四节页签那段逻辑）。**只服务白名单里的文件名**，不做目录遍历 */
const STATIC_JS = new Set(['board-sections.js']);

function sendJsFile(res: ServerResponse, file: string): void {
  void readFile(join(HERE, file))
    .then((js) => {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(js.byteLength),
      });
      res.end(js);
    })
    .catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`读取 ${file} 失败：${describe(error)}`);
    });
}

/* -------------------------------------------------------------------- HTTP */

const pageServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = parsedUrl.pathname;
  /**
   * 转发用完整路径（**含查询串**）。
   *
   * ⚠️ 曾经这里只转发 `pathname`，把 `?resourcePoolId=…` 丢了，
   * 上游于是回 `GEN-1001 field:resourcePoolId`，看起来像"必填字段没填"，
   * 实际是代理把参数吞了——这类"看起来是上游的错、其实是代理的错"最难查。
   */
  const upstreamPath = `${parsedUrl.pathname}${parsedUrl.search}`;

  if (PAGE_ROUTES.has(path)) {
    sendHtmlFile(res, 'index.html');
    return;
  }

  // `/site` 与 `/station1` 是同一个多工位页面（旧链接不失效）
  if (SITE_ROUTES.has(path)) {
    sendHtmlFile(res, 'site.html');
    return;
  }

  // 看板静态 JS（四节页签逻辑）
  if (path.startsWith('/') && STATIC_JS.has(path.slice(1))) {
    sendJsFile(res, path.slice(1));
    return;
  }

  // `/site/data.json`：按工位分组的真机快照（设备参数 + 报警），**只做搬运与分组**
  if (path === SITE_DATA_PATH) {
    sendJson(res, siteData());
    return;
  }

  // `/station1/data.json`：兼容旧调用方，返回工位1 的旧扁平形状（字段名不变）
  if (path === LEGACY_STATION1_DATA_PATH) {
    sendJson(res, legacyStation1Data());
    return;
  }

  // 四节看板：上游可达性。**必须排在 `/board/v1/*` 之前**——
  // board-web 的处理器不认识 `upstreams`，排在后面会被它吞成 route-not-found。
  if (path === '/board/v1/upstreams') {
    void upstreamsHealth()
      .then((body) => {
        sendJson(res, body);
      })
      .catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'upstreams-probe-failed', detail: describe(error) }));
      });
    return;
  }

  // `/board/v1/*`（含 SSE `/board/v1/events`）统一交给真实看板 HTTP 处理器
  if (path === '/board/v1' || path.startsWith('/board/v1/')) {
    board.server.server.emit('request', req, res);
    return;
  }

  // 四节看板：S01 之外的另外三节（S03 资源 / S05 指令 / S07 报警）
  // 按网关同名前缀原样转发；上游没起时回显式 502，**不回空列表**。
  for (const spec of UPSTREAMS) {
    if (path === spec.prefix || path.startsWith(`${spec.prefix}/`)) {
      proxyToUpstream(req, res, spec, upstreamPath);
      return;
    }
  }

  // 其余路径：给人话页面而不是 JSON 报错。
  // 为什么：现场是**手输/复制**地址的，把 URL 和 Markdown 加粗写在一起、
  // 或少一个斜杠都会走到这里；回一个 `route-not-found` 的 JSON 只会让人以为服务坏了。
  const target = path === '' ? '/' : path;
  const html = `<!doctype html><meta charset="utf-8"><title>路径不存在 · 多工位真机看板</title>
<body style="font:14px/1.7 system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:32px">
<h1 style="font-size:18px">路径不存在：<code style="color:#fca5a5">${escapeHtml(target)}</code></h1>
<p>服务是好的，只是这个地址没有对应页面。可用的入口只有两个：</p>
<ul>
  <li><a style="color:#7dd3fc" href="/">正式看板</a> · <code>/</code> —— 三级浏览（校区 → 实训室 → 工位）</li>
  <li><a style="color:#7dd3fc" href="/site">真机总览（LAB-01 工位1~4 + LAB-05 已接入工位）</a> · <code>/site</code>（等价 <code>/station1</code>）</li>
</ul>
<p style="color:#94a3b8">数据接口都在 <code>/board/v1/*</code>（如 <code>/board/v1/tree</code>、SSE <code>/board/v1/events</code>）
与 <code>/site/data.json</code>（按工位分组的设备参数与报警）。</p>
<p style="color:#64748b;font-size:12px">来源：${Object.values(LAB_REGISTRY)
    .map((lab) => `${lab.labCode} 用 ${lab.sourceId}（授权前缀 ${lab.labWideStationCode.replace(/00$/, '')}）`)
    .join(' ｜ ')} · 真实二层观测（非演示数据）</p>
</body>`;
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

pageServer.listen(CONFIG.port, DEFAULT_BIND_HOST, () => {
  const size = board.view.size();
  log('────────────────────────────────────────────');
  log(`页面（真机总览，LAB-01 工位1~4 + LAB-05 已接入工位）  http://${DEFAULT_BIND_HOST}:${CONFIG.port}/site`);
  log(`页面（同上，旧链接）        http://${DEFAULT_BIND_HOST}:${CONFIG.port}/station1`);
  log(`页面（正式看板）            http://${DEFAULT_BIND_HOST}:${CONFIG.port}/`);
  for (const lab of Object.values(LAB_REGISTRY)) {
    log(`工位 JSON（${lab.labCode}）           http://${DEFAULT_BIND_HOST}:${CONFIG.port}/board/v1/tree?labCode=${lab.labCode}`);
  }
  log(`工位详情                   http://${DEFAULT_BIND_HOST}:${CONFIG.port}/board/v1/stations/${STATION2_CODE}`);
  log(`分组快照                   http://${DEFAULT_BIND_HOST}:${CONFIG.port}${SITE_DATA_PATH}`);
  log(`事件流（SSE）              http://${DEFAULT_BIND_HOST}:${CONFIG.port}/board/v1/events`);
  log(
    `目录 ${size.campuses} 校区 / ${size.labs} 实训室 / ${size.stations} 工位` +
      `（单元清单**按本室各自组成**：LAB-01 ${UNIT_BASE.length} 个功能单元、LAB-05 ${ABB_UNIT_BASE.length} 个执行模块；` +
      `未上报的显示为「未上报/归属未确认」，不是空闲）`,
  );
  log(`采集轮周期 ${CONFIG.pollIntervalMs}ms · 监听 ${CONFIG.listenSeconds}s/${CONFIG.listenIntervalMs}ms · 审计 ${CONFIG.auditPath}`);
  log('Ctrl+C 停止');
  log('────────────────────────────────────────────');
  // 上线先各跑一轮采集（首轮）：四个工位**并发**（工位2 是独立网段；工位1/3/4 同网段但按各自 MAC 台账归位）。
  // 监听窗口随后串行跑一轮（整块网卡的被动窗口，同时开多个没有意义）。
  void (async (): Promise<void> => {
    await scanRound();
    await listenRound();
  })();
});

/* -------------------------------------------------------------------- 关停 */

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`收到 ${signal}：停循环 → 关看板`);
  if (roundTimer !== undefined) clearTimeout(roundTimer);
  if (listenTimer !== undefined) clearTimeout(listenTimer);
  const auditStats = audit.stats();
  const alarmStats = alarm.stats();
  log(`审计 JSONL 已写 ${auditStats.written} 条（失败 ${auditStats.failed}）`);
  log(`告警 POST attempted=${alarmStats.attempted} accepted=${alarmStats.accepted} failed=${alarmStats.failed}`);
  for (const runtime of runtimes) {
    log(
      `工位 ${runtime.spec.stationCode} 采集器统计 ${JSON.stringify(runtime.collector.collector.stats)} ` +
        `· 投递 ${JSON.stringify(runtime.collector.reporter.stats())}`,
    );
  }
  await board.dispose();
  pageServer.close(() => process.exit(0));
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
