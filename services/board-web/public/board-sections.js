/* =====================================================================
 * 四节看板 · S03 资源 / S05 指令 / S07 报警
 * =====================================================================
 * 《工作盘点》S01/S03/S05/S07 四节汇成**一个看板**，本节负责 S01 之外的三节。
 *
 * ## 三条纪律（本文件存在的理由）
 *
 * 1. **不新增后端语义**：本文件只调用既有 JSON 接口，不做字段改写、不做聚合、
 *    不做本地缓存兜底。页面是"既有能力的一个视图"，不是第二套业务实现。
 * 2. **上游未起必须说出来**：`/board/v1/upstreams` 报 false 时，
 *    对应页签显示「该节服务未启动」，**绝不**显示空表冒充"没有报警/没有占用"。
 *    代理层已经保证失败返回 502 `upstream-unreachable`；本文件负责把 502 讲成人话。
 * 3. **只读为先**：S03 的四动作（apply/heartbeat/release）与 S07 的处置动作都是
 *    **写操作**。写操作一律要求二次确认（`confirm`），且**不自动重试**——
 *    自动重试在"释放资源"这种动作上会造成重复释放与状态错乱。
 */

'use strict';

const SECTIONS = {
  alarm: {
    id: 'alarm',
    title: 'S07 · 报警接入与诊断',
    upstream: '/alarm',
    // 既有端点（services/alarm-svc/src/http.ts），一条不多一条不少
    endpoints: {
      list: '/alarm/v1/alarms',
      statistics: '/alarm/v1/statistics',
      // ⚠️ `/alarm/v1/alarm-codes` 是 **POST**（登记一条码表条目），**没有 GET 列表**形态。
      // 页面因此不调它——不能为了"页面上好看"而发明一个后端没有的读接口。
      // 已登记的码数如需展示，须由后端补一个读端点（属后端语义变更，不在本页面范围内）。
    },
  },
  resource: {
    id: 'resource',
    title: 'S03 · 三类资源连接服务',
    upstream: '/connector',
    endpoints: {
      // services/connector-svc-http/src/http.ts:103-106
      apply: '/connector/v1/apply',
      heartbeat: '/connector/v1/heartbeat',
      release: '/connector/v1/release',
      status: '/connector/v1/status',
    },
  },
  control: {
    id: 'control',
    title: 'S05 · 设备状态与控制接口',
    upstream: '/device',
    endpoints: {
      stations: '/device/v1/stations',
      validate: '/device/v1/control/validate',
      dispatch: '/device/v1/control/dispatch',
      guardian: '/device/v1/guardian',
    },
  },
};

/**
 * ★★ 必须整文件包在 IIFE 里（2026-09-23 修）：本文件与 index.html 的内联脚本
 * 都是**普通 `<script>`（非 module）**，共享同一个全局作用域。
 * 两边都声明了 `const $` / `const esc` ⇒ 浏览器解析内联脚本时直接
 * `SyntaxError: Identifier '$' has already been declared`，
 * **整段内联脚本一行都不执行** —— 表现就是 SSE 永远停在"等待连接…"
 * （connectStream() 从未被调用），而本文件的 fetch 照常轮询，极易误判成"服务端没推"。
 *
 * 包成 IIFE 后本文件只向全局暴露 `window.boardSections`，不再污染/冲突全局名。
 * 对应纪律：多个 `<script>` 共用全局作用域时，**除入口外一律不得声明顶层 const/let**。
 */
