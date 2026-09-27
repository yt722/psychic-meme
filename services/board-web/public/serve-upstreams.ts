/**
 * 上游服务启动器（四节看板的 S03 / S05 / S07 宿主）
 * ============================================================
 * 背景：四节看板（`/` 的四个页签）要求**一个看板覆盖**《工作盘点》S01/S03/S05/S07。
 * S01 由 `site-live.ts` 本进程承载；另外三节各自的 HTTP 服务在本仓库里
 * **只在测试里起过，从来没有可运行的启动脚本**。本文件补这一环。
 *
 * ## 为什么放这里而不是改各服务的 src
 *
 * 三个服务的 `src/` 受 `verification/production-graph.test.ts` 的**构建期扫描**约束
 * （生产入口里出现 `Fake*`/`InMemory*` 一律失败，且有棘轮上限）。
 * 启动脚本属于**部署层**，在这里按需注入真实实现，不动被扫描的生产闭包。
 *
 * ## 三个服务的真实可启动性（逐个核实，2026-09-23）
 *
 * | 节 | 服务 | 能否起 | 依据 |
 * |---|---|---|---|
 * | S05 | `device-adapter` | ✅ | `DeviceAdapterService` 的 audit/alarm/sources 全部可显式注入，缺省只在"没给"时才落到内存出口 |
 * | S03 | `connector-svc-http` | ✅ | `createConnectorServer(deps)` 依赖全为入参，`registry` 由 `registryFromConfig` 构造 |
 * | S07 | `alarm-svc` | ❌ **起不来** | `createAlarmServer` 要 `AlarmService` 门面；门面在桶文件 `index.ts` 里，而该文件 re-export 了 `InMemoryNotifier`/`InMemoryAuditLog`/`InMemoryAlarmRepository`——从它取门面就会把替身带进生产闭包，而扫描禁止该闭包出现替身（**无豁免**，且参考位棘轮 `MAX_REFERENCE_ALLOWLIST=4` 已满，无法新增登记） |
 *
 * ⇒ S07 **起不来就如实说**，不假装起来了；看板 S07 页签会显示"该节服务未启动"。
 *
 * ## 用法
 *
 *   node --import tsx services/board-web/public/serve-upstreams.ts \
 *     --seat-token=<席位服务令牌> --connector-token=<入站令牌>
 *   node --import tsx services/board-web/public/serve-upstreams.ts --only=device
 */

import { mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SystemClock } from '@peripheral/core';

import { DeviceAdapterService } from '../../device-adapter/src/index.js';
import { createDeviceServer } from '../../device-adapter/src/http.js';
import type { AuditSink, AlarmSink } from '../../device-adapter/src/types.js';
import { createConnectorServer } from '../../connector-svc-http/src/http.js';
import { ConnectorRegistry, registryFromConfig } from '../../connector-svc-http/src/registry.js';
import type { AdapterFactory } from '../../connector-svc-http/src/registry.js';
import { AuditLog } from '../../connector-svc-http/src/types.js';
import type { AlarmSink as ConnAlarmSink } from '../../connector-svc/src/domain/types.js';
import { Authenticator } from '../../connector-svc-http/src/auth.js';
import { createSeatAdapter } from '../../connector-svc/src/adapters/seat-adapter-factory.js';
import { createProductionAlarm } from '../../alarm-svc/src/production.js';
import { createAlarmServer } from '../../alarm-svc/src/http.js';
import { ALARM_PARAM } from '../../alarm-svc/src/params.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PERIPHERAL_ROOT = join(HERE, '..', '..', '..');

/** 端口与 `services/gateway/src/registry.ts` 的 `defaultUpstreams()` **同值**，不另立一套 */
const PORTS = { connector: 8732, device: 8734, alarm: 8737 } as const;

const BIND_HOST = '127.0.0.1';

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
}

function log(message: string): void {
  console.log(`[upstreams] ${message}`);
}

function upstreamDataDir(): string {
  const p = join(PERIPHERAL_ROOT, 'data', 'upstreams');
  mkdirSync(p, { recursive: true });
  return p;
}

/**
 * 落盘型审计出口（JSONL 追加）。**不是**内存出口：重启后仍可查。
 *
 * 接口是 `device-adapter` 的 `AuditSink`：`record(entry)`（见其 `types.ts:92`）。
 */
function fileAuditSink(path: string): AuditSink {
  return {
    record: (entry): void => {
      void appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8').catch(() => undefined);
    },
  };
}

/** 落盘型告警出口。`device-adapter` 的 `AlarmSink`：`raise(alarm)`（`types.ts:97`） */
function fileAlarmSink(path: string): AlarmSink {
  return {
    raise: (alarm): void => {
      void appendFile(path, `${JSON.stringify(alarm)}\n`, 'utf8').catch(() => undefined);
    },
  };
}

/** `connector-svc-http` 的告警出口是另一个接口（`emit`），不共用上面的 `raise` */
function fileConnAlarmSink(path: string): ConnAlarmSink {
  return {
    emit: (event: unknown): void => {
      void appendFile(path, `${JSON.stringify(event)}\n`, 'utf8').catch(() => undefined);
    },
  } as unknown as ConnAlarmSink;
}

/* --------------------------------------------------------------- S05 指令 */

async function startDevice(clock: SystemClock): Promise<{ close: () => Promise<number | void> }> {
  const dir = upstreamDataDir();
  const audit = fileAuditSink(join(dir, 'device-adapter-audit.jsonl'));
  const alarm = fileAlarmSink(join(dir, 'device-adapter-alarm.jsonl'));

  // audit / alarm / sources 全部显式注入 ⇒ 构造函数里的内存缺省分支不会被走到
  const service = new DeviceAdapterService({
    clock,
    audit,
    alarm,
    productionMode: true,
    sources: [
      {
        sourceId: 'SRC-NETDEV-LAB01',
        kind: 'real' as const,
        labCodes: ['LAB-01'],
        description: '上游启动器（S05 指令节）— LAB-01 二层观测来源',
      },
      {
        sourceId: 'SRC-NETDEV-LAB05',
        kind: 'real' as const,
        labCodes: ['LAB-05'],
        description: '上游启动器（S05 指令节）— LAB-05 二层观测来源',
      },
    ],
  });

  const server = createDeviceServer({
    service,
    clock,
    logger: (record: Record<string, unknown>) => { log(`[device] ${JSON.stringify(record)}`); },
  });

  const actual = await server.listen(PORTS.device, BIND_HOST);
  log(`S05 device-adapter 监听 http://${BIND_HOST}:${actual}`);
  return { close: () => server.close() };
}

/* --------------------------------------------------------------- S03 资源 */