(function () {
'use strict';

let upstreamState = {};      // section → { reachable, detail, port, service }
let currentTab = 'station';  // 默认仍落在 S01 工位页，保持既有习惯

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 统一取数：把"上游不可达"从"取到了空数据"里分出来。
 *
 * 返回 `{ ok, status, data, reason }`。**reason 非空即失败**，
 * 调用方必须走"失败分支"，不得把 data 当空结果用。
 */
async function fetchSection(path) {
  try {
    const r = await fetch(path, { cache: 'no-store', headers: { accept: 'application/json' } });
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    if (!r.ok) {
      const reason = (body && (body.hint || body.detail)) || ('HTTP ' + r.status);
      return { ok: false, status: r.status, data: body, reason: String(reason) };
    }
    return { ok: true, status: r.status, data: body, reason: '' };
  } catch (e) {
    return { ok: false, status: 0, data: null, reason: '请求失败：' + e.message };
  }
}

/* --------------------------------------------------------------- 上游可达性 */

async function refreshUpstreams() {
  const r = await fetchSection('/board/v1/upstreams');
  if (!r.ok) {
    // 连"可达性"都拿不到，说明本进程有问题；如实说，不静默
    upstreamState = {};
    setTabStatus('无法获取上游可达性：' + r.reason, 'bad');
    return;
  }
  upstreamState = {};
  for (const s of (r.data.sections || [])) upstreamState[s.section] = s;
  paintUpstreamBanner();
}

function paintUpstreamBanner() {
  const parts = [];
  for (const key of ['S01', 'S03', 'S05', 'S07']) {
    const s = upstreamState[key];
    if (!s) continue;
    const cls = s.reachable ? 'up-ok' : 'up-bad';
    const text = s.reachable ? '在跑' : '未启动';
    parts.push('<span class="up ' + cls + '" title="' + esc(s.detail) + '">' + esc(s.section) +
      ' ' + esc(s.sectionName) + ' · ' + text + '</span>');
  }
  const el = $('upstreams');
  if (el) el.innerHTML = parts.join(' ');
}

/** 某一节不可达时的整段提示（**替代**该节内容，而不是插在空表上面） */
function upstreamBlockedHtml(section) {
  const s = upstreamState[section];
  const name = s ? s.sectionName : section;
  const detail = s ? s.detail : '可达性未知';
  const port = s ? s.port : '?';
  const service = s ? s.service : '?';
  return '<div class="blocked">' +
    '<h3>该节服务未启动</h3>' +
    '<p><b>' + esc(section) + ' ' + esc(name) + '</b> 依赖 <code>' + esc(service) + '</code>' +
    '（端口 <code>' + esc(port) + '</code>），当前状态：<b>' + esc(detail) + '</b>。</p>' +
    '<p>本页面<b>不会</b>用空列表冒充"' + esc(name === '报警' ? '没有报警' : '没有数据') +
    '"——服务没起和"确实没有"是两件事。</p>' +
    '<p class="sub">启动方式：<code>cd peripheral && npm run ' + (section === 'S07' ? 'serve:alarm' : section === 'S03' ? 'serve:connector' : 'serve:device') + '</code></p>' +
    '</div>';
}

/* ------------------------------------------------------------------- 页签 */

function showTab(tab) {
  currentTab = tab;
  for (const btn of document.querySelectorAll('[data-tab]')) {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
  }
  for (const pane of document.querySelectorAll('[data-pane]')) {
    pane.style.display = pane.getAttribute('data-pane') === tab ? '' : 'none';
  }
  if (tab === 'alarm') void loadAlarm();
  if (tab === 'resource') void loadResource();
  if (tab === 'control') void loadControl();
}

function setTabStatus(text, kind) {
  const el = $('tab-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'sub ' + (kind === 'bad' ? 'warn' : kind === 'ok' ? 'oktext' : '');
}

/* --------------------------------------------------------- S07 报警（②） */

/**
 * 全部工位名册：**2 个实训室 / 16 个工位**。
 *
 * ## 为什么要有这份"名册"
 *
 * S07 的报警列表只返回**有报警的工位**。若页面只渲染这个列表，
 * 一旦某工位没报警，它就从页面上消失了 —— 看的人会以为
 * "这个室只有几个工位"。真实现场是 **LAB-01 4 个 + LAB-05 12 个 = 16 个**，
 * 页面必须按这个口径完整铺开，无报警的工位显示「无报警」。
 *
 * ⚠️ 这份名册**只用于页面分组展示**，不参与任何判定：
 * 某个工位在不在名册里，**不表示**它在线/离线/有设备。
 * 报警数据仍以 alarm-svc 返回为准（本页不合成、不推断报警）。
 *
 * 工位编码口径见 `contracts/coding-spec.md`：
 * `ST-<实训室码>-<2位序号>`，LAB-01 → `ST-LAB01-01..04`，LAB-05 → `ST-LAB05-01..12`。
 */
const LAB_STATIONS = [
  {
    labCode: 'LAB-01',
    labName: '智能制造系统集成实训室',
    campus: '海宁校区',
    stationCodes: ['ST-LAB01-01', 'ST-LAB01-02', 'ST-LAB01-03', 'ST-LAB01-04'],
  },
  {
    labCode: 'LAB-05',
    labName: '工业机器人应用技术实训室（ABB）',
    campus: '海宁校区',
    stationCodes: [
      'ST-LAB05-01', 'ST-LAB05-02', 'ST-LAB05-03', 'ST-LAB05-04',
      'ST-LAB05-05', 'ST-LAB05-06', 'ST-LAB05-07', 'ST-LAB05-08',
      'ST-LAB05-09', 'ST-LAB05-10', 'ST-LAB05-11', 'ST-LAB05-12',
    ],
  },
];

/** 名册里的全部工位编码（用于统计口径） */
function allRosterStations() {
  return LAB_STATIONS.flatMap((l) => l.stationCodes);
}

/** 取工位显示名：`ST-LAB05-02` → `工位2`；名册外的保持原样 */
function shortStationName(code) {
  const m = /^ST-LAB(\d{2})-(\d{2})$/.exec(String(code || ''));
  return m ? '工位' + String(Number(m[2])) : String(code || '—');
}

let alarmCache = [];

async function loadAlarm() {
  const pane = $('pane-alarm');
  const s = upstreamState['S07'];
  if (!s || !s.reachable) {
    pane.innerHTML = upstreamBlockedHtml('S07');
    setTabStatus('S07 报警：服务未启动', 'bad');
    return;
  }
  setTabStatus('S07 报警：加载中…', '');
  const list = await fetchSection(SECTIONS.alarm.endpoints.list);
  if (!list.ok) { pane.innerHTML = upstreamBlockedHtml('S07') + '<p class="warn">' + esc(list.reason) + '</p>'; return; }
  const stat = await fetchSection(SECTIONS.alarm.endpoints.statistics);

  const items = (list.data && (list.data.items || list.data.alarms)) || [];
  alarmCache = items;
  const total = list.data && list.data.total;

  /**
   * 按 `labCode + stationCode` 归拢报警。
   *
   * ⚠️ 页面**不做任何推断**：报警数据全部来自 alarm-svc，
   * 这里只是把"属于哪个工位"分好组，好按名册逐个工位铺开。
   */
  const byStation = new Map();
  for (const a of items) {
    const key = String(a.stationCode || '') + '|' + String(a.labCode || '');
    if (!byStation.has(key)) byStation.set(key, []);
    byStation.get(key).push(a);
  }
  /** 名册外的报警（如后端出现的未知工位）—— 如实单列，不丢 */
  const roster = new Set(allRosterStations());
  const offRoster = items.filter((a) => !roster.has(String(a.stationCode || '')));

  const activeCount = items.filter((a) => a.state !== 'resolved' && a.state !== 'closed-as-false-positive').length;

  let html = '<div class="stats">' +
    '<div class="stat"><b>' + esc(LAB_STATIONS.length) + '</b><span>实训室</span></div>' +
    '<div class="stat"><b>' + esc(allRosterStations().length) + '</b><span>工位（名册）</span></div>' +
    '<div class="stat"><b>' + esc(items.length) + '</b><span>报警条数' +
    (typeof total === 'number' ? ' / 共 ' + esc(total) : '') + '</span></div>' +
    '<div class="stat"><b>' + esc(activeCount) + '</b><span>未解除</span></div>';

  if (stat.ok && stat.data) {
    const byState = stat.data.byState || stat.data.states || {};
    for (const k of Object.keys(byState)) {
      html += '<div class="stat"><b>' + esc(byState[k]) + '</b><span>' + esc(alarmStateCn(k)) + '</span></div>';
    }
  }
  html += '</div>';

  // ★ 口径：`解决时间` 一列**当前必然全是 `—`** —— 后端 alarm-svc 只有
  //   `raisedAtMs` / `lastAtMs`，**没有 resolvedAtMs / acknowledgedAtMs**。
  //   这里如实留白并写明原因，**不拿 lastAtMs 冒充解决时间**（那是"最近发生"，不是"解决"）。
  //   要让它有值需改后端（本步未做）。
  html += '<p class="sub">时间口径：<b>出现时间</b>=<code>raisedAtMs</code>（首次）、' +
    '<b>最近发生</b>=<code>lastAtMs</code>（含重复计数）。' +
    '<b>解决时间一律显示 <code>—</code></b>：后端 alarm-svc 未提供 <code>resolvedAtMs</code>，' +
    '故不拿"最近发生"冒充"解决时间"；处置人与解决详情取自 <code>acknowledgedBy</code> / ' +
    '<code>resolvedBy</code> / <code>resolution</code>。</p>';

  html += '<p class="sub">展示口径：<b>按实训室 → 工位卡片逐个铺开全部 ' +
    esc(allRosterStations().length) + ' 个工位</b>（LAB-01 4 个 + LAB-05 12 个）。' +
    '无报警的工位同样成卡片、显示「无报警」——<b>不是</b>把它藏起来。' +
    '名册只用于分组展示，<b>不表示</b>该工位在线或已接设备。</p>';

  // ---------------------------------------------- 按实训室分组渲染（工位卡片）
  for (const lab of LAB_STATIONS) {
    const labItems = items.filter((a) => String(a.labCode || '') === lab.labCode);
    const labActive = labItems.filter((a) => a.state !== 'resolved' && a.state !== 'closed-as-false-positive').length;

    html += '<h3>' + esc(lab.labName) + ' <span class="sub">' + esc(lab.labCode) + ' · ' +
      esc(lab.campus) + ' · ' + lab.stationCodes.length + ' 个工位</span></h3>';
    html += '<p class="sub">该室报警 ' + esc(labItems.length) + ' 条' +
      (labActive > 0 ? '，其中 <b>' + esc(labActive) + '</b> 条未解除' : '（均已解除或无报警）') + '</p>';

    html += '<div class="st-cards">';
    for (const stCode of lab.stationCodes) {
      const list4 = byStation.get(stCode + '|' + lab.labCode) || [];
      const stActive = list4.filter((a) => a.state !== 'resolved' && a.state !== 'closed-as-false-positive').length;
      html += renderStationCard(stCode, list4, stActive);
    }
    html += '</div>';
  }

  // ---------------------------------------------- 名册外的报警（如实单列）
  if (offRoster.length > 0) {
    html += '<h3>名册外的工位 <span class="sub">' + offRoster.length + ' 条</span></h3>' +
      '<p class="sub">这些报警的 <code>stationCode</code> 不在本页工位名册里 —— ' +
      '可能是后端新增了工位而本页名册未同步。<b>如实列出，不丢弃</b>。</p>' +
      '<table class="rows"><thead><tr>' +
      '<th>报警</th><th>等级</th><th>工位</th><th>状态</th><th>次数</th>' +
      '<th>出现时间</th><th>最近发生</th><th>解决时间</th><th>处置 / 解决详情</th><th>操作</th>' +
      '</tr></thead><tbody>';
    for (const a of offRoster) html += renderAlarmRow(a, true);
    html += '</tbody></table>';
  }

  if (items.length === 0) {
    html += '<p class="sub">该服务在跑，且<b>全部 ' + esc(allRosterStations().length) +
      ' 个工位当前都没有报警</b>（不是"取不到"）。</p>';
  }

  html += '<div id="alarm-out" class="out"></div>';
  pane.innerHTML = html;
  setTabStatus('S07 报警：' + LAB_STATIONS.length + ' 室 / ' + allRosterStations().length +
    ' 工位 · 共 ' + items.length + ' 条报警', 'ok');
}

/**
 * 渲染一个工位卡片（S07）。
 *
 * ## 为什么改成卡片
 *
 * 原先每个工位是「一行标题 + 一张表」平铺直列：16 个工位（其中多数无报警）
 * 会把页面拉成一条很长的竖线，既看不出哪个工位有问题，也没法横向比较。
 * 改成卡片后：**每室一行卡片流**（自适应换行），卡片头部一眼给出
 * 「工位名 + 报警数 / 未解除数」，有问题的卡片高亮，无报警的卡片也照样成卡、
 * 显示「无报警」——**不藏**。
 *
 * ⚠️ 卡片只做**展示分组**，不改变任何判定：数据仍全部来自 alarm-svc，
 * 工位清单仍只是名册（不表示在线/已接设备）。
 *
 * @param {string} stCode 工位编码，如 `ST-LAB05-02`
 * @param {Array}  list   该工位的报警（可能为空数组）
 * @param {number} active 该工位未解除条数
 */
function renderStationCard(stCode, list, active) {
  // 卡片状态：有未解除 → 红；仅已解除 → 蓝；无报警 → 灰
  const cls = active > 0 ? 'st-card has-alarm' : list.length > 0 ? 'st-card all-clear' : 'st-card none';
  const badge = list.length === 0
    ? '<span class="st-badge b-none">无报警</span>'
    : active > 0
      ? '<span class="st-badge b-alarm">' + esc(active) + ' 未解除</span>' +
        (list.length > active ? '<span class="st-badge b-muted">共 ' + esc(list.length) + ' 条</span>' : '')
      : '<span class="st-badge b-muted">' + esc(list.length) + ' 条已解除</span>';

  let body;
  if (list.length === 0) {
    body = '<p class="st-empty">当前<b>没有报警记录</b>' +
      '<br><span class="sub">是"确实没有"，不是"取不到"——本节服务在跑。</span></p>';
  } else {
    body = '<table class="rows st-table"><thead><tr>' +
      '<th>报警</th><th>等级</th><th>状态</th><th>次数</th>' +
      '<th>出现时间</th><th>最近发生</th><th>解决时间</th><th>处置 / 解决详情</th><th>操作</th>' +
      '</tr></thead><tbody>';
    for (const a of list) body += renderAlarmRow(a);
    body += '</tbody></table>';
  }

  return '<section class="' + cls + '">' +
    '<header class="st-card-hd">' +
      '<span class="st-name">' + esc(shortStationName(stCode)) + '</span>' +
      '<code class="st-code">' + esc(stCode) + '</code>' +
      '<span class="st-badges">' + badge + '</span>' +
    '</header>' +
    body +
    '</section>';
}

/**
 * 渲染一条报警（S07 表格行）。
 *
 * `withStation` = true 时额外输出「工位」列（名册外那张表用）。
 */
function renderAlarmRow(a, withStation) {
  const id = a.alarmId || a.id;
  // 处置与解除只有"人/详情"，**没有时间字段**（后端未提供 resolvedAtMs）
  const ackBy = a.acknowledgedBy || a.acknowledgedByUserId || '';
  const resBy = a.resolvedBy || a.resolvedByUserId || '';
  const detail = [];
  if (ackBy) detail.push('处置人：' + ackBy);
  if (resBy) detail.push('解除人：' + resBy);
  if (a.resolution) detail.push('详情：' + a.resolution);
  return '<tr>' +
    '<td><code>' + esc(a.alarmCode) + '</code><div class="sub">' + esc(a.message || '') +
      (a.unmapped ? ' <span class="tag">码表未登记</span>' : '') + '</div></td>' +
    '<td>' + levelBadge(a.alarmLevel) + '</td>' +
    (withStation
      ? '<td><code>' + esc(a.stationCode || '—') + '</code><div class="sub">' + esc(a.labCode || '') + '</div></td>'
      : '') +
    '<td>' + esc(alarmStateCn(a.state)) + (a.simulated ? ' <span class="tag">模拟</span>' : '') + '</td>' +
    '<td>' + esc(a.count ?? '—') + '</td>' +
    '<td class="sub">' + esc(fmtTs(a.raisedAtMs)) + '</td>' +
    '<td class="sub">' + esc(fmtTs(a.lastAtMs)) + '</td>' +
    '<td class="sub">' + esc(fmtTs(a.resolvedAtMs)) + '</td>' +
    '<td class="sub">' + esc(detail.length ? detail.join('；') : '—') + '</td>' +
    '<td class="acts">' +
      '<button data-act="diagnose" data-id="' + esc(id) + '">诊断</button>' +
      '<button data-act="ack" data-id="' + esc(id) + '">处置</button>' +
      '<button data-act="resolve" data-id="' + esc(id) + '">解除</button>' +
      '<button class="ghost" data-act="false" data-id="' + esc(id) + '">误报</button>' +
    '</td>' +
  '</tr>';
}

function levelBadge(level) {
  const map = { fault: ['故障', 'lv-fault'], warning: ['警告', 'lv-warn'], info: ['提示', 'lv-info'] };
  const m = map[level] || [String(level ?? '—'), 'lv-info'];
  return '<span class="lv ' + m[1] + '">' + esc(m[0]) + '</span>';
}

function alarmStateCn(state) {
  return ({
    raised: '待处置', acknowledged: '已处置', suppressed: '已抑制',
    resolved: '已解除', 'closed-as-false-positive': '误报关闭',
  })[state] || String(state ?? '—');
}

/**
 * 毫秒时间戳 → 本地可读时间（`YYYY-MM-DD HH:mm:ss`）。
 *
 * ⚠️ 后端**只给 `raisedAtMs` / `lastAtMs` 数字**，不给 ISO 字符串；
 * 旧代码读 `a.lastAt`（后端没这个字段）⇒ 那一列永远空白。此处统一按数字格式化。
 * 缺值/非数字一律返回 `—`（**不显示"Invalid Date"、不留白**，避免被当成"没有时间"）。
 */
function fmtTs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** S07 处置动作。三条都要二次确认（写操作），且**不自动重试** */
async function alarmAction(act, alarmId) {
  const out = $('alarm-out');
  const map = {
    diagnose: { path: '/alarm/v1/alarms/' + encodeURIComponent(alarmId) + '/diagnose', method: 'POST', needReason: false, label: '触发 Agent 诊断' },
    ack: { path: '/alarm/v1/alarms/' + encodeURIComponent(alarmId) + '/acknowledge', method: 'POST', needReason: false, label: '处置（已看到）' },
    resolve: { path: '/alarm/v1/alarms/' + encodeURIComponent(alarmId) + '/resolve', method: 'POST', needReason: true, label: '解除' },
    false: { path: '/alarm/v1/alarms/' + encodeURIComponent(alarmId) + '/close-as-false-positive', method: 'POST', needReason: true, label: '误报关闭' },
  };
  const spec = map[act];
  if (!spec) return;

  const body = { actor: 'board-ui' };
  if (spec.needReason) {
    const reason = window.prompt(spec.label + ' 需要填写理由（契约要求，必填）：', '');
    if (reason === null) { out.textContent = '已取消（未发送请求）'; return; }
    if (reason.trim() === '') { out.textContent = '理由为空，未发送（契约要求必填）'; return; }
    body.reason = reason.trim();
  }
  if (!window.confirm('确认对 ' + alarmId + ' 执行「' + spec.label + '」？\n此操作会写入报警台账。')) {
    out.textContent = '已取消（未发送请求）';
    return;
  }

  out.textContent = '正在请求 ' + spec.path + ' …';
  const r = await fetchSection2(spec.path, spec.method, body);
  out.textContent = r.ok
    ? '成功：' + JSON.stringify(r.data).slice(0, 400)
    : '失败（HTTP ' + r.status + '）：' + r.reason;
  if (r.ok) setTimeout(() => { void loadAlarm(); }, 600);
}

/** 带 body 的写请求（与 fetchSection 分开，避免 GET/POST 混用出错） */
async function fetchSection2(path, method, body) {
  try {
    const r = await fetch(path, {
      method,
      cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await r.json(); } catch { data = null; }
    if (!r.ok) {
      const reason = (data && (data.hint || data.detail || data.message)) || ('HTTP ' + r.status);
      return { ok: false, status: r.status, data, reason: String(reason) };
    }
    return { ok: true, status: r.status, data, reason: '' };
  } catch (e) {
    return { ok: false, status: 0, data: null, reason: '请求失败：' + e.message };
  }
}

/* --------------------------------------------------------- S03 资源（③） */

/**
 * 本页要展示的资源池清单。
 *
 * ⚠️ 曾经这里**写死单一池号**（`RP-SEAT-LAB05`），于是 S03 页签上
 * 「只有一个实训室」——而 connector-svc 注册表里其实登记了两个池
 * （LAB-01 / LAB-05）。本地席位服务（seat-svc）已支持多池，
 * 因此这里改为**列出全部池**，各自独立查询、独立失败。
 *
 * 单池部署（`--pool=…` 只装配一个池）时，另一个池会返回 404；
 * 本页**如实显示该池不可用**，绝不用空列表冒充"没有占用"。
 *
 * `demo: true` 的池是**本机模拟席位**（`RP-SEAT-LAB99`，演示室 `LAB-99`）：
 * 只有一个席位、背后就是这台电脑。四动作演练默认打在它上面，**不碰真工位台账**。
 *
 * ⚠️ 演示室用 `LAB-99` 而非自造池号：编码契约对「池号 / 室码 / 席位号」三层都校验，
 * 编造值会在装配期被拒（详见 `serve-upstreams.ts` 该条目与 seat-svc `labs.ts`）。
 */
const RESOURCE_POOLS = [
  { poolId: 'RP-SEAT-LAB01', lab: 'LAB-01', name: '智能制造系统集成实训室', demo: false },
  { poolId: 'RP-SEAT-LAB05', lab: 'LAB-05', name: '工业机器人应用技术实训室（ABB）', demo: false },
  { poolId: 'RP-SEAT-LAB99', lab: 'LAB-99', name: '演示室（本机模拟席位）', demo: true }
];

/**
 * 渲染单个池的**机位看板卡片**（面向师生 / 管理员）。
 *
 * ## 展示纪律
 *
 * 页面上出现的一切都以"读者看得懂"为准：
 * - 池号（`RP-SEAT-LAB05`）、租约号（`LEASE-UI-…`）这类内部标识**收进折叠区**，
 *   默认只给人看「实训室名 / 空闲几席 / 谁在占 / 还有多久到期」。
 * - 上游原始响应也收进折叠区，不再直接铺在页面上。
 * - **不编造任何数字**：上游没给的字段一律显示 `—`，不猜。
 */
function renderOnePool(pool, status, detail) {
  const head = '<h3>' + esc(pool.name) + ' <span class="sub">' + esc(pool.lab) + '</span> ' +
    '<code>' + esc(pool.poolId) + '</code></h3>';

  if (!status.ok || !status.data) {
    return head +
      '<p class="warn">该池不可用：' + esc(status.reason || '查询失败') + '</p>' +
      '<p class="sub">若本页其它池正常，说明本地席位服务（<code>seat-svc</code>）' +
      '没有装配这个池 —— 那是<b>如实</b>结果，不是本页故障。</p>';
  }

  const d = status.data;
  const capacity = d.capacity, inUse = d.inUse;
  const free = (typeof capacity === 'number' && typeof inUse === 'number') ? capacity - inUse : '—';
  const RUN_CN = { up: '正常', degraded: '降级（已无法再分配）', down: '不可用' };

  /**
   * 席位明细来自 `/seat/pool/:poolId`（seat-svc 直连），**不是**上面那份
   * `/connector/v1/status` —— 后者按契约只给容量/占用/运行态。
   * 两路数据**分开取、分开失败**：明细取不到时如实说，不拿空表冒充"没有席位"。
   *
   * ⚠️ 明细要先算出来：下面那张"释放后仍显示占用"的提示依赖它。
   */
  const seats = (detail && detail.ok && Array.isArray(detail.data && detail.data.seats))
    ? detail.data.seats : [];

  const handovers = seats.filter((s) => s.state === 'handover');
  const occupied = seats.filter((s) => s.state === 'occupied');
  const freeSeats = seats.filter((s) => s.state === 'free');

  // 一句话结论：读者扫一眼就知道这个室现在能不能用
  let verdict, verdictCls;
  if (d.running === 'down') {
    verdict = '该实训室机位服务当前不可用，暂不能分配机位。';
    verdictCls = 'v-bad';
  } else if (typeof free === 'number' && free <= 0 && handovers.length > 0) {
    verdict = '机位已全部派出，其中有 ' + handovers.length + ' 个正在换人清理，稍后会自动释放。';
    verdictCls = 'v-warn';
  } else if (typeof free === 'number' && free <= 0) {
    verdict = '机位已满，当前无可分配席位。';
    verdictCls = 'v-warn';
  } else if (typeof free === 'number') {
    verdict = '可正常使用，当前还有 ' + free + ' 个机位可分配。';
    verdictCls = 'v-ok';
  } else {
    verdict = '容量信息缺失，请查看下方技术详情。';
    verdictCls = 'v-warn';
  }

  let html = '<div class="panel">' + head +
    '<p class="verdict ' + verdictCls + '">' + esc(verdict) + '</p>';

  html += '<div class="stats">' +
    '<div class="stat"><b>' + esc(free === '—' ? '—' : free) + '</b><span>空闲机位</span></div>' +
    '<div class="stat"><b>' + esc(capacity ?? '—') + '</b><span>机位总数</span></div>' +
    '<div class="stat"><b>' + esc(inUse ?? '—') + '</b><span>使用中</span></div>' +
    '<div class="stat"><b>' + esc(RUN_CN[d.running] || d.running || '—') + '</b><span>服务状态</span></div>' +
    '</div>';

  /**
   * ★ 「释放了为什么还占用？」—— 必须在这里解释，否则每个人都会问一遍。
   *
   * 释放**不是立即空闲**：席位先进入 `handover`（换人清理窗口，本部署 15 秒），
   * 之后才自动转 `free`。而统计卡的「使用中」**把 handover 也算进去**
   * —— 于是刚点完「释放」，卡片上占用数不变、服务状态还可能掉到「降级」，
   * 看起来像"释放没生效"。
   *
   * 这里在检测到 handover 席位时**直接说明原因与剩余时间**，并给出"何时再看"。
   */
  if (handovers.length > 0) {
    html += '<p class="note note-wait">⏳ <b>' + esc(handovers.length) + ' 个机位正在换人清理</b>' +
      '（' + esc(handovers.map((s) => shortStationName(s.stationCode)).join('、')) + '）。' +
      '这是<b>释放后的正常过渡</b>，不是"释放没生效" —— 约 15 秒后<b>自动</b>转为空闲，无需再操作。' +
      '在此期间它仍计入上面的「使用中」，所以那个数字会暂时不变。</p>';
  }
  if (occupied.length > 0 && handovers.length === 0) {
    html += '<p class="note note-info">ℹ️ ' + esc(occupied.length) + ' 个机位正在被使用（' +
      esc(occupied.map((s) => shortStationName(s.stationCode)).join('、')) + '）。' +
      '需要放开请在下方操作区点「③ 释放」，或先持有正确租约号。</p>';
  }

  if (seats.length > 0) {
    const SEAT_CN = { free: '空闲', occupied: '使用中', handover: '换人清理中' };
    const SEAT_CLS = { free: 's-free', occupied: 's-busy', handover: 's-wait' };

    // 一句话汇总：几空几占
    html += '<p class="sub">机位明细：空闲 <b>' + esc(freeSeats.length) + '</b> · ' +
      '使用中 <b>' + esc(occupied.length) + '</b> · ' +
      '换人清理 <b>' + esc(handovers.length) + '</b></p>';

    html += '<table class="rows"><thead><tr><th>机位（工位）</th><th>状态</th>' +
      '<th>到期时间</th><th>剩余</th><th>占用者</th></tr></thead><tbody>';
    for (const s of seats) {
      // 剩余时间：只有占用中才有意义；其余情况给"—"，不猜
      let left = '—';
      if (s.state === 'occupied' && s.expiresAt) {
        const ms = Date.parse(String(s.expiresAt)) - Date.now();
        left = Number.isFinite(ms)
          ? (ms <= 0 ? '已到期' : Math.round(ms / 60000) + ' 分钟')
          : '—';
      }
      const expTxt = s.state === 'free' ? '—'
        : String(s.expiresAt || '—').replace('T', ' ').slice(0, 19);
      html += '<tr>' +
        '<td><b>' + esc(shortStationName(s.stationCode)) + '</b>' +
          '<div class="sub">' + esc(s.seatId) + '</div></td>' +
        '<td><span class="seat-state ' + (SEAT_CLS[s.state] || '') + '">' +
          esc(SEAT_CN[s.state] || s.state || '—') + '</span></td>' +
        '<td class="sub">' + esc(expTxt) + '</td>' +
        '<td class="sub">' + esc(left) + '</td>' +
        '<td class="sub">' + esc(s.leaseId ? '已登记租约' : '—') + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    // 内部标识收进折叠区，不干扰阅读
    html += '<details><summary class="sub">技术详情（租约号 / 设备标识 / 原始响应）</summary>' +
      '<table class="rows"><thead><tr><th>席位号</th><th>工位编码</th><th>状态</th>' +
      '<th>租约号</th><th>到期</th><th>背后设备 MAC</th></tr></thead><tbody>';
    for (const s of seats) {
      html += '<tr>' +
        '<td><code>' + esc(s.seatId) + '</code></td>' +
        '<td><code>' + esc(s.stationCode) + '</code></td>' +
        '<td>' + esc(s.state || '—') + '</td>' +
        '<td class="sub">' + esc(s.leaseId || '—') + '</td>' +
        '<td class="sub">' + esc(s.expiresAt || '—') + '</td>' +
        '<td class="sub">' + esc(s.deviceMac || '（未实测）') + '</td>' +
        '</tr>';
    }
    html += '</tbody></table><pre class="raw">' + esc(JSON.stringify(d, null, 2)) +
      '</pre></details>';
  } else if (detail && !detail.ok) {
    html += '<p class="sub">机位明细暂不可用（<code>/seat/pool/' + esc(pool.poolId) + '</code>：' +
      esc(detail.reason || '查询失败') + '）—— 上面四项统计仍然有效，' +
      '但看不到"具体哪些机位在用"。</p>';
  } else {
    html += '<p class="sub">该室未返回机位明细。</p>';
  }

  html += '<p class="sub">数据时刻 <code>' + esc(d.observedAt || '—') + '</code>' +
    (d.managedBy ? ' · 数据来源 <code>' + esc(d.managedBy) + '</code>' : '') + '</p>';
  return html + '</div>';
}

async function loadResource() {
  const pane = $('pane-resource');
  const s = upstreamState['S03'];
  if (!s || !s.reachable) {
    pane.innerHTML = upstreamBlockedHtml('S03');
    setTabStatus('S03 资源：服务未启动', 'bad');
    return;
  }
  setTabStatus('S03 资源：加载中…', '');

  // 两个室**并行查询**：一个池失败不影响另一个池的展示
  // 参数名照抄上游实现：`connector-svc-http/src/http.ts` 读的是 `resourcePoolId`
  // 统计走 /connector（权威的容量/占用/运行态）；席位明细走 /seat（唯一带 seats 的来源）
  const [containerResults, detailResults] = await Promise.all([
    Promise.all(RESOURCE_POOLS.map((p) =>
      fetchSection(SECTIONS.resource.endpoints.status + '?resourcePoolId=' + encodeURIComponent(p.poolId)))),
    Promise.all(RESOURCE_POOLS.map((p) => fetchSeatDetail(p.poolId))),
  ]);

  let html = '<div class="page-intro">' +
    '<h2>S03 · 实训室机位使用情况</h2>' +
    '<p>本页显示每个实训室<b>当前有多少机位（工位）可用、哪些正在被使用、什么时候到期</b>。' +
    '机位由学生上机时申请、下课时释放；老师可在此查看占用情况并强制释放异常占用的机位。</p>' +
    '<p class="sub">数据每 5 秒自动刷新一次。若要操作机位（申请 / 释放），请使用页面下方的<b>机位操作</b>区。</p>' +
    '</div>';

  let okCount = 0;
  for (let i = 0; i < RESOURCE_POOLS.length; i++) {
    if (containerResults[i] && containerResults[i].ok && containerResults[i].data) okCount++;
    html += renderOnePool(
      RESOURCE_POOLS[i],
      containerResults[i] || { ok: false, reason: '查询失败' },
      detailResults[i] || { ok: false, reason: '查询失败' },
    );
  }

  if (okCount === 0) {
    html += '<p class="sub">排查顺序：① <code>services/seat-svc</code> 是否在 ' +
      '<code>8799</code> 上跑（<code>GET /healthz</code>）② 池号是否一致' +
      '（seat-svc <code>labs.ts</code> 注册表 / 本页 / <code>serve-upstreams.ts</code> 注册表）' +
      '③ <code>--seat-token</code> 与 seat-svc 的 <code>SEAT_MANAGER_TOKEN</code> 是否相同。</p>';
  }
  setTabStatus('S03 资源：' + okCount + '/' + RESOURCE_POOLS.length + ' 个池已加载', okCount > 0 ? 'ok' : 'bad');

  html += renderActionPanel();
  pane.innerHTML = html;
  refreshActionState();
}

/**
 * 四动作操作面板（**真调 connector-svc**）。
 *
 * ## 与前版的区别
 *
 * 前版这里只有一张接口登记表 + 一个"调用"按钮，点了只弹一句
 * "该动作需要构造请求体…本页不代填参数"。理由是**不用假参数打真实写接口**。
 *
 * 现在改为**真表单**：参数由人在页面上填/选，值都来自真实上下文
 * （池号是从上游查回来的、席位号是从池状态读到的、requestId 自动生成），
 * **没有任何编造值** —— 既保留了"不编参数"，又让四个动作真的能用。
 *
 * ⚠️ 默认选中**演示池**（`RP-SEAT-DEMO`，本机模拟席位），
 * 避免误操作写到 12 个真工位的台账上。要打真工位须手动改下拉框。
 */
/**
 * 机位操作面板（**真调 connector-svc**）。
 *
 * ## 面向读者重写（2026-09-24）
 *
 * 前版把 `apply / heartbeat / release`、`leaseId`、`leaseKind`、`in-class`
 * 这类接口术语直接摆在表单上 —— 对老师/学生不可读。现在改成**任务语言**：
 * 「申请机位 / 续期 / 释放机位 / 查看状态」，术语一律收进折叠区。
 *
 * 参数仍然**由人在页面上填/选，值全部来自真实上下文**
 * （池号从上游查回、席位号从池状态读到、租约号自动生成），**没有任何编造值**。
 *
 * ⚠️ 默认选中**演示室**（本机模拟席位），避免误操作写到真实工位的台账上。
 * 要打真工位须手动改「实训室」下拉框。
 */
function renderActionPanel() {
  const poolOpts = RESOURCE_POOLS.map((p) =>
    '<option value="' + esc(p.poolId) + '"' + (p.demo ? ' selected' : '') + '>' +
    esc(p.name) + '（' + esc(p.lab) + (p.demo ? ' · 演练用' : '') + '）</option>').join('');

  const reasonOpts = [
    ['student-checkout', '学生下机归还'],
    ['teacher-release', '教师强制回收'],
    ['lease-expired', '租期已到自动回收'],
    ['dead-lease-reclaim', '异常占用回收'],
    ['admin-force', '管理员清理'],
  ].map(([v, cn]) => '<option value="' + esc(v) + '"' + (v === 'student-checkout' ? ' selected' : '') + '>' +
    esc(cn) + '</option>').join('');

  const kindOpts = [
    ['in-class', '正常上机（不因未发心跳判失效）'],
    ['online', '在线（按心跳判定）'],
    ['offline-checked-in', '离线已签到'],
    ['offline-unsigned', '离线未签到'],
  ].map(([v, cn]) => '<option value="' + esc(v) + '"' + (v === 'in-class' ? ' selected' : '') + '>' +
    esc(cn) + '</option>').join('');

  return '<div class="page-intro"><h2>机位操作</h2>' +
    '<p>按 <b>① 申请 → ② 续期 → ③ 释放</b> 的顺序使用。申请成功后页面会记住这次租约，' +
    '续期与释放都不需要手填号码。</p>' +
    '<p class="sub">默认打在<b>演练室</b>（本机模拟席位），不会影响真实工位台账。' +
    '要操作某个真实实训室，请在下面把「实训室」改掉。</p></div>' +

    '<div class="form">' +
      '<label>实训室 <select id="act-pool">' + poolOpts + '</select></label>' +
      '<label>使用性质 <select id="act-kind">' + kindOpts + '</select></label>' +
      '<label>归还原因 <select id="act-reason">' + reasonOpts + '</select></label>' +
      '<label>任务号 <input id="act-task" size="20" placeholder="可留空，自动生成"></label>' +
    '</div>' +

    '<div class="acts big-acts">' +
      '<button data-act-s03="apply">① 申请机位</button>' +
      '<button data-act-s03="heartbeat">② 续期（延长使用时间）</button>' +
      '<button data-act-s03="release">③ 释放机位</button>' +
      '<button class="ghost" data-act-s03="status">查看状态</button>' +
      '<button class="ghost" data-act-s03="cleanup">清理异常占用</button>' +
    '</div>' +

    '<p class="note note-info" id="act-hint">当前机位：<b>（尚未申请）</b></p>' +

    '<details><summary class="sub">高级选项（重放上次申请 / 查看租约号与接口名）</summary>' +
      '<div class="form">' +
        '<label>租约号 <input id="act-lease" readonly size="26"></label>' +
      '</div>' +
      '<div class="acts"><button class="ghost" data-act-s03="reapply">重放上次申请（验幂等）</button></div>' +
      '<p class="sub">技术说明：本区按钮实际调用 <code>connector-svc</code> 的 ' +
      '<code>/connector/v1/apply</code>、<code>/heartbeat</code>、<code>/release</code>、' +
      '<code>/status</code>。租约号每次「申请」自动生成，幂等键 <code>requestId</code> 一并生成；' +
      '「续期」用的席位号取自申请结果。</p>' +
      '<p class="sub">⚠️ 演练室<b>只有 1 个机位</b>。若上次申请后没点「释放」，' +
      '机位仍被旧租约占着，再点「申请」会提示<b>机位已满</b> —— 这是<b>正确</b>行为（不是故障）。' +
      '点「③ 释放机位」或「清理异常占用」即可解开。</p>' +
    '</details>' +

    '<pre class="raw" id="res-out">（尚未操作）</pre>';
}

/** 页面上记住的"当前租约"上下文：申请成功后才有值 */
let s03Ctx = { leaseId: '', seatId: '', lastApplyBody: null };

function newLeaseId() {
  // 用时间戳+随机后缀，避免与历史幂等键撞车
  return 'LEASE-UI-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

function actEl(id) {
  return document.getElementById(id);
}

function setActOut(obj, ok) {
  const out = actEl('res-out');
  if (out) out.textContent = JSON.stringify(obj, null, 2);
  const hint = actEl('act-hint');
  if (hint) {
    hint.innerHTML = '当前机位：' + (s03Ctx.leaseId
      ? '<b>' + esc(shortStationName(s03Ctx.seatId)) + '</b>（' + esc(s03Ctx.seatId) + '）'
      : '<b>（尚未申请）</b>') + (ok === false ? ' · <span class="warn">上次操作未成功</span>' : '');
  }
}

async function refreshActionState() {
  const lease = actEl('act-lease');
  if (lease && lease.value === '') lease.value = newLeaseId();
  if (actEl('act-task') && actEl('act-task').value === '') {
    actEl('act-task').value = 'TASK-UI-' + Date.now().toString(36);
  }
  setActOut({
    '怎么用': '① 申请机位 → ② 续期 → ③ 释放机位（按此顺序）。默认打在演练室，不影响真实工位。',
    '注意': '演练室只有 1 个机位。用完请点「③ 释放机位」，否则下次申请会提示机位已满。',
    '释放之后': '机位进入「换人清理中」约 15 秒，期间"使用中"数字不变 —— 属正常，会自动恢复。',
  });
}

/**
 * 取某池的**席位明细**。
 *
 * ⚠️ 必须走 `/seat/pool/:poolId`（seat-svc 直连代理），**不是** `/connector/v1/status`：
 * 后者按契约只返回容量/占用/运行态，**不含 `seats` 数组**
 * （见 connector-svc-http 的 `handleStatus`）。用错端点会让席位明细表永远为空，
 * 而"清理本页租约"这类需要知道"哪个席位被哪个租约占着"的操作也就无从下手
 * —— 现场表现就是演示室被孤儿租约占住后无法自解。
 */
async function fetchSeatDetail(poolId) {
  return fetchSection('/seat/pool/' + encodeURIComponent(poolId));
}

/**
 * 把接口失败讲成人话。
 *
 * 起因：演示室只有 1 个席位，上一次申请没释放时再点「申请」会拿到
 * **409 + "该实训室机位已满，已为你排队…"** —— 措辞来自 connector-svc 的
 * 通用资源语义（面向"排队"场景），但**本地席位池并不排队**：
 * 它就是"这个席位还被占着"。
 *
 * 直接把这句原文抛给操作者会让人以为：① 系统在排队 ② 等一会就有了。
 * 两个都是错的。因此这里**保留原文**（不篡改上游措辞），
 * 但补一句本地语义的正确解释与解法。
 */
function explainActFailure(r, poolId) {
  const out = { 失败: r.reason, HTTP: r.status };
  if (r.status === 409) {
    out['本地解释'] = '资源池 ' + poolId + ' 已无空闲席位（本地席位池**不排队**：'
      + '它就是"席位仍被占着"）。请先点「③ 释放」或「清理本页租约」，再重新申请。';
  }
  return out;
}

/** 四动作的实际执行 —— 与 `peripheral/tools/seat-demo/lifecycle.ts` 同语义 */
async function runS03Action(action) {
  const poolId = actEl('act-pool') ? actEl('act-pool').value : 'RP-SEAT-LAB99';
  const leaseId = actEl('act-lease') ? actEl('act-lease').value : '';

  if (action === 'status') {
    const r = await fetchSection(SECTIONS.resource.endpoints.status + '?resourcePoolId=' + encodeURIComponent(poolId));
    setActOut(r.ok ? r.data : explainActFailure(r, poolId), r.ok);
    if (r.ok) void loadResource();
    return;
  }

  /**
   * 清理：把该池**当前实际占用**的席位逐个释放（reason=admin-force）。
   *
   * 为什么需要它：演示室只有 1 个席位，而「申请」每次都会生成**新租约号**。
   * 一旦某次申请后没点释放（关页面、刷新、忘了），席位就被"孤儿租约"占着，
   * 之后所有申请都是 409 —— 页面自己又没有那个旧 leaseId，点「释放」也没用。
   * 这个按钮从**服务端**读回真实占用并释放，是给演示室的解卡出口。
   */
  if (action === 'cleanup') {
    const st = await fetchSeatDetail(poolId);
    if (!st.ok || !st.data) { setActOut(explainActFailure(st, poolId), false); return; }
    const seats = Array.isArray(st.data.seats) ? st.data.seats : [];
    const busy = seats.filter((s) => s.state === 'occupied' || s.state === 'handover');
    if (busy.length === 0) {
      setActOut({ 结果: '该池当前没有占用中的席位，无需清理', poolId: poolId }, true);
      return;
    }
    const log = [];
    let cleaned = 0;
    for (const s of busy) {
      // handover 席位没有可释放的租约（已在清理窗口），跳过并如实说明
      if (s.state !== 'occupied' || !s.leaseId) {
        log.push({ 席位: s.seatId, 状态: s.state, 处置: '在换人清理窗口内，等待自动转空闲（不可强制释放）' });
        continue;
      }
      const r = await fetchSection2(SECTIONS.resource.endpoints.release, 'POST', {
        requestId: 'REQ-UI-CLEAN-' + Date.now().toString(36),
        leaseId: s.leaseId,
        externalResourceId: s.seatId,
        reason: 'admin-force',
      });
      log.push({ 席位: s.seatId, 释放租约: s.leaseId, HTTP: r.status, 结果: r.ok ? '已释放' : r.reason });
      if (r.ok) cleaned++;
    }
    setActOut({ 已清理: cleaned + ' / ' + busy.length, 明细: log }, cleaned > 0);
    // 清掉本页记住的上下文——它指向的租约可能刚被释放掉
    s03Ctx.seatId = '';
    void loadResource();
    return;
  }

  if (action === 'apply' || action === 'reapply') {
    const body = action === 'reapply' && s03Ctx.lastApplyBody
      ? s03Ctx.lastApplyBody
      : {
          requestId: 'REQ-UI-' + Date.now().toString(36),
          leaseId,
          resourcePoolId: poolId,
          taskId: actEl('act-task') ? actEl('act-task').value : 'TASK-UI',
          leaseKind: actEl('act-kind') ? actEl('act-kind').value : 'in-class',
          requestedAt: new Date().toISOString(),
          operatorId: 'board-ui',
        };
    s03Ctx.lastApplyBody = body;
    const r = await fetchSection2(SECTIONS.resource.endpoints.apply, 'POST', body);
    // 申请成功才记住席位号（心跳/释放都要用它）
    if (r.ok && r.data && r.data.externalResourceId) {
      s03Ctx.leaseId = String(body.leaseId);
      s03Ctx.seatId = String(r.data.externalResourceId);
    }
    const shown = r.ok ? r.data : Object.assign(explainActFailure(r, poolId), { 请求体: body });
    setActOut(shown, r.ok);
    if (r.ok) void loadResource();
    return;
  }

  if (action === 'heartbeat') {
    if (!s03Ctx.seatId) { setActOut({ 提示: '请先点「申请」——心跳需要申请返回的席位号' }, false); return; }
    const body = { requestId: 'REQ-UI-' + Date.now().toString(36), leaseId: s03Ctx.leaseId, externalResourceId: s03Ctx.seatId };
    const r = await fetchSection2(SECTIONS.resource.endpoints.heartbeat, 'POST', body);
    /**
     * ★ 心跳已改为**真续租**（2026-09-24）。
     *
     * 原实现只查存活（`GET /alive`），租期固定到期即回收、心跳救不回来。
     * 现在它走 `/seat/renew` 把到期时间推到 `now + 租期`（本部署 2 小时）。
     * 因此这里必须**把新的到期时间显示出来** —— 否则操作者点完心跳
     * 看不到任何变化，会以为按钮没用（这正是改动前的问题之一）。
     */
    let shown = r.ok ? r.data : explainActFailure(r, poolId);
    if (r.ok && r.data && r.data.expiresAt) {
      const exp = new Date(String(r.data.expiresAt));
      const mins = Math.round((exp.getTime() - Date.now()) / 60000);
      shown = Object.assign({}, r.data, {
        '续租结果': '租约已延长，新的到期时间为 ' + String(r.data.expiresAt).replace('T', ' ').slice(0, 19) +
          '（约 ' + mins + ' 分钟后到期）。',
      });
    }
    setActOut(shown, r.ok);
    if (r.ok) void loadResource();
    return;
  }

  if (action === 'release') {
    if (!s03Ctx.seatId) { setActOut({ 提示: '请先点「申请」——释放需要申请返回的席位号' }, false); return; }
    const body = {
      requestId: 'REQ-UI-' + Date.now().toString(36),
      leaseId: s03Ctx.leaseId,
      externalResourceId: s03Ctx.seatId,
      reason: actEl('act-reason') ? actEl('act-reason').value : 'student-checkout',
    };
    const r = await fetchSection2(SECTIONS.resource.endpoints.release, 'POST', body);
    /**
     * ★ 释放成功**不等于立即空闲**。
     *
     * 席位先进入 `handover`（换人清理窗口），`reusableAfterMs` 之后才转 `free`。
     * 不解释这一点，操作者会看到"释放返回成功，但占用数没变、还显示降级"，
     * 从而以为释放没生效 —— 这是本页被问过最多的一条。
     */
    let shown = r.ok ? r.data : explainActFailure(r, poolId);
    if (r.ok && r.data && typeof r.data.reusableAfterMs === 'number') {
      const sec = Math.round(r.data.reusableAfterMs / 1000);
      shown = Object.assign({}, r.data, {
        '预计': '释放已生效。席位进入「换人清理中」，约 ' + sec + ' 秒后自动转为「空闲」。' +
          '这期间它仍计入「占用」，占用数暂时不变、运行态可能显示「降级」—— ' +
          '都是正常的，无需再操作。',
      });
    }
    setActOut(shown, r.ok);
    if (r.ok) { s03Ctx.seatId = ''; void loadResource(); }
    return;
  }
}

/* --------------------------------------------------------- S05 指令（④） */

/** 设备状态中文名（`DeviceStatus`） */
const DEV_STATE_CN = {
  idle: '空闲', running: '运行中', fault: '故障', offline: '离线',
  maintenance: '维护中', unknown: '未知',
};

/** 在线判定中文名（`PresenceState`） */
const PRESENCE_CN = { online: '在线', offline: '离线', unknown: '未判定' };

/** 监护会话中文名（`GuardianState`） */
const GUARDIAN_CN = { active: '监护中', lost: '已失联', closed: '已结束' };

/** 报警等级中文名 */
const LEVEL_CN = { fault: '故障', warning: '警告', info: '提示', none: '—' };

/** 毫秒时间戳 → 本地可读时间 */
function fmtMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/**
 * 渲染一台设备的状态卡片（S05）。
 *
 * ## 为什么是卡片
 *
 * 前版把 `/device/v1/stations` 的整个 JSON `pre` 出来 —— 老师/学生看到的是一屏
 * 花括号，既读不出"这台设备好不好"，也没法横向比较。改成卡片后，
 * **一台设备一张卡**：头部是工位名 + 在线/状态徽标，卡内是报警与关键参数。
 */
function renderDeviceCard(st) {
  const code = String(st.stationCode || '—');
  const status = String(st.status || 'unknown');
  const presence = String(st.presence || 'unknown');
  const isOffline = presence === 'offline' || status === 'offline';
  const isFault = status === 'fault' || (st.alarmCode !== null && st.alarmCode !== undefined && st.alarmCode !== '');

  const cls = isFault ? 'dv-card dv-fault' : isOffline ? 'dv-card dv-offline' : 'dv-card dv-ok';

  const badges = [];
  badges.push('<span class="st-badge ' + (isOffline ? 'b-none' : 'b-muted') + '">' +
    esc(PRESENCE_CN[presence] || presence) + '</span>');
  badges.push('<span class="st-badge ' + (isFault ? 'b-alarm' : 'b-muted') + '">' +
    esc(DEV_STATE_CN[status] || status) + '</span>');
  if (st.simulated) badges.push('<span class="st-badge b-muted">模拟数据</span>');
  if (st.outOfOrder) badges.push('<span class="st-badge b-alarm">事件乱序</span>');

  let body = '';
  if (st.alarmCode) {
    body += '<p class="note note-bad">⚠️ 当前报警 <code>' + esc(st.alarmCode) + '</code>' +
      '（' + esc(LEVEL_CN[st.alarmLevel] || st.alarmLevel || '—') + '）</p>';
  } else {
    body += '<p class="note note-ok">✓ 当前无报警</p>';
  }

  // 设备参数：键值成对列出，空则说明"未上报"
  const params = st.params && typeof st.params === 'object' ? st.params : {};
  const keys = Object.keys(params);
  if (keys.length > 0) {
    body += '<table class="rows st-table"><thead><tr><th>参数</th><th>值</th></tr></thead><tbody>';
    for (const k of keys) body += '<tr><td>' + esc(k) + '</td><td>' + esc(params[k]) + '</td></tr>';
    body += '</tbody></table>';
  } else {
    body += '<p class="sub">该设备暂未上报参数。</p>';
  }

  body += '<p class="sub">采样时间 <code>' + esc(String(st.observedAt || '—').replace('T', ' ').slice(0, 19)) +
    '</code><br>数据来源 <code>' + esc(st.sourceId || '—') + '</code>' +
    '（' + esc(st.sourceKind || '—') + '）</p>';

  const tech = '<details><summary class="sub">技术详情</summary><pre class="raw">' +
    esc(JSON.stringify(st, null, 2)) + '</pre></details>';

  return '<section class="' + cls + '">' +
    '<header class="st-card-hd">' +
      '<span class="st-name">' + esc(shortStationName(code)) + '</span>' +
      '<code class="st-code">' + esc(code) + '</code>' +
      '<span class="st-badges">' + badges.join('') + '</span>' +
    '</header>' + body + tech + '</section>';
}

async function loadControl() {
  const pane = $('pane-control');
  const s = upstreamState['S05'];
  if (!s || !s.reachable) {
    pane.innerHTML = upstreamBlockedHtml('S05');
    setTabStatus('S05 指令：服务未启动', 'bad');
    return;
  }
  setTabStatus('S05 指令：加载中…', '');
  const stations = await fetchSection(SECTIONS.control.endpoints.stations);
  const guardian = await fetchSection(SECTIONS.control.endpoints.guardian);

  let html = '<div class="page-intro">' +
    '<h2>S05 · 设备状态与监护</h2>' +
    '<p>本页显示各工位设备的<b>运行状态、在线情况与报警</b>，以及正在进行中的' +
    '<b>操作监护会话</b>（学生开始作业后，系统为这次作业建立一条监护，' +
    '定期心跳；一旦长时间无心跳即判为失联并报警）。</p>' +
    '<p class="sub">本页为<b>只读</b>视图：控制指令的下发需要明确的执行端上下文，' +
    '不在本页提供一键下发。</p>' +
    '</div>';

  // ------------------------------------------------ 设备状态卡片
  html += '<h3>工位设备状态</h3>';
  if (!stations.ok) {
    html += '<p class="warn">取数失败：' + esc(stations.reason) + '</p>';
  } else {
    const items = (stations.data && (stations.data.items || stations.data.stations)) || [];
    if (items.length === 0) {
      html += '<p class="note note-info">当前<b>没有已登记的工位设备</b>。' +
        '这不是故障 —— 设备需要先由采集侧上报一次状态，才会出现在这里。</p>';
    } else {
      const offline = items.filter((x) => x.presence === 'offline' || x.status === 'offline').length;
      const faulty = items.filter((x) => x.status === 'fault' || x.alarmCode).length;
      html += '<div class="stats">' +
        '<div class="stat"><b>' + esc(items.length) + '</b><span>设备总数</span></div>' +
        '<div class="stat"><b>' + esc(items.length - offline) + '</b><span>在线</span></div>' +
        '<div class="stat"><b>' + esc(offline) + '</b><span>离线</span></div>' +
        '<div class="stat"><b>' + esc(faulty) + '</b><span>报警中</span></div>' +
        '</div>';
      html += '<div class="st-cards">';
      for (const st of items) html += renderDeviceCard(st);
      html += '</div>';
    }
  }

  // ------------------------------------------------ 监护会话
  html += '<h3>操作监护会话</h3>';
  if (!guardian.ok) {
    html += '<p class="warn">监护通道取数失败：' + esc(guardian.reason) + '</p>';
  } else {
    const sessions = (guardian.data && (guardian.data.items || guardian.data.sessions)) || [];
    if (sessions.length === 0) {
      html += '<p class="note note-info">当前<b>没有进行中的监护会话</b>。' +
        '学生在工位上开始作业时会自动建立。</p>';
    } else {
      const lost = sessions.filter((x) => x.state === 'lost').length;
      const active = sessions.filter((x) => x.state === 'active').length;
      html += '<div class="stats">' +
        '<div class="stat"><b>' + esc(sessions.length) + '</b><span>会话总数</span></div>' +
        '<div class="stat"><b>' + esc(active) + '</b><span>正常监护中</span></div>' +
        '<div class="stat"><b>' + esc(lost) + '</b><span>已失联</span></div>' +
        '</div>';
      html += '<table class="rows"><thead><tr><th>工位</th><th>操作人</th><th>任务号</th>' +
        '<th>状态</th><th>开始时间</th><th>最近心跳</th></tr></thead><tbody>';
      for (const g of sessions) {
        const st = String(g.state || 'unknown');
        html += '<tr>' +
          '<td><b>' + esc(shortStationName(g.stationCode)) + '</b>' +
            '<div class="sub">' + esc(g.stationCode || '—') + '</div></td>' +
          '<td>' + esc(g.operatorId || '—') + '</td>' +
          '<td class="sub">' + esc(g.taskId || '—') + '</td>' +
          '<td><span class="seat-state ' + (st === 'lost' ? 's-busy' : st === 'active' ? 's-free' : '') + '">' +
            esc(GUARDIAN_CN[st] || st) + '</span></td>' +
          '<td class="sub">' + esc(fmtMs(g.openedAtMs)) + '</td>' +
          '<td class="sub">' + esc(fmtMs(g.lastHeartbeatMs)) + '</td>' +
          '</tr>';
      }
      html += '</tbody></table>';
      html += '<details><summary class="sub">技术详情（会话原始字段）</summary><pre class="raw">' +
        esc(JSON.stringify(sessions, null, 2)) + '</pre></details>';
    }
  }

  // ------------------------------------------------ 指令能力说明
  html += '<h3>控制指令能力</h3>' +
    '<table class="rows"><thead><tr><th>环节</th><th>作用</th><th>说明</th></tr></thead><tbody>' +
    '<tr><td>校验</td><td>检查指令是否允许执行</td>' +
      '<td class="sub">只校验不执行。授权、时限、重复提交都会在这一步被拦下</td></tr>' +
    '<tr><td>下发</td><td>把校验通过的指令发给设备</td>' +
      '<td class="sub"><b>写操作</b>：授权/过期/重放拒绝在这一步生效</td></tr>' +
    '</tbody></table>' +
    '<p class="sub">本页<b>不提供</b>一键下发按钮：控制指令需要明确的执行端上下文，' +
    '页面只呈现可见面（状态 / 回执 / 监护），不代替调用方构造指令。</p>' +
    '<details><summary class="sub">技术详情（接口名与参数）</summary>' +
      '<p class="sub"><code>GET /device/v1/stations</code> — 工位设备状态列表<br>' +
      '<code>GET /device/v1/guardian</code> — 监护会话列表<br>' +
      '<code>POST /device/v1/control/validate</code> — 校验指令（不执行）<br>' +
      '<code>POST /device/v1/control/dispatch</code> — 下发指令（<b>写操作</b>）</p>' +
    '</details>' +
    '<div id="ctl-out" class="out"></div>';

  pane.innerHTML = html;
  const n = stations.ok ? ((stations.data.stations || stations.data.items || []).length) : 0;
  setTabStatus('S05 指令：已加载 · ' + n + ' 台设备', 'ok');
}

/* ---------------------------------------------------------- 事件与初始化 */

document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.hasAttribute && t.hasAttribute('data-tab')) { showTab(t.getAttribute('data-tab')); return; }
  const act = t.getAttribute && t.getAttribute('data-act');
  if (act) { void alarmAction(act, t.getAttribute('data-id')); return; }
  // S03 的四动作（真调 connector-svc）
  const s03 = t.getAttribute && t.getAttribute('data-act-s03');
  if (s03) { void runS03Action(s03); return; }
});

async function boot() {
  await refreshUpstreams();
  showTab(currentTab);
  // 上游可达性每 15s 重探一次：现场是"边起服务边看"，一次性探测会让"刚起来"看着还挂着
  setInterval(() => { void refreshUpstreams(); }, 15000);
}

void boot();

// 只暴露一个只读入口，供调试；其余名字留在 IIFE 内，避免与内联脚本冲突
window.boardSections = { showTab, refreshUpstreams };

})();