async function startConnector(clock: SystemClock): Promise<{ close: () => Promise<number | void> }> {
  const dir = upstreamDataDir();

  // 席位管理服务的令牌由**部署**给出。缺它就让装配期抛错——这正是
  // `createSeatAdapter(..., {productionMode:true})` 的设计意图（fail-closed）：
  // 用占位令牌起服务，会让每一次调用都被对端拒成"外部故障"，比直接不起更难查。
  const seatToken = flag('seat-token');
  if (seatToken === undefined) {
    throw new Error(
      '缺少 --seat-token=<席位管理服务令牌>：生产模式下不提供令牌会被装配期拒绝（这是设计意图，不是缺陷）。' +
        '请用 --seat-token=… 指定；未指定时本启动器**不启动 S03**，看板会如实显示该节未启动。',
    );
  }

  // 真机席位适配器：工厂在生产模式下**拒绝替身引用、拒绝缺令牌**
  const seatFactory: AdapterFactory = (entry) =>
    createSeatAdapter(
      {
        poolId: entry.poolId,
        adapterRef: entry.adapterRef,
        options: {
          baseUrl: flag('seat-url') ?? 'http://127.0.0.1:8799',
          timeoutMs: 5000,
          token: seatToken,
        },
      },
      { productionMode: true, onWarn: (m: string) => { log(`[seat] ${m}`); } },
    );

  const built = registryFromConfig(
    [
      {
        poolId: 'RP-SEAT-LAB01',
        // ConnectorKind 的取值是 'seat' | 'vu' | 'inst'（connector-svc-http/src/types.ts:26）
        kind: 'seat',
        adapterRef: 'seat-http',
        labCode: 'LAB-01',
      },
      {
        /**
         * ★ LAB-05 工业机器人应用技术实训室（ABB）的席位池。
         *
         * 现场部署：本机（LAPTOP-JG3HSIUI）暂作该室工位2 的**边缘设备电脑**，
         * 跑着 `services/seat-svc`（契约 INT-SEAT-01），承载该室 **12 个逻辑席位**。
         *
         * ⚠️ 池号必须与 seat-svc 的 `PARAM-SEAT-POOL-ID` 一致，
         * 也必须与看板 S03 页签请求的一致（`board-sections.js` 写死 `RP-SEAT-LAB05`），
         * 三处任意一处不符就会得到 `pool-not-registered` 或 404 —— 现场最难查的一类错。
         *
         * ⚠️ 与 `RP-SEAT-LAB01` **不可互换**：两室是独立载体（网段/工位编码/席位号都不同）。
         */
        poolId: 'RP-SEAT-LAB05',
        kind: 'seat',
        adapterRef: 'seat-http',
        labCode: 'LAB-05',
      },
      {
        /**
         * 演示室 `LAB-99`：**把本机当作一个模拟席位**（`SEAT-LAB99-01`）。
         *
         * 为什么单开一个室：12 工位席位是**真工位台账**，拿它做四动作演练
         * 会把占用记录与换人清理窗口写进真台账，事后分不清"是演示还是真有人用"。
         *
         * ⚠️ 池号**必须**是 `RP-SEAT-LAB<2位>` —— 三个校验点缺一不可（都踩过）：
         *   ① `POOL_RE`（packages/core/coding.ts）：只认 RP-SEAT-LAB<2位> / RP-VU-<3位> / RP-INST-<2位>
         *      ⇒ 自造的 `RP-SEAT-DEMO` 被注册表拒绝
         *   ② 席位适配器只接受 `/^RP-SEAT-/`
         *      ⇒ 借道的 `RP-VU-901` 被适配器拒绝
         *   ③ `labCode` 须为 `LAB-<2位>`
         *      ⇒ `DEMO` 被 assertLabCodeValid 拒绝
         * 三次都被拒 ⇒ 不绕契约，直接用它的格式开一个 `LAB-99` 演示室：
         * 三层校验全部合法，且 `99` 明显不在真实室号段（本室只有 01/05）。
         */
        poolId: 'RP-SEAT-LAB99',
        kind: 'seat',
        adapterRef: 'seat-http',
        labCode: 'LAB-99',
      },
    ],
    { 'seat-http': seatFactory },
    new ConnectorRegistry(),
  );

  // 入站认证令牌（与本服务对**外**调用的 seat-token 是两回事）。
  const inboundToken = flag('connector-token') ?? 'upstreams-unset-token';
  if (flag('connector-token') === undefined) {
    log('[connector] ⚠️ 未提供 --connector-token=：入站调用需带该占位令牌，否则 401（不会放行）');
  }

  const server = createConnectorServer({
    registry: built.registry,
    // 认证是 **先判来源 IP、再判令牌**（auth.ts:77-101）：
    //   · `allowedIps` 缺省为 `[]` = **全部拒绝**（fail-closed），因此必须显式给出
    //   · 令牌走标准 `Authorization: Bearer …`，不是自定义头
    auth: new Authenticator({
      token: inboundToken,
      allowedIps: (flag('connector-allow') ?? '127.0.0.1,::1').split(',').map((s) => s.trim()),
    }),
    clock,
    audit: new AuditLog({ clock }),
    alarms: fileConnAlarmSink(join(dir, 'connector-alarm.jsonl')),
    logger: (record: Record<string, unknown>) => { log(`[connector] ${JSON.stringify(record)}`); },
  });

  // ConnectorServer 没有 listen()，只暴露底层 `server` 句柄
  const actual = await new Promise<number>((resolveListen) => {
    server.server.listen(PORTS.connector, BIND_HOST, () => {
      const addr = server.server.address();
      resolveListen(typeof addr === 'object' && addr !== null ? addr.port : PORTS.connector);
    });
  });
  log(`S03 connector-svc-http 监听 http://${BIND_HOST}:${actual}（池：${built.poolIds.join(', ')}）`);
  return { close: () => server.close() };
}

/* --------------------------------------------------------------- S07 报警 */

async function startAlarm(clock: SystemClock): Promise<{ close: () => Promise<number | void> }> {
  const dir = upstreamDataDir();

  // 生产装配要求 **https 通知出口 + 令牌**（notifier-http.ts:239-247 是硬约束，不是建议）。
  // 缺它们就让装配期抛错并如实报告——用一个假的 http 出口起服务，
  // 会让每次报警投递都以"外部故障"告终，比不起更难查。
  const webhookUrl = flag('alarm-webhook');
  const webhookToken = flag('alarm-token');
  if (webhookUrl === undefined || webhookToken === undefined) {
    throw new Error(
      '缺少 --alarm-webhook=https://… 与 --alarm-token=…：' +
        '生产装配要求 https 通知出口 + 令牌（notifier-http.ts 的硬约束）。' +
        '未提供时本启动器**不启动 S07**，看板会如实显示该节未启动。',
    );
  }

  const wiring = createProductionAlarm({
    repositoryPath: join(dir, 'alarm-repository.jsonl'),
    auditPath: join(dir, 'alarm-audit.jsonl'),
    // 占用查询：本启动器不猜谁在工位上——返回空表示"无占用记录"，
    // 关联出来的 affectedUsers 因此为空，这是**如实**而不是丢失。
    occupancy: { whoIsAt: () => [] },
    notifyToken: webhookToken,
    localOverrides: {
      // 用常量引用编号，不写裸字符串（仓库不变量 4：避免拼写漂移）
      [ALARM_PARAM.NOTIFY_WEBHOOK_URL]: webhookUrl,
    },
    clock,
    onWarn: (message: string) => { log(`[alarm] ${message}`); },
  });
  log('S07 alarm-svc 装配完成（仓库/审计落盘，通知出口为 https webhook）');

  const server = createAlarmServer({
    service: wiring.service,
    logger: (record: Record<string, unknown>) => { log(`[alarm] ${JSON.stringify(record)}`); },
  });

  const actual = await server.listen(PORTS.alarm, BIND_HOST);
  log(`S07 alarm-svc 监听 http://${BIND_HOST}:${actual}`);
  return { close: () => server.close() };
}

/* ------------------------------------------------------------------- 主流程 */

const only = flag('only');
const clock = new SystemClock();
const started: Array<{ name: string; close: () => Promise<number | void> }> = [];

log('四节看板上游启动器 · 端口与网关登记一致（S03=8732 / S05=8734 / S07=8737）');

if (only === undefined || only === 'device') {
  try {
    started.push({ name: 'S05 device-adapter', ...(await startDevice(clock)) });
  } catch (error) {
    log(`❌ S05 device-adapter 启动失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

if (only === undefined || only === 'connector') {
  try {
    started.push({ name: 'S03 connector-svc-http', ...(await startConnector(clock)) });
  } catch (error) {
    log(`❌ S03 connector-svc-http 启动失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

if (only === undefined || only === 'alarm') {
  try {
    started.push({ name: 'S07 alarm-svc', ...(await startAlarm(clock)) });
  } catch (error) {
    log(`❌ S07 alarm-svc 启动失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

log(`已启动 ${started.length} 个上游：${started.map((s) => s.name).join('、') || '（无）'}`);

const shutdown = async (): Promise<void> => {
  log('正在停止上游…');
  for (const s of started) await s.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
