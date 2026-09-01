// ============================================================
//  自研轻量 EAP/MES — M3 最小闭环（阶段0 拆分后：MES 主进程）
//  职责：REST API + WS 事件流(唯一源) + SECS/GEM(:5000) + WIP/SPC/FDC/VM/PdM
//  启动：node server.js  (默认端口 8124)
//  静态孪生页已移交 portal.js (:8123)
//  存储/拓扑/事件总线/WIP 经 storage / config / services 模块注入（§5/§6）
// ============================================================
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { WIPEngine, PRODUCTS, buildRoute } = require('./core');
const { SecsGemGateway } = require('./secs-gem');
const { E10Tracker } = require('./e10');
const { ChamberModel, PROFILES } = require('./chambers');   // 仿真引擎 · 腔室级状态模型（逐腔室真遥测）
const { PdMEngine } = require('./pdm');
const { VMPredictor } = require('./vm');
const { SPC } = require('./spc');
const { APSEngine } = require('./aps');
const storage = require('./storage');                       // §5 存储抽象单例
const { createEventBus } = require('./services/eventbus');  // §6 事件总线
const { LINES, MODULE_LINE } = require('./config/topo');    // §4.4 拓扑单源
const { initAudit } = require('./audit');                   // §L4 合规审计层
const { createWIP, loadAndHydrate } = require('./services/wip');            // §6 WIP 服务
const { createGovernor } = require('./governance');                       // 资源治理层：锁死 CPU/内存/队列上限
const gov = createGovernor();
const { isAutomationEnabled, setAutomationEnabled, onAutomationChange } = require('./automation-flag');  // 演示系统"自动化总开关"：默认关、每次重启强制关
const telemetry = require('./telemetry-config');   // 采集频率配置：默认低频、客户可改、重启不丢
telemetry.loadFromDb();

const PORT = process.env.PORT || 8124;
const TICK_MS = +(process.env.TICK_MS || 1000);                // 仿真 tick 周期（默认 1s；可配；前端 SimulatedEAP rate 建议同步）
const AUTO_WO_MS = +(process.env.AUTO_WO_MS || 8000);          // M2 自动投料：每 8s 一个工单（可配）
const FLUSH_MS = +(process.env.EVT_FLUSH_MS || 800);           // 事件批量落库周期（可配）
const HEARTBEAT_MS = +(process.env.HEARTBEAT_MS || 1000);      // 事件循环心跳诊断周期（可配）
const IDLE_MS = +(process.env.GOV_IDLE_MS || 180000);          // 空闲降频阈值：无用户操作超此值即降频/暂停（默认 3 分钟，可配）
const TICK_IDLE_MS = +(process.env.GOV_TICK_IDLE_MS || 60000); // tick 空闲放慢阈值（默认 1 分钟，可配）

// ---------- LDA 有机衔接（上游设计 → 下游制造）常驻看门狗配置 ----------
const LDA_BASE = process.env.LDA_BASE || 'http://127.0.0.1:3006';   // 同机 LDA（lda.weomnitech.com.cn）
const LDA_WATCHER = process.env.LDA_WATCHER !== '0';                 // 默认开启：设计交付自动触发 NPI
const LDA_WATCH_MS = +(process.env.LDA_WATCH_MS || 20000);          // 轮询周期
const LDA_WATCH_BURST = Math.max(1, +(process.env.LDA_WATCH_BURST || 5)); // 单轮最大自动导入数

// ---------- LDA 有机衔接：可复用导入函数（手动端点 + 常驻看门狗共用） ----------
// 战略：LDA 是设计上游（光子/量子芯片设计软件），fab-mes 是制造下游（NPI 流片）。
// 衔接的"有机接缝" = LDA 统一设计包 DesignPackage；唯一放行门 = verification.passed（死标量比对，LLM 不进判决路径）。
async function resolveLdaShelf(shelfId) {
  const listResp = await fetch(LDA_BASE + '/api/shelf');
  const list = await listResp.json().catch(() => ({}));
  const shelf = (list.rows || []).find(r => r.id === shelfId) || null;
  if (!shelf) return null;
  let pres = {}; try { pres = await (await fetch(LDA_BASE + '/api/shelf/' + encodeURIComponent(shelfId) + '/package')).json(); } catch (_) {}
  return {
    package_id: shelf.id,
    domain: shelf.domain || 'photon',
    title: shelf.title,
    kind: shelf.system_type || 'mixed_system',
    ir: { n_components: (shelf.composition || []).length, n_nets: 0 },
    design: { targets: shelf.default_req || {}, params: {} },
    verification: { passed: !!pres.ready || (pres.package_tier || '').includes('design_ready') || shelf.honest_tier === '设计就绪', verdict: pres.package_tier || 'shelf-validated' },
    honest_notes: 'Imported from LDA shelf ' + shelf.id + ' via fab-mes organic bridge.'
  };
}

async function importLdaPackage(pkg, opts = {}) {
  if (!pkg || !pkg.package_id) throw new Error('missing package_id');
  const domain = (pkg.domain === 'quantum' || pkg.domain === 'hybrid') ? pkg.domain : 'photon';
  const passed = !!(pkg.verification && pkg.verification.passed === true);
  if (!passed) { const e = new Error('LDA 设计未通过验证 (verification.passed=false)，不进入流片'); e.code = 422; throw e; }
  const id = String(pkg.package_id).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 40);
  const maskId = id + '-MSK-' + Date.now().toString(36);
  let design = storage.getDesign(id);
  if (!design) design = storage.insertDesign({ id, customer_id: 'LDA', name: pkg.title || id, gds_ref: (pkg.artifacts && pkg.artifacts.gds) || null, pdk: 'LDA-v0.1', product: domain === 'quantum' ? 'A16' : 'N2', mask_id: maskId, status: 'DESIGN' });
  else storage.updateDesign(id, { mask_id: maskId, status: 'DESIGN', product: design.product || (domain === 'quantum' ? 'A16' : 'N2') });
  const layers = Math.max(7, Math.min(70, Math.round(((pkg.ir && pkg.ir.n_components) || 4) * 3 + 4)));
  const mask = storage.insertMask({ id: maskId, design_id: id, layers, status: 'READY' });
  const product = design.product || (domain === 'quantum' ? 'A16' : 'N2');
  const passes = Math.max(1, Math.round(layers / 7));
  const type = opts.type || 'tapeout';
  const wo = engine.createWO({ product, qty: Math.max(1, Math.min(20, opts.qty || 1)), dueHours: opts.dueHours || 120, designId: id, maskId, productType: type, passes, qualification: type !== 'volume' });
  log(`NPI[LDA] 导入设计 ${id} (${product}) · 光罩 ${maskId} ${layers}层/${passes}重入 · 投放 ${type} 批 ${wo.id}`);
  return { design, mask, wo, id, product, type, domain, layers, passes };
}

// ---------- LDA 常驻看门狗：定时轮询 LDA，设计交付（package.ready）即自动触发 NPI 投放 ----------
const ldaImported = new Set();
let ldaLastSync = null, ldaLastError = null, ldaImportCount = 0;

// ---- LDA 看门狗改造：增量 + 缓存 + 退避（护栏④）----
//  - 货架列表走 gov.fetch（指数退避，断连不刷堆栈），并加短 TTL 缓存，避免每轮全量重拉
//  - 仅对"候选（未导入 + 未标记）"货架才拉包，非全量逐拉
//  - 空闲态拉长轮询到 60s
const ldaCache = { list: null, ts: 0, ttl: +(process.env.LDA_CACHE_TTL_MS || 10000) };
async function ldaGetShelfList() {
  const now = Date.now();
  if (ldaCache.list && now - ldaCache.ts < ldaCache.ttl) return ldaCache.list;
  const r = await gov.fetch(LDA_BASE + '/api/shelf', { timeoutMs: 5000 });
  if (!r) return ldaCache.list || [];           // 失败用旧缓存，避免重试风暴
  const list = (await r.json().catch(() => ({ rows: [] }))).rows || [];
  ldaCache.list = list; ldaCache.ts = now;
  return list;
}
async function ldaGetPackage(id) {
  const r = await gov.fetch(LDA_BASE + '/api/shelf/' + encodeURIComponent(id) + '/package', { timeoutMs: 5000 });
  if (!r) return null;
  return r.json().catch(() => null);
}

async function ldaSyncOnce({ force = false, burst = LDA_WATCH_BURST } = {}) {
  // 首启（内存集合与 DB 均空）且非强制：把当前已就绪货架种子化，仅未来"新交付"触发自动 NPI（避免一次性灌入）
  if (!force && ldaImported.size === 0 && storage.listLdaImported().length === 0) {
    try {
      const list = await ldaGetShelfList();
      for (const s of list) {
        const pres = await ldaGetPackage(s.id);
        if (pres && pres.ready === true) ldaImported.add(String(s.id));
      }
      log(`[LDA看门狗] 首启种子化 ${ldaImported.size} 个已就绪货架（仅未来新交付触发自动 NPI）`);
    } catch (e) { ldaLastError = e.message; }   // gov.fetch 已吞掉断连/超时，此处仅记短消息
    return { seeded: ldaImported.size };
  }
  const cap = force ? 1000 : burst;
  let imported = 0;
  try {
    const list = await ldaGetShelfList();           // 带缓存 + 退避，单次响应体小
    for (const s of list) {
      if (imported >= cap) break;
      const id = String(s.id).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 40);  // 与 importLdaPackage 落库 id 完全一致
      if (storage.isLdaImported(id)) continue;          // DB 已落库：永不重复（幂等）
      if (!force && ldaImported.has(id)) continue;        // 非强制且内存已知：跳过
      const pres = await ldaGetPackage(id);          // 仅候选货架才拉包（增量：非全量逐拉）
      if (!pres || pres.ready !== true) continue;          // 放行门：仅"设计交付(ready)"触发
      try {
        const pkg = await resolveLdaShelf(s.id);
        if (!pkg) continue;
        const r = await importLdaPackage(pkg, { type: 'tapeout' });
        storage.markLdaImported({ id: r.id, domain: r.domain, wo_id: r.wo.id, lot_id: r.wo.lots[0] && r.wo.lots[0].id });
        ldaImported.add(r.id); ldaImportCount++;
        emitEv({ type: 'npi.lda.auto', design: r.id, product: r.product, wo: r.wo.id, lot: r.wo.lots[0] && r.wo.lots[0].id, domain: r.domain, layers: r.layers, passes: r.passes, ts: Date.now() });
        log(`[LDA看门狗] 自动触发 NPI：${r.id} → ${r.wo.id}`);
        imported++;
      } catch (e) { log(`[LDA看门狗] 导入 ${id} 失败：${e.message}`); }
    }
    ldaLastSync = new Date().toISOString();
    ldaLastError = null;
  } catch (e) { ldaLastError = e.message; }   // 断连/超时已被 gov.fetch 捕获，不会刷堆栈
  return { imported, total: ldaImportCount };
}

function startLdaWatcher() {
  if (ldaImported.size === 0) { try { for (const r of storage.listLdaImported()) ldaImported.add(r.id); } catch (_) {} }  // 启动加载（跨重启幂等）
  if (!LDA_WATCHER) { log('[LDA看门狗] 已禁用 (LDA_WATCHER=0)'); return; }
  // 受"自动化总开关"管制：关闭时仅保留低频保活探测、不导入（避免无人值守时空转造数据）
  if (isAutomationEnabled()) ldaSyncOnce({ force: false }).catch(e => { ldaLastError = e.message; });   // 首轮（可能种子化）
  // 轮询周期客户可配（主数据台→采集频率）；空闲态拉长到 60s；退避由 gov.fetch 保证
  function scheduleLdaWatch() {
    // 自动化关：完全静默——5 分钟才醒一次做空转检查（不导入、不请求 LDA），开闸后立即恢复轮询
    if (!isAutomationEnabled()) { setTimeout(scheduleLdaWatch, 300000); return; }
    const iv = gov.isIdle(IDLE_MS) ? Math.max(telemetry.get('ldaMs'), 60000) : telemetry.get('ldaMs');
    setTimeout(() => { ldaSyncOnce({ force: false }).catch(e => { ldaLastError = e.message; }); scheduleLdaWatch(); }, iv);
  }
  scheduleLdaWatch();
  // 开闸立即恢复 LDA 同步（不等下一轮轮询）；关闸由 scheduleLdaWatch 自动降为 5 分钟静默
  onAutomationChange((on) => { if (on && LDA_WATCHER) { try { ldaSyncOnce({ force: false }); } catch (e) { ldaLastError = e.message; } } });
  log(`[LDA看门狗] 已启动(受自动化总开关管制：关=5分钟保活探测/不导入；开=${telemetry.get('ldaMs') / 1000}s轮询)：${LDA_BASE}，单轮突发上限 ${LDA_WATCH_BURST}`);
}

// ---------- 设备模型（与数字孪生前端完全同构） ----------
const MODULES = [
  { key: 'LITHO', name: '光刻 Litho (EUV/ArF)', count: 14 },
  { key: 'ETCH',  name: '刻蚀 Etch',            count: 42 },
  { key: 'DEP',   name: '薄膜沉积 Dep',         count: 54 },
  { key: 'CMP',   name: 'CMP',                  count: 26 },
  { key: 'IMPL',  name: '离子注入 Implant',     count: 22 },
  { key: 'METRO', name: '量测/检测 Metrology',  count: 34 },
];
const STATUS = { RUN: 'RUN', IDLE: 'IDLE', PM: 'PM', DOWN: 'DOWN' };

const rnd = (a, b) => Math.random() * (b - a) + a;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function pickStatus() { const r = Math.random(); if (r < 0.70) return STATUS.IDLE; if (r < 0.90) return STATUS.PM; return STATUS.DOWN; }
// M2 语义：RUN 由派工引擎控制（lot 加工中）；随机扰动只在 IDLE/PM/DOWN 间漂移
function transition(s) {
  const table = {
    IDLE: ['IDLE', 'PM', 'DOWN'],
    PM:   ['PM', 'IDLE'],
    DOWN: ['DOWN', 'PM', 'IDLE'],
  };
  const opts = table[s] || ['IDLE'];
  return opts[Math.floor(Math.random() * opts.length)];
}

// 生成 192 台设备，id 与前端全局序号连续一致（LITHO-001 … METRO-192）
const tools = [];
let uid = 0;
MODULES.forEach(mod => {
  for (let i = 0; i < mod.count; i++) {
    uid++;
    tools.push({
      id: `${mod.key}-${String(uid).padStart(3, '0')}`,
      module: mod.key, modName: mod.name,
      status: pickStatus(),
      wph: Math.round(rnd(20, 180)),
      util: Math.round(rnd(45, 98)),
      chambers: Math.round(rnd(1, 6)),
      wafers: Math.round(rnd(2000, 60000)),
      recipe: `R${Math.round(rnd(100, 999))}`,
    });
  }
});
const byId = new Map(tools.map(t => [t.id, t]));
// 腔室级状态模型：每台设备按其腔室数实例化腔室遥测（仿真引擎逐腔室真遥测地基）
const chambers = new Map();
tools.forEach(t => chambers.set(t.id, new ChamberModel(t)));

// ---------- 产线/工段拓扑模型（数字孪生"产线级/工厂级"数据地基） ----------
// 拓扑来自 config/topo.js 单一配置源（C5/C6），MES 与 APS 共用。
for (const t of tools) {
  const loc = MODULE_LINE[t.module] || { line: 'FAB-L3', bay: 'BAY-5' };
  t.line = loc.line; t.bay = loc.bay;
}
const lineOf = id => (byId.get(id) || {}).line || 'FAB-L3';

// ---------- 事件总线（WS + SQLite 双写，引擎事件共用；§6.3） ----------
const { wss, broadcast, emitEv: _emitEvRaw, onEmit } = createEventBus({ storage });
let emitEv = _emitEvRaw;

// ---------- ERP 集成（并入 MES 底座；services/erp-service） ----------
// demo/独立：standalone 进程仍运行（bin/start 默认）；in-proc：经 eventbus 订阅
let erpSvc = null;
if (process.env.ERP_INPROC === '1') {
  const { createErpService } = require('./services/erp-service');
  const ERP_HTTP = process.env.MES_HTTP || 'http://127.0.0.1:8124';
  erpSvc = createErpService({ inProc: true, mesHttp: ERP_HTTP });
  onEmit(ev => erpSvc.handleMesEvent(ev));   // 统一经 MES 事件总线，消除自建 WS
  erpSvc.refreshWoCaches();
  console.log('[MES] ERP 已 in-proc 并入 MES 底座（事件总线订阅生效）');
}

// ---------- L4 能力装配（消除"空壳未接线"；全部默认安全零影响） ----------
// 多租户：默认单租户等价，MULTI_TENANT=1 时附 ev.tenant
const { initTenant } = require('./tenant');
const tenantSvc = initTenant({ storage });
const _emitEv = emitEv;
emitEv = (ev) => _emitEv(tenantSvc.attachToEv(ev));   // 包裹：单租户原样，多租户附 tenant

// APC 先进过程控制：默认关(APC_ENABLED=1 才真调)，经 emitEv 汇出建议
const { createApc } = require('./apc/controller');
const meshGet = (p) => fetch(`${process.env.MES_HTTP || 'http://127.0.0.1:8124'}${p}`).then(r => r.json().catch(() => ({})));
const apcSvc = createApc({ mesh: meshGet, emitEv });

// ---- AI 自学习：从历史学参数（跨重启保留于 learned_params 表） ----
const { createLearner, DEFAULTS: AI_DEFAULTS } = require('./ai/learner');
const learner = createLearner({ storage });
const fdcFactorByTool = new Map();   // tool -> 报警阈值系数（AI 学出，替代全场统一 0.6）

// 从历史时序预测未来 N 步：线性趋势 + 残差置信带，并用 METRO_PARAMS 规格红线判定越界
function forecastTsdb({ domain, metric, tool, product, steps = 12, window = 120 }) {
  const series = storage.queryTsdb({ domain, metric, tool, product, limit: window });
  const pts = series.map(r => ({ t: +r.t, value: +r.value }));   // queryTsdb 已按 t ASC（最旧→最新）返回
  if (pts.length < 4) return { ok: false, reason: '历史点不足（<4）', series: pts };
  const dts = [];
  for (let i = 1; i < pts.length; i++) dts.push(pts[i].t - pts[i - 1].t);
  const stepMs = dts.length ? Math.abs(dts.sort((a, b) => a - b)[Math.floor(dts.length / 2)]) : 0;
  const n = pts.length;
  const xs = pts.map((_, i) => i), ys = pts.map(p => p.value);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const slope = sxx ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  let sse = 0; for (let i = 0; i < n; i++) { const yh = intercept + slope * xs[i]; sse += (ys[i] - yh) ** 2; }
  const r2 = syy > 0 ? 1 - sse / syy : 0;
  const residStd = Math.sqrt(sse / Math.max(1, n - 2));
  const lastT = pts[n - 1].t;
  const fore = [];
  for (let k = 1; k <= steps; k++) {
    const x = (n - 1) + k, v = intercept + slope * x, band = 1.645 * residStd;
    fore.push({ t: stepMs ? lastT + stepMs * k : null, value: +v.toFixed(3), lo: +(v - band).toFixed(3), hi: +(v + band).toFixed(3) });
  }
  const mp = (METRO_PARAMS[product] || METRO_PARAMS.N2 || []).find(p => p.param === metric) || null;
  let warn = null;
  if (mp) {
    let firstBad = null, bandTouch = null;
    fore.forEach((f, i) => {
      if (f.value > mp.usl || f.value < mp.lsl) { if (firstBad == null) firstBad = i + 1; }
      if (f.hi > mp.usl || f.lo < mp.lsl) { if (bandTouch == null) bandTouch = i + 1; }
    });
    if (firstBad != null) warn = { level: 'bad', firstStep: firstBad, message: `预测第 ${firstBad} 步起越过规格限（USL=${mp.usl} / LSL=${mp.lsl}）` };
    else if (bandTouch != null) warn = { level: 'warn', firstStep: bandTouch, message: `预测第 ${bandTouch} 步置信带触及规格限，存在越界风险` };
  }
  return {
    ok: true, domain, metric, tool, product,
    hist: pts.map(p => ({ t: p.t, value: +p.value.toFixed(3) })),
    forecast: fore,
    model: { slope: +slope.toFixed(6), intercept: +intercept.toFixed(3), r2: +r2.toFixed(3), residStd: +residStd.toFixed(3), stepMs },
    spec: mp ? { target: mp.target, usl: mp.usl, lsl: mp.lsl, param: mp.param, unit: mp.unit } : null,
    warning: warn,
  };
}

// 主动预测告警：对关键质量/设备指标周期性跑预测，一旦预测将越界即主动 emitEv 进事件总线 + 持久化到 TSDB(engine/pred_alarm)
const PRED_SCAN_TARGETS = [
  { domain: 'quality', metric: 'OVL', product: 'N2' },
  { domain: 'quality', metric: 'OVL', product: 'A16' },
  { domain: 'quality', metric: 'CD',  product: 'N2' },
  { domain: 'quality', metric: 'CD',  product: 'A16' },
  { domain: 'quality', metric: 'THK', product: 'N2' },
  { domain: 'quality', metric: 'THK', product: 'A16' },
  { domain: 'equipment', metric: 'wph', tool: 'DEP-060' },
];
function emitPredAlarm(fc, target) {
  const w = fc.warning;
  const a = {
    type: 'predAlarm', level: w.level, metric: target.metric,
    product: target.product || null, tool: target.tool || null, domain: target.domain,
    firstStep: w.firstStep, message: w.message, horizon: fc.forecast.length, ts: Date.now(),
  };
  emitEv(a);                                   // 进主轴事件总线（Agent 问答副驾/六灯可消费）
  storage.insertTsdb({                         // 持久化为可查询告警记录
    ts: new Date(a.ts).toISOString(), t: a.ts,
    domain: 'engine', metric: 'pred_alarm',
    tool: target.tool || null, lot: null, product: target.product || null,
    value: a.level === 'bad' ? 2 : 1, unit: null,
    aux: { level: a.level, metric: a.metric, product: a.product, tool: a.tool, firstStep: a.firstStep, message: a.message, horizon: a.horizon },
  });
  return a;
}
function predScan() {
  const alarms = [];
  for (const t of PRED_SCAN_TARGETS) {
    try {
      const fc = forecastTsdb({ domain: t.domain, metric: t.metric, tool: t.tool, product: t.product, steps: 12, window: 150 });
      if (fc.ok && fc.warning) alarms.push(emitPredAlarm(fc, t));
    } catch (_) {}
  }
  return alarms;
}

// 读取 learned_params 并即时注入引擎（APC kp / FDC per-tool 因子 / VM 回归系数）
function applyLearnedParams() {
  fdcFactorByTool.clear();
  let apcKp = null, vmReg = null;
  for (const r of storage.listLearnedParams()) {
    if (r.engine === 'apc' && r.param === 'kp') apcKp = r.value;
    else if (r.engine === 'fdc' && r.param === 'thrFactor') fdcFactorByTool.set(r.scope, r.value);
    else if (r.engine === 'vm' && r.param === 'reg') vmReg = r.aux || null;
  }
  if (apcKp != null) apcSvc.setLearnedKp(apcKp);
  if (vmReg) vm.setReg(vmReg);
  log(`[AI自学习] 已加载历史参数：apc.kp=${apcKp != null ? apcKp : '默认0.5'}  fdc.机台=${fdcFactorByTool.size}台  vm.reg=${vmReg ? '已学' : '默认'}`);
}

// 标准协议适配器：ADAPTER_MODE 默认 demo（不启动真实协议）；opcua/eda/all 才接
const { startAdapters } = require('./adapters');
const adapterState = startAdapters({ emitEv });

// 集成适配（ERP demo/in-proc 已在上方；此处暴露状态端点）
const { ErpAdapter } = require('./integrations/erp-adapter');
const erpAdapter = new ErpAdapter({});
console.log(`[MES] L4 装配完成：tenant=${tenantSvc.enabled ? 'ON' : 'off'} apc=${apcSvc.enabled ? 'ON' : 'off'} adapters=${adapterState.mode} erpMode=${erpAdapter.mode}`);

// S3 配方下发语义：lot 投料本机时，按 产品×工序 绑定真实配方并发 recipeLoad 事件（EAP PP-SELECT/PP-CHANGE 等价）
onEmit(ev => {
  if (ev.type !== 'lotStart' || !ev.tool) return;
  const t = byId.get(ev.tool); if (!t) return;
  const lot = engine ? engine.lots.find(l => l.id === ev.lot) : null;
  const product = lot ? lot.product : 'N2';
  const rec = RECIPE_BY_PM[product + ':' + (ev.mod || t.module)];
  if (rec) { t.recipe = rec.name; emitEv({ type: 'recipeLoad', tool: t.id, recipe: rec.name, product, module: rec.module, version: rec.version }); }
});


// ---------- S3/S4 智能引擎装配 ----------
const safe = fn => { try { fn(); } catch (e) { log('DB 写异常(已忽略): ' + e.message); } };
const nowISO = () => new Date().toISOString();
// 近似标准正态（Irwin-Hall 3）
const approxGauss = () => (Math.random() + Math.random() + Math.random()) / 3 * 2 - 1;
// S3 配方管理：按产品×工序的真实工艺配方参数集（仿真引擎配方地基；取代随机串 Rxxx）
const ROUTE_MODS = ['LITHO', 'ETCH', 'DEP', 'CMP', 'IMPL', 'METRO'];
const RECIPE_PARAMS = {
  LITHO: { dose: { v: 32, u: 'mJ/cm²' }, focus: { v: 0.05, u: 'µm' }, expTime: { v: 0.8, u: 's' }, trackTemp: { v: 23, u: '°C' } },
  ETCH:  { gasFlow: { v: 160, u: 'sccm' }, power: { v: 2500, u: 'W' }, pressure: { v: 0.06, u: 'Torr' }, time: { v: 75, u: 's' } },
  DEP:   { temp: { v: 450, u: '°C' }, pressure: { v: 3, u: 'Torr' }, gasFlow: { v: 220, u: 'sccm' }, time: { v: 120, u: 's' } },
  CMP:   { downforce: { v: 4.5, u: 'psi' }, platenRpm: { v: 95, u: 'rpm' }, slurry: { v: 200, u: 'ml/min' }, time: { v: 60, u: 's' } },
  IMPL:  { dose: { v: 1.0e15, u: 'at/cm²' }, energy: { v: 80, u: 'keV' }, tilt: { v: 7, u: '°' } },
  METRO: { targetCD: { v: 18, u: 'nm' }, targetTHK: { v: 220, u: 'nm' }, targetOVL: { v: 3.0, u: 'nm' } },
};
const RECIPES = [];
const RECIPE_BY_PM = {};   // "product:module" -> recipe
['N2', 'A16'].forEach(p => {
  ROUTE_MODS.forEach((m, i) => {
    const key = p + ':' + m;
    if (RECIPE_BY_PM[key]) return;                 // 同产品同工序只建一份（重入共用）
    const rec = { product: p, module: m, step: i + 1, name: `${p}-${m}-R1`, params: RECIPE_PARAMS[m], version: 1 };
    RECIPES.push(rec); RECIPE_BY_PM[key] = rec;
  });
});
// S2 量测：METRO 步骤的量测参数（按产品），SPC 数据源
const METRO_PARAMS = {
  N2: [
    { param: 'CD', unit: 'nm', target: 18, usl: 20, lsl: 16, sigma: 0.4 },
    { param: 'THK', unit: 'nm', target: 220, usl: 230, lsl: 210, sigma: 2.5 },
    { param: 'OVL', unit: 'nm', target: 3.0, usl: 5.0, lsl: 1.0, sigma: 0.5 },
  ],
  A16: [
    { param: 'CD', unit: 'nm', target: 24, usl: 26, lsl: 22, sigma: 0.5 },
    { param: 'THK', unit: 'nm', target: 200, usl: 210, lsl: 190, sigma: 2.5 },
    { param: 'OVL', unit: 'nm', target: 3.5, usl: 5.5, lsl: 1.5, sigma: 0.5 },
  ],
};
// S3 智能引擎：PdM（风险分析）+ VM（虚拟量测）
const pdm = new PdMEngine();
const vm = new VMPredictor();
vm.pending = new Map();                       // lotId -> [{param, pred, tool}]
// S4 SPC：判异报警 → 自动停线（hold 设备及其在制批次），并模拟 PQE 复核后自动放行
// （避免停线永久死锁：真实产线由工程师复核后解除，此处以时延模拟，保持产线贯通）
const spcHoldTimers = new Map();           // toolId -> setTimeout 句柄（去重，避免重复排程）
const SPC_HOLD_RELEASE_MS = 12000;         // PQE 复核放行时延（仿真毫秒）
const spc = new SPC({ onAlarm: alarm => {
  const tool = alarm.tool;
  const lot = [...engine._processing.values()].find(l => l.curTool === alarm.tool);
  engine.holdTool(tool, `SPC ${alarm.param} ${alarm.rules[0]}`);
  let heldLotId = null;
  if (lot) { engine.holdLot(lot.id, `SPC ${alarm.param} @ ${tool}`); heldLotId = lot.id; }
  safe(() => storage.insertSpcAlarm(nowISO(), alarm));
  emitEv({ type: 'spcAlarm', ...alarm });
  log(`⚠ SPC 报警 ${alarm.product} ${alarm.param}@${tool} 值=${alarm.value} [${alarm.rules.join(',')}] → 停线`);
  // 自动处置放行：到期后解除停线并派工（不变更"判异演示"，只是让线流起来）
  // 修复：看门狗 completeTool 在 HOLD 时会把批次移出 _processing，故不能只靠"当前在制批次"反查——
  // 必须记住本次被停线的批次 id 并显式放行，否则批次永久卡在 HOLD（OTD 交付 / NPI 完工被阻断）。
  if (!spcHoldTimers.has(tool)) {
    spcHoldTimers.set(tool, setTimeout(() => {
      spcHoldTimers.delete(tool);
      engine.releaseTool(tool);                 // 清 _hold 并 dispatch(t.module)
      if (heldLotId) engine.releaseLot(heldLotId);          // 放行本次被停线的批次（经 byLot 查，不依赖 _processing）
      for (const l of engine._processing.values())           // 兜底：该设备仍 HOLD 的在制批次一并放行
        if (l.curTool === tool && l.status === 'HOLD') engine.releaseLot(l.id);
      log(`✓ SPC 处置放行 ${tool}`);
    }, SPC_HOLD_RELEASE_MS));
  }
} });
// APS 产能计划引擎（无状态：每次请求实时计算）
const aps = new APSEngine();

// ============================================================
//  P1-4 APS→dispatch 调度闭环：APS 计划回填 MES 派工指令
//  APS 实时算出瓶颈模块 + 关键(LATE/吃紧)批次 → 经 apsDirective 注入 WIPEngine._pick，
//  使派工服从 APS（关键批次优先 / 瓶颈模块 BN），而非硬编码规则。此为「计划→执行」主轴闭环。
// ============================================================
function recomputeApsDirective() {
  try {
    const plan = aps.plan({ tools, lots: engine.lots, wos: engine.wos, modAvgH: engine.modAvgH, rule: engine.rule, lineOf }, 24);
    // 瓶颈模块：负荷≥75%(BUSY/OVERLOAD) 的模块交由 HYBRID 用 BN 优先清约束
    const bottleneckMods = plan.modules.filter(m => m.loadPct >= 75).map(m => m.key);
    // 关键批次：APS 排程判为 LATE 或吃紧(critical)的工单，取其关键 lot 优先派工
    const criticalLots = new Set();
    (plan.wos || []).forEach(w => { if (w && w.critical && w.criticalLot) criticalLots.add(w.criticalLot); });
    const prev = engine.apsDirective || {};
    const prevBn = JSON.stringify(prev.bottleneckMods || []);
    const changed = prevBn !== JSON.stringify(bottleneckMods) || (prev.criticalCount || 0) !== criticalLots.size;
    engine.setApsDirective({ bottleneckMods: bottleneckMods.length ? bottleneckMods : engine.hybridBn.slice(),
      criticalLots, criticalCount: criticalLots.size, updatedAt: Date.now() });
    if (changed) {
      emitEv({ type: 'apsDirective', bottleneckMods: engine.apsDirective.bottleneckMods, criticalLotCount: criticalLots.size,
        moduleLoads: plan.modules.map(m => ({ module: m.key, loadPct: m.loadPct, status: m.status })), updatedAt: engine.apsDirective.updatedAt });
    }
  } catch (e) { log('APS 指令重算异常: ' + e.message); }
}
// FDC 轻量：toolMetric 监控设备性能退化（wph 低于模块均值 60% → 记录）
// L3 增强：复用 fdc.js 的 FDC 引擎，在保持 /api/fdc 原有字段(count/alarms)基础上
//         为 alarm 增加 score(多变量异常分值) / contrib(top 贡献变量)，向后兼容。
const { FDC } = require('./fdc');
const fdc = new FDC();
function fdcCheck(ev) {
  const t = byId.get(ev.id);
  if (!t || !t.wph) return;
  const mates = tools.filter(x => x.module === t.module && x.wph > 0);
  const avgWph = mates.reduce((s, x) => s + x.wph, 0) / Math.max(1, mates.length);
  // 阈值系数优先用 AI 自学习出的 per-tool 因子，否则默认 0.6
  const factor = fdcFactorByTool.get(t.id) != null ? fdcFactorByTool.get(t.id) : 0.6;
  if (t.wph < avgWph * factor) {
    // 用 FDC 引擎统一构造 alarm（保留原有 ts/tool/module/wph/avgWph/util 字段）
    // FDC.assess 内部已维护 fdc.alarms 环形缓冲，这里仅取返回对象发事件，避免重复入队
    const a = fdc.assess(ev, { avgWph, module: t.module, thrFactor: factor },
      { vars: { wph: t.wph, util: ev.util || 0, avgWph: +avgWph.toFixed(1) } });
    emitEv({ type: 'fdcAlarm', ...a });
  }
}
// VM：lot 进入 METRO 时预测（工艺上下文 → 预测量测值）
function vmPredictLot(lotId) {
  const lot = engine.byLot.get(lotId);
  if (!lot) return;
  const tool = lot.curTool;
  const params = METRO_PARAMS[lot.product] || METRO_PARAMS.N2;
  const preds = vm.predict(lotId, lot.product, tool, params);
  vm.pending.set(lotId, preds);
  preds.forEach(p => emitEv({ type: 'vmPrediction', ...p }));
  log(`VM 预测 ${lotId} @ ${tool}: ` + preds.map(p => `${p.param}=${p.pred}${p.cold ? '(冷启动)' : ''}`).join(' '));
}
// VM：实际量测到达 → 对比并更新模型
function vmRecord(ev) {
  vm.record(ev);
  const pend = vm.pending.get(ev.lot);
  const pr = pend && pend.find(x => x.param === ev.param);
  const errPct = pr ? +(((ev.value - pr.pred) / ev.value) * 100).toFixed(2) : null;
  const status = pr ? (Math.abs(errPct) <= 5 ? 'OK' : 'DEVIATION') : 'NO_PRED';
  safe(() => storage.insertVmLog(nowISO(), { lot: ev.lot, product: ev.product, tool: ev.tool, param: ev.param, pred: pr ? pr.pred : null, actual: ev.value, errPct, status }));
  emitEv({ type: 'vmResult', lot: ev.lot, product: ev.product, tool: ev.tool, param: ev.param,
    pred: pr ? pr.pred : null, actual: ev.value, errPct, status });
}
// 生成量测：lot 完成 METRO 步骤时（事件订阅，独立"量测服务"角色）
function generateMetrology(lotId) {
  const lot = engine.byLot.get(lotId);
  if (!lot) return;
  const params = METRO_PARAMS[lot.product] || METRO_PARAMS.N2;
  for (const p of params) {
    const value = +(p.target + approxGauss() * p.sigma).toFixed(2);
    const result = value >= p.lsl && value <= p.usl ? 'OK' : 'OOR';
    const ev = { type: 'metrology', lot: lot.id, product: lot.product, tool: lot.hist[lot.hist.length - 1] ? lot.hist[lot.hist.length - 1].tool : null,
      step: lot.step - 1, param: p.param, unit: p.unit, value, target: p.target, usl: p.usl, lsl: p.lsl, result };
    emitEv(ev);
    safe(() => storage.insertMetrology(nowISO(), ev));
  }
}

// ---------- SQLite 主数据灌库 + 设备初始落库（走存储抽象，SQL 等价） ----------
const metaRoutes = [];
Object.entries(PRODUCTS).forEach(([k, v]) => buildRoute(v.passes).forEach((mod, i) => metaRoutes.push({ product: k, step: i, module: mod })));
storage.seedMeta({ modules: MODULES, products: PRODUCTS, routes: metaRoutes });
storage.seedRecipes(RECIPES);   // S3 配方主数据落库（产品×工序真实配方 + 版本）
storage.seedNpi();          // NPI：设计主数据 + 光罩种子（幂等）
tools.forEach(t => storage.upsertTool(t));
// ---- TSDB 历史回填 + 加载 AI 自学习参数（仅 TSDB 为空时回填，幂等；学习参数跨重启保留） ----
storage.backfillTsdb();
applyLearnedParams();
startLdaWatcher();   // LDA 有机衔接常驻看门狗：设计交付自动触发 NPI 投放
// ---- 演示系统"自动化总开关"开机状态播报 ----
log(`⚙ 自动化总开关：${isAutomationEnabled() ? '【开】实时仿真全速运行' : '【关】演示闲置——仿真心跳与全部自动循环已冻结，仅监控/健康检查/事件持久化运行'}`);
log('   人工开启方式：① 重启时带环境变量 FAB_AUTOMATION=1（仅本次生效）；② 运行时 POST /api/admin/automation {"enabled":true}。每次重启强制回到【关】。');
// 事件批量落库：队列 + 定时 flush（无事务；失败丢弃防队列膨胀卡死事件循环）。频率客户可配。
const flushLoop = () => { setTimeout(flushLoop, telemetry.get('flushMs')); try { storage.flushEvents(); } catch (_) {} };
flushLoop();
// 事件循环心跳诊断：延迟 >2s 说明卡死，打印定位
let hbLast = Date.now();
setInterval(() => {
  const now = Date.now(), lag = now - hbLast - HEARTBEAT_MS;
  if (lag > 2000) log(`⚠ 事件循环延迟 ${lag}ms`);
  hbLast = now;
}, HEARTBEAT_MS);
// 历史数据保留：落库表全量封顶裁剪，防无限膨胀（护栏②）。
// 2026-09-01 真机教训：仅封 events/tsdb/chamber_hist 不够，audit_log 等表照样涨到 2.4GB。
// 默认 events 20万 / tsdb 50万 / chamber_hist 20万 / audit 20万 / 量测 10万 / SPC 5万 / VM 10万 / 批次历史 20万，每 60s 巡检（均可配）。
const EVENTS_RETENTION = +(process.env.EVENTS_RETENTION || 200000);
const TSDB_RETENTION = +(process.env.TSDB_RETENTION || 500000);
const HIST_RETENTION = +(process.env.HIST_RETENTION || 200000);
const AUDIT_RETENTION = +(process.env.AUDIT_RETENTION || 200000);
const METR_RETENTION = +(process.env.METR_RETENTION || 100000);
const SPC_RETENTION = +(process.env.SPC_RETENTION || 50000);
const VM_RETENTION = +(process.env.VM_RETENTION || 100000);
const LOTHIST_RETENTION = +(process.env.LOTHIST_RETENTION || 200000);
const RETENTION_MS = +(process.env.RETENTION_MS || 60000);
// 时间窗口保留（天）：events 3 / tsdb 7 / chamber_hist 3 / audit 7 / metrology 7 / spc 7 / vm 7 / lot_hist 30
const RETENTION_DAYS = {
  events: +(process.env.RETENTION_DAYS_EVENTS || 3),
  tsdb: +(process.env.RETENTION_DAYS_TSDB || 7),
  chamber_hist: +(process.env.RETENTION_DAYS_HIST || 3),
  audit_log: +(process.env.RETENTION_DAYS_AUDIT || 7),
  metrology: +(process.env.RETENTION_DAYS_METR || 7),
  spc_alarm: +(process.env.RETENTION_DAYS_SPC || 7),
  vm_log: +(process.env.RETENTION_DAYS_VM || 7),
  lot_hist: +(process.env.RETENTION_DAYS_LOTHIST || 30),
};
const RETENTION_VACUUM_MB = +(process.env.RETENTION_VACUUM_MB || 800);   // 库文件超此值自动 VACUUM 释放磁盘
const _retOpts = () => ({ days: RETENTION_DAYS, vacuumThresholdMb: RETENTION_VACUUM_MB });
try { storage.enforceRetention(EVENTS_RETENTION, TSDB_RETENTION, HIST_RETENTION, AUDIT_RETENTION, METR_RETENTION, SPC_RETENTION, VM_RETENTION, LOTHIST_RETENTION, _retOpts()); } catch (_) {}
setInterval(() => { try { storage.enforceRetention(EVENTS_RETENTION, TSDB_RETENTION, HIST_RETENTION, AUDIT_RETENTION, METR_RETENTION, SPC_RETENTION, VM_RETENTION, LOTHIST_RETENTION, _retOpts()); } catch (_) {} }, RETENTION_MS);

// M3 SECS/GEM：3 台演示设备可被 EAP Host 建立 HSMS 会话（id 必须存在于合成工厂 byId）
const SECS_DEVICES = { 1: 'LITHO-001', 2: 'ETCH-015', 3: 'DEP-060' };
const secsDevId = {}; Object.entries(SECS_DEVICES).forEach(([d, t]) => { secsDevId[t] = +d; });
const HSMS_PORT = process.env.HSMS_PORT ? +process.env.HSMS_PORT : 5000;
const secs = new SecsGemGateway({ port: HSMS_PORT, devices: SECS_DEVICES, onLog: m => log(m),
  onControl: (deviceId, rcmd, params) => {
    const toolId = SECS_DEVICES[deviceId];
    const t = byId.get(toolId);
    if (!t) return 1;                                   // 1 = 未知设备
    // P1-2 APC setpoint 真实回灌：S2F41 SET_PARAM 把工艺参数写入设备模型（不依赖 lot 占用，随时可写）
    if (rcmd === 'SET_PARAM') {
      const param = params[0]; const value = params[1];
      if (!secs.deviceParams[deviceId]) secs.deviceParams[deviceId] = {};
      secs.deviceParams[deviceId][param] = { value, ts: Date.now() };
      log(`EAP 远程控制 ${toolId}: SET_PARAM ${param}=${value} 已写入设备参数模型`);
      emitEv({ type: 'setpointApplied', tool: toolId, device: deviceId, param, value, source: 'eap-s2f41', ts: Date.now() });
      return 0;                                         // 0 = ACK 成功
    }
    if (t._lot != null) return 0;                       // 引擎占用中：ACK 但状态由 MES 管理（演示语义）
    if (rcmd === 'ABORT' || rcmd === 'STOP') {
      t.status = 'IDLE';
      emitEv({ type: 'toolStatus', id: toolId, status: 'IDLE', src: 'eap' });
      log(`EAP 远程控制 ${toolId}: ${rcmd} → IDLE`);
    } else if (rcmd === 'START' || rcmd === 'POWER_ON') {
      t.status = 'IDLE';
      emitEv({ type: 'toolStatus', id: toolId, status: 'IDLE', src: 'eap' });
      log(`EAP 远程控制 ${toolId}: ${rcmd} → 就绪`);
    }
    return 0;                                           // 0 = ACK 成功
  } });
const e10 = new E10Tracker(tools);

// ---------- emitEv 业务订阅（原 emitEv 内部逻辑，统一经 eventbus 注册；§6.3 红线） ----------
onEmit(ev => {
  if (ev.type === 'toolStatus') e10.record(ev.id, ev.status);
  // S2 量测服务：订阅 lot 完成 METRO 步骤 → 生成量测（异步避免重入）
  if (ev.type === 'lotStepDone' && ev.mod === 'METRO') setTimeout(() => generateMetrology(ev.lot), 30);
  // S3 VM：lot 进入 METRO → 虚拟量测预测；实际量测到达 → 对比
  if (ev.type === 'lotStart' && ev.mod === 'METRO') setTimeout(() => vmPredictLot(ev.lot), 30);
  if (ev.type === 'metrology') vmRecord(ev);
  // S4 SPC：量测到达 → 判异（报警则自动停线）；FDC：设备指标异常检测
  if (ev.type === 'metrology') spc.onMetrology(ev);
  if (ev.type === 'toolMetric') fdcCheck(ev);
  // S5 APC 先进过程控制：VM 虚拟量测预测到达即驱动控制步（P1-3 VM→APC 量测→控制子闭环）
  //   由 vmPrediction 事件（VM 反馈，已焊入主轴）触发，预测值 pred 即控制反馈输入；
  //   不再裸挂在 metrology 上——VM 输出经总线进入 APC 反馈通道，APC 据此微调 setpoint（P1-2 回灌设备）。
  //   递归熔断：apcSetpoint→S2F41→setpointApplied 回总线，均不回流触发本订阅，无递归风险。
  if (ev.type === 'vmPrediction' && apcSvc.enabled) {
    const def = (METRO_PARAMS[ev.product] || METRO_PARAMS.N2).find(p => p.param === ev.param) || (METRO_PARAMS.N2 || [])[0];
    apcSvc.step({ tool: ev.tool, param: ev.param, product: ev.product,
      target: ev.target != null ? ev.target : (def ? def.target : undefined),
      predicted: ev.pred, lot: ev.lot })
      .catch(e => log('APC 自动闭环异常: ' + e.message));
  }
  // FDC 在线基线：任何带设备的事件都喂样本（L3 多变量 score 需持续样本积累）
  if (ev.id && byId.get(ev.id)) {
    const t = byId.get(ev.id);
    const mates = tools.filter(x => x.module === t.module && x.wph > 0);
    const avgWph = mates.reduce((s, x) => s + x.wph, 0) / Math.max(1, mates.length);
    fdc.feed(ev, { avgWph, module: t.module }, { vars: { wph: t.wph || 0, util: t.util || 0, avgWph: +avgWph.toFixed(1) } });
  }
  // 外部 ingest（EAP 桥）事件不回推 SECS 网关，防止 EAP→ingest→S6F11→EAP 死循环
  // 仅回推 toolStatus / lotStart：lotDone 由设备(网关)自行在加工时延后上报，绝不回推，杜绝"完工事件→EAP→再完工"的重复/提前完成
  const did = secsDevId[ev.id];
  if (did != null && ev.src !== 'eap' && (ev.type === 'toolStatus' || ev.type === 'lotStart')) secs.pushEvent(did, ev);
});

// ---------- 时序库（TSDB）统一沉淀：把主轴事件按 域/指标 落库（数据资产地基） ----------
onEmit(ev => {
  const t = Date.now();
  const ts = new Date(t).toISOString();
  switch (ev.type) {
    case 'metrology':
      storage.insertTsdb({ ts, t, domain: 'quality', metric: ev.param, tool: ev.tool, lot: ev.lot, product: ev.product, value: ev.value, unit: ev.unit, aux: { target: ev.target, usl: ev.usl, lsl: ev.lsl } });
      break;
    case 'toolMetric':
      if (ev.wph != null)   storage.insertTsdb({ ts, t, domain: 'equipment', metric: 'wph',  tool: ev.id, value: ev.wph,  unit: 'wph' });
      if (ev.util != null)  storage.insertTsdb({ ts, t, domain: 'equipment', metric: 'util', tool: ev.id, value: ev.util, unit: '%' });
      break;
    case 'apcSetpoint':
      storage.insertTsdb({ ts, t, domain: 'engine', metric: 'apc_' + ev.param, tool: ev.tool, lot: ev.lot, product: ev.product, value: ev.setpoint, unit: ev.param, aux: { target: ev.target, predicted: ev.predicted, adjust: ev.adjust } });
      break;
    case 'vmResult':
      if (ev.errPct != null) storage.insertTsdb({ ts, t, domain: 'engine', metric: 'vm_err', tool: ev.tool, lot: ev.lot, product: ev.product, value: ev.errPct, unit: '%' });
      break;
    case 'fdcAlarm':
      storage.insertTsdb({ ts, t, domain: 'engine', metric: 'fdc_score', tool: ev.tool, value: ev.score || 0, unit: 'score', aux: { below60: !!ev.below60 } });
      break;
    case 'spcAlarm':
      storage.insertTsdb({ ts, t, domain: 'engine', metric: 'spc_' + ev.param, tool: ev.tool, product: ev.product, value: ev.value, unit: ev.unit });
      break;
    case 'lotDone':
      if (ev.cycleH != null) storage.insertTsdb({ ts, t, domain: 'production', metric: 'cycleH', lot: ev.lot, product: ev.product, value: ev.cycleH, unit: 'h' });
      break;
  }
});

// ---------- P1-1 FDC 判异 → 自动响应闭环 ----------
// FDC 检测到设备退化即自动触发处置：落 fdcAutoResp 事件到主轴，并跨引擎升起 PdM 预测性维护
// 观察告警（供 P1-5 Agent 编排消费）。软标记、不硬停线（硬停线归 SPC）；与 APC 回灌同理，
// 此处 emit 的是 fdcAutoResp/pdmAlert（非 fdcAlarm），不会重入本订阅，无递归风险。
onEmit(ev => {
  if (ev.type !== 'fdcAlarm') return;
  const anom = ev.below60 || (ev.score != null && ev.mvThreshold != null && ev.score > ev.mvThreshold);
  if (!anom) return;
  const reason = ev.below60 ? 'wph<60%模块均值' : '多变量马氏距离超阈';
  const action = 'flag-pdm-observe';
  log(`[P1-1 FDC→自动响应] ${ev.tool} 判异(score=${ev.score}, below60=${!!ev.below60}) → 动作=${action}`);
  emitEv({ type: 'fdcAutoResp', tool: ev.tool, module: ev.module, reason, score: ev.score, contrib: ev.contrib || [], action, ts: Date.now() });
  emitEv({ type: 'pdmAlert', tool: ev.tool, module: ev.module, source: 'fdc', reason, score: ev.score, ts: Date.now() });
});

// ---------- 物流主轴：把真实批次生命周期事件翻译为 AMHS 真实搬运 ----------
// 替代原 tick() 内的随机 amhs（"物流做样子"）；现由 lotRelease/lotStart/lotStepDone/lotDone
// 四个真实事件驱动，from/to 为真实库位节点（WH-RAW/STAGE-A/设备/WH-FIN）。
// 蓝图态标注：amhs 事件当前仅广播 + 落库，全系统无 onEmit/WS 消费方（ERP/WMS 只吃 lotRelease/lotDone/shipment），
// 属"真实搬运主轴"的挂枝展示，不接真实 AMHS 调度消费者（按"串主轴不填层"纪律，不强行补齐）。
onEmit(ev => {
  const foup = ev.lot || ev.tool || 'FOUP';
  if (ev.type === 'lotRelease') {
    emitEv({ type: 'amhs', from: 'WH-RAW',  to: 'STAGE-A', foup, kind: 'issue',    lot: ev.lot });
  } else if (ev.type === 'lotStart') {
    emitEv({ type: 'amhs', from: 'STAGE-A', to: ev.tool,  foup, kind: 'toTool',   lot: ev.lot });
  } else if (ev.type === 'lotStepDone') {
    emitEv({ type: 'amhs', from: ev.tool,  to: 'STAGE-A', foup, kind: 'fromTool', lot: ev.lot });
  } else if (ev.type === 'lotDone') {
    // 仅「最终完工」(engine 补全时带 cycleH) 才送成品仓；EAP 步骤级 lotDone 视为步骤完成→暂存
    if (ev.cycleH != null) emitEv({ type: 'amhs', from: 'STAGE-A', to: 'WH-FIN', foup, kind: 'finish', lot: ev.lot });
    else if (ev.tool)      emitEv({ type: 'amhs', from: ev.tool,  to: 'STAGE-A', foup, kind: 'fromTool', lot: ev.lot });
  }
});

// ---------- L4 合规审计层：仅订阅现有 emitEv，落不可篡改审计链（只读接入，不新造事件） ----------
const audit = initAudit({ storage, eventbus: { onEmit } });

// 设备随机扰动：只作用于未被派工引擎占用的设备（_lot 为空），转回 IDLE 时尝试派工
function tick() {
  if (!isAutomationEnabled()) return;   // 自动化总开关关：冻结仿真心跳，整条产线静止（演示闲置/省资源）
  const n = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const t = tools[Math.floor(Math.random() * tools.length)];
    if (t._lot != null || t._hold) continue;            // 引擎占用/SPC 停线，跳过
    const next = transition(t.status);
    if (next !== t.status) {
      t.status = next;
      emitEv({ type: 'toolStatus', id: t.id, status: next });
      storage.updateToolStatus(next, nowISO(), t.id);
      if (next === 'IDLE') engine.dispatch(t.module);   // 设备可用 → 看队列有无活
    } else if (Math.random() < 0.4) {
      t.util = Math.round(clamp(t.util + rnd(-3, 3), 30, 99));
      t.wafers += Math.round(rnd(5, 120));
      t.wph = Math.round(clamp(t.wph + rnd(-4, 4), 15, 200));
      emitEv({ type: 'toolMetric', id: t.id, util: t.util, wafers: t.wafers, wph: t.wph });
      storage.updateToolMetric(t.util, t.wafers, t.wph, nowISO(), t.id);
    }
  }
  tickChambers(TICK_MS / 1000);                          // 腔室级状态模型：全设备逐腔室实时演进
}
// 腔室级状态模型推进：所有设备每 tick 演进一次；active 由整机是否 RUN 决定
// 同时把腔室遥测焊入数字主线：① 节流经 emitEv('chamberUpdate') 上事件总线
// （与 toolMetric 同源，3D 孪生/WS 客户端可实时订阅）；② 明显退化(fault≥2)
// 喂入 FDC 判异，经既有 SPC 导航红点→孪生→Agent 链路生效。
let _chamberTick = 0;
const _chamberFdcCd = new Map();   // tool -> 上次腔室 FDC 报警 ts（节流，避免刷屏）
function tickChambers(dt) {
  _chamberTick++;
  const emitBatch = (_chamberTick % 6 === 0);    // 约每 3.6s 广播一次 RUN 设备腔室遥测
  const histBatch = (_chamberTick % 50 === 0);   // 约每 30s 归档 RUN 腔室时序（trace historian）
  const now = Date.now();
  const histRows = [];
  for (const t of tools) {
    const cm = chambers.get(t.id);
    if (!cm) continue;
    const isRun = t.status === 'RUN';
    cm.setToolDown(t.status === 'DOWN');
    // 护栏① 降频：仅运行设备演进腔室模型；空闲/停机设备不空转（稳态 CPU 回落）
    if (isRun) cm.tick(dt, true);

    // —— ① 腔室遥测上事件总线（主轴） ——
    if (isRun && emitBatch) {
      emitEv({ type: 'chamberUpdate', id: t.id, module: t.module, status: t.status, chambers: cm.snapshot() });
    }

    // —— ② 腔室漂移 → FDC 判异（仅运行设备有意义）——
    if (isRun) {
      const drifts = cm.driftChambers();
      if (drifts.length) {
        const last = _chamberFdcCd.get(t.id) || 0;
        if (now - last > 45000) {                 // 每台 45s 内至多一条，避免刷屏
          _chamberFdcCd.set(t.id, now);
          const worst = drifts.sort((a, b) => b.dev - a.dev)[0];
          const a = {
            ts: now, tool: t.id, module: t.module, type: 'chamberDrift',
            chamber: worst.ch, fault: worst.fault,
            temp: worst.temp, rf: worst.rf, gas: worst.gas, press: worst.press,
            devPct: worst.dev,
            wph: t.wph || 0, avgWph: 0, util: t.util || 0,
            score: worst.dev, contrib: [{ var: 'chamberDrift:' + worst.ch, weight: worst.dev }],
          };
          fdc.alarms.push(a);
          if (fdc.alarms.length > 100) fdc.alarms.shift();
          emitEv({ type: 'fdcAlarm', ...a });
        }
      }
    }

    // —— ③ 腔室时序归档（trace historian，供趋势/回放/FDC 回溯）——
    if (isRun && histBatch) {
      cm.snapshot().forEach(c => histRows.push({ ts: nowISO(), tool: t.id, chamber: c.ch, temp: c.temp, rf: c.rf, gas: c.gas, press: c.press }));
    }
  }
  if (histRows.length) safe(() => storage.insertChamberHist(histRows));
}

// ---------- REST API（仅 /api/* ；静态页移交 portal.js :8123） ----------
// 安全 JSON 序列化：自动剥离循环引用（Timeout/EventEmitter 等内部对象）
const json = (res, code, obj) => {
  try {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj, (_, v) => {
      if (v == null) return v;
      if (typeof v === 'object') {
        // 剥离 Node.js 内部循环引用对象（Timeout/TimersList/EventEmitter 等）
        if (v.constructor && /^(Timeout|TimersList|EventEmitter|Process|Socket)$/.test(v.constructor.name)) return '[Circular]';
        // 剥离工具对象内部属性（_watchDog/_lot/_hold/_pt）
        if (Array.isArray(v)) return v;
      }
      return v;
    }));
  } catch (e) {
    // 兜底：序列化失败时返回安全错误，不崩溃进程
    console.error('json() serialize error:', e.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'serialize_error', detail: e.message }));
    }
  }
};
function countByStatus() {
  const m = { RUN: 0, IDLE: 0, PM: 0, DOWN: 0 };
  tools.forEach(t => { m[t.status] = (m[t.status] || 0) + 1; });
  return m;
}
function handler(req, res) {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const route = u.pathname;
  gov.touch();   // 任意 API 调用即记为"有用户活动"，解除空闲降频
  if (route === '/api/health') return json(res, 200, { ok: true, service: 'fab-mes', version: 'M3-S1', tools: tools.length, clients: wss.clients.size, uptime: +process.uptime().toFixed(1) });
  // 资源治理自监控：实时查看并发数 / 队列长度 / 任务耗时 / 各周期任务开关与 CPU 增量（护栏验收依据）
  if (route === '/api/governor') {
    const snap = gov.snapshot();
    return json(res, 200, {
      ...snap,
      wip: { wip: engine.stats.wip, done: engine.stats.done, releases: engine.stats.releases,
        lots: engine.lots.length, wos: engine.wos.length,
        queues: Object.fromEntries(Object.keys(engine.queues).map(m => [m, engine.queues[m].length])) },
      automation: isAutomationEnabled(),
      lda: { lastSync: ldaLastSync, lastError: ldaLastError, imported: ldaImportCount, watching: LDA_WATCHER },
      autoWo: { on: autoWo, paused: autoWoPaused, atCap: autoWo_atCap, cap: WIP_CAP },
    });
  }
  // P1-2：设备工艺参数模型（APC setpoint 经 EAP S2F41 真实回灌后的落点），供孪生/验收读取
  if (route === '/api/secs') return json(res, 200, { deviceParams: secs.deviceParams, devices: SECS_DEVICES });
  // ERP 集成路由（in-proc 模式挂载；standalone 模式由 fab-erp.js :8126 提供）
  if (erpSvc && route.startsWith('/api/erp/')) return erpSvc.handler(req, res);

  // ---- L4 能力路由（已接活模块的状态/触发入口）----
  if (route === '/api/tenant') return json(res, 200, {
    enabled: tenantSvc.enabled, defaultTenant: tenantSvc.defaultTenant,
    tenants: tenantSvc.listTenants(),
    note: '事件级 tenant 透传已接活（ev.tenant 显式携带即透传）；行级数据隔离(库/表)为蓝图态，未实现',
  });
  if (route === '/api/adapters') return json(res, 200, {
    mode: adapterState.mode, started: adapterState.started || [],
    stats: (typeof adapterState.stats === 'function') ? adapterState.stats() : {},
    note: adapterState.note, env: 'ADAPTER_MODE=demo|opcua|eda|all',
  });
  if (route === '/api/integration/erp') return json(res, 200, {
    mode: erpAdapter.mode, endpoints: erpAdapter.getEndpoints(),
    inProc: !!erpSvc, note: 'ERP 集成适配状态',
  });
  if (route === '/api/apc/advise' && req.method === 'POST') {
    return new Promise((resolve) => {
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); } });
    }).then(b => apcSvc.step({
      tool: b.tool || 'LITHO-01', param: b.param || 'CD', target: b.target, predicted: b.predicted,
    }).then(r => json(res, 200, r)));
  }
  if (route === '/api/apc/advise') return json(res, 200, {
    enabled: apcSvc.enabled, note: 'POST 触发一次建议；APC_ENABLED=1 才真实闭环微调',
    law: 'offset-compensate P(kp=0.5, deadband=0.05)',
  });
  // P3 埋雷清理：补齐潜在死路由别名，避免将来接按钮即 404（当前无前端引用，属前瞻修复）
  if (route === '/api/spc/alarms') return json(res, 200, { alarms: storage.querySpcAlarms(30) });
  if (route === '/api/wip/stats') return json(res, 200, engine.wipSnapshot());
  if (route === '/api/dashboard') return json(res, 200, { ok: true, health: { tools: tools.length, clients: wss.clients.size, uptime: +process.uptime().toFixed(1) }, wip: engine.wipSnapshot(), spc: { alarms: storage.querySpcAlarms(30).length } });
  if (route === '/api/apc') return json(res, 200, { enabled: apcSvc.enabled, note: 'APC 为建议器+闭环执行器：APC_ENABLED=1 时量测到达自动闭环微调（经护栏 spc.inject 真实回灌，带 source 防递归）', law: 'offset-compensate P(kp=0.5, deadband=0.05)' });
  // S1 主数据服务（modules/products/routes/secsDevices/状态集/规则）
  if (route === '/api/meta') {
    const modules = storage.queryMetaModules();
    const products = storage.queryMetaProducts();
    const routes = storage.queryMetaRoutes();
    return json(res, 200, { modules, products, routes, secsDevices: SECS_DEVICES,
      statusMap: { RUN: '运行中', IDLE: '空闲', PM: '维护', DOWN: '故障' },
      dispatchRules: ['FIFO', 'SPT', 'CR', 'EDD', 'BN', 'HYBRID'] });
  }
  // S2 量测数据（SPC 数据源）：分页/按参数/lot/product 过滤 + 统计汇总
  if (route === '/api/metrology') {
    const param = u.searchParams.get('param'), lotId = u.searchParams.get('lot'), product = u.searchParams.get('product');
    const limit = Math.min(500, +(u.searchParams.get('limit') || 100));
    const rows = storage.queryMetrology({ param, lot: lotId, product, limit });
    // 统计（按参数+产品分组，避免 N2/A16 target 不同导致失真）：均值/σ/CPK
    const grp = storage.queryMetrologyStats();
    const stats = grp.map(s => {
      const vs = storage.queryMetrologyValues(s.param, s.product);
      const sd = vs.length > 1 ? Math.sqrt(vs.reduce((a, v) => a + (v - s.mean) * (v - s.mean), 0) / (vs.length - 1)) : 0;
      return { param: s.param, product: s.product, unit: s.unit, n: s.n, mean: +(+s.mean).toFixed(3), sd: +sd.toFixed(3), min: s.mn, max: s.mx,
        cpk: sd > 0 && s.usl != null ? +Math.min((s.usl - s.mean) / (3 * sd), (s.mean - s.lsl) / (3 * sd)).toFixed(2) : 0 };
    });
    return json(res, 200, { count: rows.length, stats, samples: rows.map(r => ({ id: r.id, ts: r.ts, lot: r.lot, product: r.product, tool: r.tool, step: r.step, param: r.param, unit: r.unit, value: r.value, target: r.target, usl: r.usl, lsl: r.lsl, result: r.result })) });
  }
  // S3 PdM：设备故障风险排行（预测性维护）
  if (route === '/api/pdm') return json(res, 200, pdm.assess(e10.dev, tools));
  // 拓扑定义（数字孪生产线级/工厂级数据地基）：产线/工段/模块归属
  if (route === '/api/topo') {
    return json(res, 200, { lines: LINES, moduleLine: MODULE_LINE, toolCount: tools.length });
  }
  // APS 产能计划：模块负荷/瓶颈/工单排程（无状态实时计算）+ 产线级聚合
  if (route === '/api/aps') {
    const horizon = Math.min(168, Math.max(1, +(u.searchParams.get('horizon') || 24)));
    const snap = { tools, lots: engine.lots, wos: engine.wos, modAvgH: engine.modAvgH, rule: engine.rule, lineOf };
    return json(res, 200, aps.plan(snap, horizon));
  }
  // P1-4：当前 APS→dispatch 指令（派工实际服从的计划结论），供验证/twin/Agent 消费
  if (route === '/api/aps/directive') {
    const d = engine.apsDirective || { bottleneckMods: [], criticalLots: new Set(), criticalCount: 0, updatedAt: 0 };
    return json(res, 200, { bottleneckMods: d.bottleneckMods, criticalLotIds: [...d.criticalLots], criticalCount: d.criticalCount || 0, updatedAt: d.updatedAt });
  }
  // P1-4：强制重算 APS 指令（验证/Agent 触发用，避免等待定时周期）
  if (route === '/api/aps/recompute' && req.method === 'POST') {
    recomputeApsDirective();
    const d = engine.apsDirective;
    return json(res, 200, { ok: true, bottleneckMods: d.bottleneckMods, criticalLotIds: [...d.criticalLots], criticalCount: d.criticalCount || 0, updatedAt: d.updatedAt });
  }
  // S3 VM：虚拟量测结果与精度
  if (route === '/api/vm') {
    const limit = Math.min(200, +(u.searchParams.get('limit') || 50));
    const rows = storage.queryVmLog(limit);
    const stats = vm.stats(rows.filter(r => r.errPct != null));
    // L3 专业版接线：用演示设备近期状态作为传感器代理，证明 predictVirtual 回归虚拟量测已接入
    const demoTool = byId.get('LITHO-001');
    const virtualDemo = demoTool ? vm.predictVirtual('LITHO-001',
      { temp: 320 + Math.round((demoTool.util || 0) * 20), power: 88 + (demoTool.util || 0) * 10, rate: demoTool.wph || 0 },
      { param: 'CD_VIRTUAL', target: 45 }) : null;
    return json(res, 200, { stats, virtualDemo, results: rows.map(r => ({ id: r.id, ts: r.ts, lot: r.lot, product: r.product, tool: r.tool, param: r.param, pred: r.pred, actual: r.actual, errPct: r.errPct, status: r.status })) });
  }
  // S4 SPC：监控组状态 + 报警记录
  if (route === '/api/spc') {
    const alarms = storage.querySpcAlarms(30);
    return json(res, 200, { ...spc.snapshot(), alarms });
  }
  // APS what-if 仿真：构造假设快照（DOWN 指定设备 / 加派工单）重算产能，复用同一无状态引擎内核
  if (route === '/api/aps/sim' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      let cfg = {}; try { cfg = body ? JSON.parse(body) : {}; } catch (_) {}
      const downTools = Array.isArray(cfg.downTools) ? cfg.downTools : [];
      const extraWos = Array.isArray(cfg.extraWos) ? cfg.extraWos : [];
      const horizon = Math.min(168, Math.max(1, +(cfg.horizon || 24)));
      const baseTools = tools.map(t => ({ ...t }));
      const downSet = new Set(downTools);
      baseTools.forEach(t => { if (downSet.has(t.id)) t.status = 'DOWN'; });
      const baseLots = engine.lots.map(l => ({ ...l }));
      const routeCache = {};
      const getRoute = p => {
        if (!routeCache[p]) routeCache[p] = storage.queryRouteForProduct(p);
        return routeCache[p];
      };
      let vidx = 0;
      for (const w of extraWos) {
        const product = w.product || 'N2';
        const route = getRoute(product);
        const qty = Math.max(1, Math.min(20, w.qty || 3));
        for (let i = 0; i < qty; i++) {
          baseLots.push({ id: `SIM-${++vidx}`, product, route, step: 0, status: 'WIP', rem: route.length, due: Date.now() + (w.dueHours || 48) * 3600e3 });
        }
      }
      const base = aps.plan({ tools: baseTools, lots: baseLots, wos: engine.wos, modAvgH: engine.modAvgH, rule: engine.rule, lineOf }, horizon);
      const cur = aps.plan({ tools, lots: engine.lots, wos: engine.wos, modAvgH: engine.modAvgH, rule: engine.rule, lineOf }, horizon);
      const cmp = base.modules.map(m => {
        const c = cur.modules.find(x => x.key === m.key);
        return { module: m.key, name: m.name, baseLoad: c ? c.loadPct : 0, simLoad: m.loadPct, delta: +(m.loadPct - (c ? c.loadPct : 0)).toFixed(1) };
      });
      return json(res, 200, {
        horizon, downTools, extraWos: extraWos.map(w => ({ product: w.product || 'N2', qty: Math.max(1, Math.min(20, w.qty || 3)), dueHours: w.dueHours || 48 })),
        baseKpi: cur.kpi, simKpi: base.kpi,
        modules: cmp,
        bottleneck: base.bottleneck, lineBottleneck: base.lineBottleneck,
        simValid: base.kpi && base.kpi.bottleneckLoad < 100,
      });
    });
    return;
  }
  // S4 SPC：释放停线（设备或批次）
  if (route === '/api/spc/release' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      let cfg = {}; try { cfg = body ? JSON.parse(body) : {}; } catch (_) {}
      const ok = [];
      if (cfg.tool) ok.push(engine.releaseTool(cfg.tool));
      if (cfg.lot) ok.push(engine.releaseLot(cfg.lot));
      log(`SPC 释放: ${JSON.stringify(cfg)}`);
      return json(res, 200, { ok: ok.some(Boolean), released: cfg });
    });
    return;
  }
  // S4 SPC：测试注入一条量测（验证判异/停线闭环）
  if (route === '/api/spc/inject' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      let cfg = {}; try { cfg = body ? JSON.parse(body) : {}; } catch (_) {}
      const product = cfg.product || 'N2', param = cfg.param || 'CD', tool = cfg.tool || 'METRO-001';
      const def = (METRO_PARAMS[product] || METRO_PARAMS.N2).find(p => p.param === param) || METRO_PARAMS.N2[0];
      const ev = { type: 'metrology', lot: cfg.lot || 'TEST-LOT', product, tool, step: 0, param: def.param, unit: def.unit,
        value: cfg.value ?? def.usl + 1, target: def.target, usl: def.usl, lsl: def.lsl, result: 'OOR', source: cfg.source };
      vmRecord(ev); spc.onMetrology(ev);
      log(`SPC 注入量测 ${product} ${param}@${tool} = ${ev.value}`);
      return json(res, 200, { injected: ev });
    });
    return;
  }
  // S4 FDC：设备性能退化报警
  if (route === '/api/fdc') return json(res, 200, { count: fdc.alarms.length, alarms: fdc.alarms.slice().reverse() });
  // S1 Historian：按时间/类型查询事件历史
  if (route === '/api/history/events') {
    const from = u.searchParams.get('from'), to = u.searchParams.get('to'), type = u.searchParams.get('type');
    const limit = Math.min(1000, +(u.searchParams.get('limit') || 200));
    const rows = storage.queryEvents({ from, to, type, limit });
    return json(res, 200, { count: rows.length, events: rows.map(r => ({ seq: r.seq, ts: r.ts, type: r.type, ...JSON.parse(r.payload) })) });
  }
  // L4 合规审计：最近 N 条审计记录（链式不可篡改，SEMI 追溯标签可见）
  if (route === '/api/audit' || route === '/api/audit/log') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        let rec = {}; try { rec = body ? JSON.parse(body) : {}; } catch (_) {}
        try {
          audit.logAction({ actor: rec.actor || 'autonomy', action: rec.action || 'unknown', target: rec.target || null, payload: rec.payload || {}, semi: rec.semi || [] });
          return json(res, 201, { ok: true });
        } catch (e) { return json(res, 400, { error: e.message }); }
      });
      return;
    }
    const limit = Math.min(1000, +(u.searchParams.get('limit') || 50));
    const actor = u.searchParams.get('actor') || undefined;
    const action = u.searchParams.get('action') || undefined;
    const after = u.searchParams.get('after') != null ? +(u.searchParams.get('after')) : undefined;
    const rows = audit.queryAudit({ limit, actor, action, after });
    return json(res, 200, { count: rows.length, audit: rows });
  }
  if (route === '/api/tools') {
    const byModule = {};
    MODULES.forEach(m => { byModule[m.key] = tools.filter(t => t.module === m.key).length; });
    // 序列化前剥离工具对象内部属性（_watchDog=Timeout 循环引用 / _lot / _hold / _pt）
    const cleanTools = tools.map(t => { const o = {}; for (const k of Object.keys(t)) { if (!k.startsWith('_')) o[k] = t[k]; } o.curLot = t._lot || null; return o; });
    return json(res, 200, { total: tools.length, byStatus: countByStatus(), byModule, tools: cleanTools });
  }
  if (route === '/api/events') {
    const limit = Math.min(500, +(u.searchParams.get('limit') || 100));
    const after = +(u.searchParams.get('after') || 0);
    const rows = storage.queryEvents({ after, limit });
    return json(res, 200, { count: rows.length, events: rows.map(r => ({ seq: r.seq, ts: r.ts, type: r.type, ...JSON.parse(r.payload) })) });
  }
  // ---- M2 MES 核心端点 ----
  if (route === '/api/wip') return json(res, 200, engine.wipSnapshot());
  if (route === '/api/e10') return json(res, 200, e10.snapshot());
  if (route === '/api/e10dbg') { const first = e10.dev.get('LITHO-001'); return json(res, 200, { dev: first, now: Date.now(), startTs: e10.startTs }); }
  // 仿真引擎 · 腔室级状态模型：逐腔室真实遥测。?tool=X 返回单台全腔室；无参数返回全厂摘要
  if (route === '/api/chambers') {
    const tool = u.searchParams.get('tool');
    if (tool) {
      const cm = chambers.get(tool);
      if (!cm) return json(res, 404, { error: 'unknown tool ' + tool });
      return json(res, 200, { tool, module: cm.module, profile: (PROFILES[cm.module] || {}).label, chambers: cm.snapshot() });
    }
    const summary = {};
    for (const [id, cm] of chambers) summary[id] = cm.summary();
    return json(res, 200, { total: chambers.size, tools: summary });
  }
  // ---- 晶圆级追踪：按 lot 或 tool（解析当前在制 lot）返回逐片状态 ----
  if (route === '/api/wafers') {
    const lot = u.searchParams.get('lot');
    const tool = u.searchParams.get('tool');
    let lotId = lot;
    if (!lotId && tool) { const l = engine ? engine.lots.find(l => l.curTool === tool && l.status === 'WIP') : null; lotId = l ? l.id : null; }
    if (!lotId) return json(res, 404, { error: 'no lot on tool or specified' });
    const w = engine ? engine.byLot.get(lotId) : null;
    if (!w) return json(res, 404, { error: 'lot not found' });
    const counts = {}; (w.wafers || []).forEach(x => { counts[x.status] = (counts[x.status] || 0) + 1; });
    return json(res, 200, { lot: lotId, product: w.product, status: w.status, counts,
      wafers: (w.wafers || []).map(x => ({ slot: x.slot, wafer: x.wafer, status: x.status, step: x.step, tool: x.tool })) });
  }
  // ---- 配方管理：配方库 + 当前设备配方 ----
  if (route === '/api/recipes') {
    const product = u.searchParams.get('product'); const module = u.searchParams.get('module');
    const recipes = storage.queryRecipes({ product, module });
    return json(res, 200, { count: recipes.length, recipes });
  }
  if (route === '/api/recipe') {
    const tool = u.searchParams.get('tool');
    const t = tool ? byId.get(tool) : null;
    if (!t) return json(res, 404, { error: 'unknown tool' });
    const lot = engine ? engine.lots.find(l => l.curTool === tool && l.status === 'WIP') : null;
    const product = lot ? lot.product : 'N2';
    const rec = RECIPE_BY_PM[product + ':' + t.module];
    return json(res, 200, { tool, product, module: t.module, recipe: rec ? rec.name : t.recipe, version: rec ? rec.version : 1, params: rec ? rec.params : {} });
  }
  // ---- 腔室数据历史库（趋势/回放） ----
  if (route.startsWith('/api/chambers/history')) {
    const tool = u.searchParams.get('tool');
    if (!tool) return json(res, 400, { error: 'tool required' });
    const ch = u.searchParams.get('chamber');
    const limit = Math.min(600, +(u.searchParams.get('limit') || 60));
    if (ch) return json(res, 200, { tool, chamber: ch, history: storage.queryChamberHist({ tool, chamber: ch, limit }) });
    const cm = chambers.get(tool);
    const out = {};
    if (cm) cm.snapshot().forEach(c => { out[c.ch] = storage.queryChamberHist({ tool, chamber: c.ch, limit }); });
    return json(res, 200, { tool, chambers: out });
  }
  // EAP→MES 事件桥：外部 EAP Host 推送翻译后的标准事件（真实接机时的事件入口）
  if (route === '/api/ingest' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let ev = {}; try { ev = body ? JSON.parse(body) : {}; } catch (_) {}
      const t = byId.get(ev.id);
      if (!t) return json(res, 404, { error: 'unknown tool ' + ev.id });
      // EAP lot 生命周期事件：直接流入事件总线（孪生/Audit/ERP 可见），不再被 400 拒收
      if (ev.type === 'lotStart') {
        emitEv({ type: 'lotStart', id: t.id, tool: t.id, src: 'eap', ts: Date.now() });
        return json(res, 200, { ok: true, src: 'eap', type: 'lotStart', id: t.id });
      }
      if (ev.type === 'lotDone') {
        // EAP 真实回灌：设备报完工 → 推进 WIP 引擎的 lot 生命周期（completeTool 会清看门狗，避免重复/提前完成）
        if (engine && typeof engine.completeTool === 'function') engine.completeTool(t.id);
        emitEv({ type: 'lotDone', id: t.id, tool: t.id, src: 'eap', ts: Date.now() });
        return json(res, 200, { ok: true, src: 'eap', type: 'lotDone', id: t.id });
      }
      if (ev.type === 'toolStatus' && STATUS[ev.status]) {
        t.status = ev.status;
        emitEv({ type: 'toolStatus', id: t.id, status: ev.status, src: 'eap' });
        return json(res, 200, { ok: true, src: 'eap', id: t.id, status: ev.status });
      }
      return json(res, 400, { error: 'unsupported event: ' + (ev.type || '?') });
    });
    return;
  }
  // 统一事件出口（P0-2）：外部域(ERP/WMS/Agent)经此将事件汇入 MES 事件总线（唯一真相源），
  // 由 WS 广播给所有订阅方（孪生/Audit/ERP/WMS 可见），避免各域自建事件通道造成双源不一致。
  if (route === '/api/mes/emit' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let ev = {}; try { ev = body ? JSON.parse(body) : {}; } catch (_) {}
      if (!ev || !ev.type) return json(res, 400, { error: 'event.type required' });
      emitEv({ ...ev, src: ev.src || 'external', ts: Date.now() });
      return json(res, 200, { ok: true, type: ev.type });
    });
    return;
  }
  if (route === '/api/wos') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        let cfg = {}; try { cfg = body ? JSON.parse(body) : {}; } catch (_) {}
        const wo = engine.createWO({ qty: Math.max(1, Math.min(20, cfg.qty || 3)), product: cfg.product || 'N2', dueHours: cfg.dueHours || 48, soId: cfg.soId || null, customer: cfg.customer || null,
          designId: cfg.designId || null, maskId: cfg.maskId || null, productType: cfg.productType || 'volume', passes: cfg.passes != null ? cfg.passes : null, qualification: !!cfg.qualification });
        log(`工单创建 ${wo.id} · ${wo.product} × ${wo.qty} lots`);
        return json(res, 201, { wo: engine.woView(wo) });
      });
      return;
    }
    return json(res, 200, { count: engine.wos.length, wos: engine.wos.map(w => engine.woView(w)) });
  }
  if (route === '/api/lots') {
    const st = u.searchParams.get('status');
    let lots = engine.lots;
    if (st) lots = lots.filter(l => l.status === st.toUpperCase());
    return json(res, 200, { count: lots.length, lots: lots.slice(-200).map(l => engine.lotView(l)) });
  }
  if (route.startsWith('/api/lots/')) {
    const id = decodeURIComponent(route.slice('/api/lots/'.length));
    const lot = engine.byLot.get(id);
    if (!lot) return json(res, 404, { error: 'lot not found' });
    return json(res, 200, engine.lotView(lot));
  }
  // ---------- NPI：设计到流片（Design-to-Tapeout） ----------
  if (route === '/api/designs') {
    if (req.method === 'POST') {
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => { let cfg = {}; try { cfg = body ? JSON.parse(body) : {}; } catch (_) {}
        const d = storage.insertDesign(cfg); return json(res, 201, { design: d }); });
      return;
    }
    return json(res, 200, { designs: storage.listDesigns() });
  }
  if (route.startsWith('/api/designs/')) {
    const sub = route.slice('/api/designs/'.length);
    if (sub.endsWith('/mask')) {
      const id = sub.slice(0, -'/mask'.length);
      if (req.method === 'POST') {
        let body = ''; req.on('data', c => body += c);
        req.on('end', () => { let cfg = {}; try { cfg = body ? JSON.parse(body) : {}; } catch (_) {}
          const m = storage.insertMask({ ...cfg, design_id: id }); return json(res, 201, { mask: m }); });
        return;
      }
    }
    if (req.method === 'GET') { const d = storage.getDesign(sub); return d ? json(res, 200, { design: d }) : json(res, 404, { error: 'not found' }); }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => { let cfg = {}; try { cfg = body ? JSON.parse(body) : {}; } catch (_) {}
        const d = storage.updateDesign(sub, cfg); return d ? json(res, 200, { design: d }) : json(res, 404, { error: 'not found' }); });
      return;
    }
  }
  if (route === '/api/masks') {
    const designId = u.searchParams.get('designId');
    return json(res, 200, { masks: storage.listMasks(designId) });
  }
  if (route === '/api/npi/launch') {
    if (req.method === 'POST') {
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => {
        let cfg = {}; try { cfg = body ? JSON.parse(body) : {}; } catch (_) {}
        const design = storage.getDesign(cfg.designId);
        if (!design) return json(res, 400, { error: 'design not found: ' + cfg.designId });
        const product = design.product || 'N2';
        const masks = storage.listMasks(design.id);
        const layers = (masks[0] && masks[0].layers) || 28;
        const passes = Math.max(1, Math.round(layers / 7));       // 设计工艺层数 → 重入次数（design→route 派生）
        const type = cfg.type || 'engineering';                   // engineering | tapeout | volume
        const wo = engine.createWO({ product, qty: Math.max(1, Math.min(20, cfg.qty || 1)), dueHours: cfg.dueHours || 96,
          designId: design.id, maskId: design.mask_id, productType: type, passes, qualification: type !== 'volume' });
        log(`NPI 投放 ${type} 批 ${wo.id} · 设计 ${design.id} (${product}) ×${wo.qty} · 路线 ${passes} 重入${type!=='volume'?'+资格验证':''}`);
        return json(res, 201, { wo: engine.woView(wo), route: wo.lots[0] ? wo.lots[0].route : [] });
      });
      return;
    }
    return json(res, 405, { error: 'POST only' });
  }
  if (route === '/api/npi/lots') {
    return json(res, 200, { lots: storage.listNpiLots() });
  }
  // ---------- NPI：从 LDA 设计包导入（上游设计 → 下游制造，有机衔接） ----------
  // 复用模块级 resolveLdaShelf / importLdaPackage；唯一放行门 = verification.passed（未通过 422 拒绝）。
  if (route === '/api/npi/import-lda') {
    if (req.method === 'POST') {
      let body = ''; req.on('data', c => body += c);
      req.on('end', async () => {
        let cfg = {}; try { cfg = body ? JSON.parse(body) : {}; } catch (_) {}
        try {
          let pkg = cfg.package || null, mode = cfg.shelfId ? 'shelf' : 'package';
          if (!pkg && cfg.shelfId) { pkg = await resolveLdaShelf(cfg.shelfId); if (!pkg) return json(res, 404, { error: 'LDA shelf not found: ' + cfg.shelfId }); }
          if (!pkg) return json(res, 400, { error: 'missing package_id（provide {package} DesignPackage JSON or {shelfId}）' });
          const r = await importLdaPackage(pkg, { type: cfg.type, qty: cfg.qty, dueHours: cfg.dueHours });
          storage.markLdaImported({ id: r.id, domain: r.domain, wo_id: r.wo.id, lot_id: r.wo.lots[0] && r.wo.lots[0].id });
          ldaImported.add(r.id); ldaImportCount++;
          return json(res, 201, { ok: true, mode, design: r.design, mask: r.mask, wo: engine.woView(r.wo), route: r.wo.lots[0] ? r.wo.lots[0].route : [] });
        } catch (e) { return json(res, e.code || 500, { error: 'import-lda failed: ' + e.message }); }
      });
      return;
    }
    return json(res, 405, { error: 'POST only' });
  }
  // ---------- LDA 常驻看门狗：状态查询 + 手动强制同步（首批量接入 LDA 已验证目录） ----------
  if (route === '/api/lda/sync') {
    if (req.method === 'GET') {
      return json(res, 200, {
        enabled: LDA_WATCHER, base: LDA_BASE, watchMs: LDA_WATCH_MS, burst: LDA_WATCH_BURST,
        lastSync: ldaLastSync, lastError: ldaLastError, importCount: ldaImportCount,
        knownCount: ldaImported.size, imported: storage.listLdaImported().slice(0, 50)
      });
    }
    if (req.method === 'POST') {
      ldaSyncOnce({ force: true })
        .then(r => log(`[LDA看门狗] 强制同步完成：${JSON.stringify(r)}`))
        .catch(e => log('[LDA看门狗] 强制同步失败 ' + e.message));
      return json(res, 202, { accepted: true, note: '强制扫描已在后台启动，稍后 GET /api/lda/sync 查看结果' });
    }
    return json(res, 405, { error: 'GET/POST only' });
  }
  // ---------- 分析层：跨阶段交期预测 + 根因（P3 收口） ----------
  if (route === '/api/analytics/otd') {
    const { analyzeOTD } = require('./services/predict');
    return json(res, 200, analyzeOTD(engine, storage));
  }
  if (route === '/api/analytics/npi') {
    const { analyzeNPI } = require('./services/predict');
    return json(res, 200, analyzeNPI(engine, storage));
  }
  if (route === '/api/config') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        let cfg = {}; try { cfg = body ? JSON.parse(body) : {}; } catch (_) {}
        if (cfg.rule) engine.setRule(String(cfg.rule).toUpperCase());
        if (cfg.autoWo != null) autoWo = !!cfg.autoWo;
        if (cfg.speed && cfg.speed >= 10) engine.speed = +cfg.speed;
        log(`配置更新 rule=${engine.rule} autoWo=${autoWo} speed=${engine.speed}`);
        return json(res, 200, { rule: engine.rule, autoWo, speed: engine.speed });
      });
      return;
    }
    return json(res, 200, { rule: engine.rule, autoWo, speed: engine.speed, automation: isAutomationEnabled(), rules: ['FIFO', 'SPT', 'CR', 'EDD', 'BN', 'HYBRID'] });
  }
  // ---------- 演示系统"自动化总开关"：默认关，需人为干预开启；每次重启强制关（不持久化） ----------
  if (route === '/api/admin/automation') {
    if (req.method === 'GET') return json(res, 200, {
      enabled: isAutomationEnabled(),
      note: '默认关；开启=实时仿真全开，关闭=演示闲置(冻结仿真心跳与全部自动循环，仅监控/健康检查/事件持久化运行)。env FAB_AUTOMATION=1 仅影响本次启动默认值，重启后回到关。'
    });
    if (req.method === 'POST') {
      const tok = process.env.FAB_ADMIN_TOKEN;     // 若部署时设了管理令牌，则要求头 x-fab-admin 匹配（未设则放行，仅内网可达）
      if (tok && req.headers['x-fab-admin'] !== tok) return json(res, 401, { error: 'admin token required (header x-fab-admin)' });
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        let b = {}; try { b = body ? JSON.parse(body) : {}; } catch (_) {}
        const nv = !!b.enabled;
        setAutomationEnabled(nv);
        log(`⚙ 自动化总开关被人工切换为 ${nv ? '开(实时仿真)' : '关(演示闲置/冻结)'}`);
        return json(res, 200, { ok: true, enabled: isAutomationEnabled() });
      });
      return;
    }
    return json(res, 405, { error: 'GET/POST only' });
  }
  // ---------- 一键初始化（演示干净化）：清动态数据、保留主数据 ----------
  // 动态：批次/工单/批次历史/晶圆/事件/时序/腔室/审计/量测/SPC/VM 全部清空
  // 静态保留：recipes/meta_*/tools/designs/photomasks/lda_sync/learned_params/telemetry_config
  if (route === '/api/admin/reset-demo') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    const tok = process.env.FAB_ADMIN_TOKEN;
    if (tok && req.headers['x-fab-admin'] !== tok) return json(res, 401, { error: 'admin token required (header x-fab-admin)' });
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let b = {}; try { b = body ? JSON.parse(body) : {}; } catch (_) {}
      if (b.confirm !== true) return json(res, 400, { error: 'confirm:true required（防误触）' });
      const cleared = {};
      try {
        const dynTables = ['events', 'tsdb', 'chamber_hist', 'audit_log', 'metrology', 'spc_alarm', 'vm_log', 'lots', 'wos', 'lot_hist', 'wafers'];
        for (const t of dynTables) {
          try { cleared[t] = storage.db.prepare(`DELETE FROM ${t}`).run().changes; } catch (_) {}
        }
        // 内存 WIP 引擎重置：清空在制/工单/队列/处理中/停驻/统计
        try {
          engine.lots = []; engine.wos = []; engine.byLot.clear();
          for (const k of Object.keys(engine.queues)) engine.queues[k] = [];
          engine._processing.clear(); engine._parked = [];
          engine.stats = { wip: 0, done: 0, cycSumH: 0, moves: 0, releases: 0 };
          engine.woSeq = 0; engine.lotSeq = 0;
        } catch (_) {}
        // 设备状态归位（保留设备主数据，状态回 IDLE 初始）
        try { for (const t of tools) { t.status = 'IDLE'; t._lot = null; t._hold = false; t.util = 50; t.wafers = 0; t.wph = 60; } } catch (_) {}
        storage.db.exec('VACUUM');   // 释放磁盘（DELETE 不缩文件）
        log('🧹 一键初始化完成：动态数据已清空（批次/工单/流水/事件），主数据保留');
        return json(res, 200, { ok: true, cleared });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }
  // ---------- 采集频率配置（客户可设，主数据台→采集频率；自动化关时不采集） ----------
  if (route === '/api/telemetry/config') {
    if (req.method === 'GET') return json(res, 200, { items: telemetry.all(), note: telemetry.NOTE, automation: isAutomationEnabled() });
    if (req.method === 'POST') {
      const tok = process.env.FAB_ADMIN_TOKEN;
      if (tok && req.headers['x-fab-admin'] !== tok) return json(res, 401, { error: 'admin token required (header x-fab-admin)' });
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        let b = {}; try { b = body ? JSON.parse(body) : {}; } catch (_) {}
        const r = telemetry.setAll(b.items || b);
        log(`⚙ 采集频率配置更新：${JSON.stringify(r.changed || r.error || r)}`);
        return json(res, 200, r);
      });
      return;
    }
    return json(res, 405, { error: 'GET/POST only' });
  }
  // ---------- 时序库（TSDB）数据资产接口 ----------
  if (route === '/api/tsdb/stats') {
    return json(res, 200, { total: storage.db.prepare('SELECT COUNT(*) n FROM tsdb').get().n, stats: storage.queryTsdbStats() });
  }
  if (route === '/api/tsdb/series') {
    const domain = u.searchParams.get('domain') || 'quality';
    const metric = u.searchParams.get('metric') || 'OVL';
    const tool = u.searchParams.get('tool') || undefined;
    const product = u.searchParams.get('product') || undefined;
    const limit = Math.min(2000, +(u.searchParams.get('limit') || 500));
    return json(res, 200, { domain, metric, series: storage.queryTsdb({ domain, metric, tool, product, limit }) });
  }
  if (route === '/api/tsdb/forecast') {
    const domain = u.searchParams.get('domain') || 'quality';
    const metric = u.searchParams.get('metric') || 'OVL';
    const tool = u.searchParams.get('tool') || undefined;
    const product = u.searchParams.get('product') || undefined;
    const steps = Math.min(60, Math.max(1, +(u.searchParams.get('steps') || 12)));
    const windowSize = Math.min(2000, +(u.searchParams.get('window') || 150));
    try { return json(res, 200, forecastTsdb({ domain, metric, tool, product, steps, window: windowSize })); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }
  // ---------- 主动预测告警接口 ----------
  if (route === '/api/tsdb/pred-alarms') {
    const limit = Math.min(200, +(u.searchParams.get('limit') || 30));
    const rows = storage.queryTsdb({ domain: 'engine', metric: 'pred_alarm', limit });
    return json(res, 200, { alarms: rows.map(r => ({
      ts: r.t, level: r.aux?.level, metric: r.aux?.metric, product: r.aux?.product,
      tool: r.aux?.tool, firstStep: r.aux?.firstStep, message: r.aux?.message, horizon: r.aux?.horizon,
    })) });
  }
  if (route === '/api/tsdb/pred-scan') {
    try { const alarms = predScan(); return json(res, 200, { scanned: PRED_SCAN_TARGETS.length, alarms }); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }
  // ---------- AI 自学习接口 ----------
  if (route === '/api/ai/params') {
    const learned = storage.listLearnedParams();
    const apcRow = learned.find(r => r.engine === 'apc' && r.param === 'kp');
    return json(res, 200, {
      apc: { kp: apcRow ? apcRow.value : AI_DEFAULTS.apc.kp, default: AI_DEFAULTS.apc.kp, learned: !!apcRow },
      fdc: { tools: [...fdcFactorByTool.entries()].map(([tool, factor]) => ({ tool, factor })), default: AI_DEFAULTS.fdc.thrFactor },
      vm: { reg: vm._learnedReg || null, default: AI_DEFAULTS.vm.coef },
      learned,
    });
  }
  if (route === '/api/ai/learn' && req.method === 'POST') {
    learner.run().then(report => { applyLearnedParams(); log('[AI自学习] 重算完成并即时生效'); return json(res, 200, report); })
      .catch(e => json(res, 500, { error: e.message }));
    return;
  }
  return json(res, 404, { error: 'not found' });
}

// ---------- HTTP + WS 同端口升级 ----------
const server = http.createServer(handler);
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'hello', service: 'fab-mes', version: 'M2', tools: tools.length, ts: nowISO() }));
});

// ---------- M2 WIP 引擎（工单/派工/lot 追踪），经 services/wip 注入（C9/C10） ----------
const { engine } = createWIP({ byId, tools, emitEv, storage, shouldRun: () => isAutomationEnabled() });
// 在制/工单上限可配（护栏②：队列封顶防内存无界增长）；默认 2000 lots / 500 wos
engine.maxLots = +(process.env.WIP_MAX_LOTS || 2000);
engine.maxWos = +(process.env.WIP_MAX_WOS || 500);
loadAndHydrate(engine, storage);   // C1：重启从 fab-mes.db 重建在制 WIP，主轴对账基础不丢

// 重启自愈：把遗留的 SPC 自动 Hold 批次重新挂 12s 兜底放行，避免重启后旧 Hold 永久卡死。
// 判据：status==='HOLD' 且为 SPC 性质（lot.holdReason 或晶圆级 hold_reason，均以 'SPC' 开头）；
//       人工 Hold（reason 非 SPC）不碰。当前所有 HOLD 均源于 SPC 判异 → 等价于"放行 SPC 自动 Hold"。
// 注：lots 表未存 lot 级 hold_reason（仅 wafers 表存），故判据同时看晶圆级 hold_reason。
(function selfHealHolds() {
  // 判据：status==='HOLD' 即视为需自愈的 SPC 自动 Hold。
  // 原因：lots 表未存 lot 级 hold_reason（仅 wafers 表存该列，且 holdLot 未落库），重启后 lot.holdReason 为 undefined，
  //       无法据 reason 前缀过滤。当前代码所有 HOLD 均来自 SPC 判异（server.js:184，无其他 holdLot 调用点），
  //       故"放行所有遗留 HOLD"等价于"放行 SPC 自动 Hold"。若未来引入人工 Hold，需在此加 reason 白名单过滤。
  const held = (engine.lots || []).filter(l => l.status === 'HOLD');
  let n = 0;
  for (const lot of held) {
    const id = lot.id;
    setTimeout(() => {
      const l = engine.byLot.get(id);
      if (l && l.status === 'HOLD') engine.releaseLot(id);
    }, SPC_HOLD_RELEASE_MS);
    n++;
  }
  if (n) console.log(`[自愈] 重启后重新调度 ${n} 个 SPC 自动 Hold 批次的兜底放行（${SPC_HOLD_RELEASE_MS}ms 后自动释放）`);
})();
let autoWo = true;
let autoWo_atCap = false;
let autoWoPaused = false;
const WIP_CAP = process.env.WIP_CAP ? +process.env.WIP_CAP : 240;   // 在制上限：达到即暂停自动投料，防止内存/CPU 失控
function log(msg) { gov.logger.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`); }
const autoWoLoop = () => {
  setTimeout(autoWoLoop, telemetry.get('autoWoMs'));   // 采集频率客户可配（主数据台→采集频率）
  if (!autoWo || !isAutomationEnabled()) return;   // 受自动化总开关管制：关时不自动投料
  // 空闲降频：仅在自动化已开启、且确实无用户操作超 3 分钟时暂停（满足稳态 CPU ≤10%）。
  // 注意：刚开启自动化时 server 已 gov.touch() 重置空闲计时，不会因"冷启无操作"误判暂停。
  if (gov.isIdle(IDLE_MS)) {
    if (!autoWoPaused) { autoWoPaused = true; log('⏸ 空闲(>3min 无操作) 自动投料暂停，整机降频'); }
    return;
  }
  autoWoPaused = false;
  // 在制封顶：到达上限即停，队列不再膨胀
  if (engine.stats.wip >= WIP_CAP) {
    if (!autoWo_atCap) { autoWo_atCap = true; log(`⏸ 自动投料已达在制上限 ${WIP_CAP}，暂停（避免内存/CPU 失控）`); }
    return;
  }
  autoWo_atCap = false;
  const prod = Math.random() < 0.5 ? 'N2' : 'A16';
  const wo = engine.createWO({ product: prod, qty: 3 + Math.floor(Math.random() * 3), dueHours: 24 + Math.floor(Math.random() * 49) });
  log(`自动投料 ${wo.id} · ${wo.productLabel} × ${wo.qty}（在制 ${engine.stats.wip}/${WIP_CAP}）`);
};
autoWoLoop();

server.listen(PORT, () => {
  console.log(`fab-mes (自研 EAP/MES) M3 已启动（MES核心 + SECS/GEM + E10/E58）[阶段0 多进程拆分]`);
  console.log(`  REST   : http://127.0.0.1:${PORT}/api/{health,tools,events,wip,wos,lots,lots/:id,config,e10}`);
  console.log(`  WS     : ws://127.0.0.1:${PORT}  (唯一事件源, ${TICK_MS}ms tick)`);
  console.log(`  SECS   : HSMS :${HSMS_PORT} (Select/S1F1/S2F17/S6F11, 演示设备 ${Object.keys(SECS_DEVICES).length} 台)`);
  console.log(`  MES    : WIP 引擎 ${engine.lots.length} lots · 派工规则 ${engine.rule} · 自动投料 ${AUTO_WO_MS/1000}s/工单`);
  console.log(`  孪生页 : 由门户进程托管 http://127.0.0.1:${process.env.PORTAL_PORT || 8123}/`);
  try { secs.start(); } catch (e) { log('HSMS 启动失败: ' + e.message); }
});
// 主仿真心跳：空闲(无在制加工且无操作>60s)时放慢到 5s，省 CPU；有活则满速 600ms。曲线呈锯齿（有升有降），杜绝阶梯单调上升。
function scheduleTick() {
  const processing = engine._processing ? engine._processing.size : 0;
  const noClients = (wss && wss.clients.size === 0);
  // 护栏① 空闲降频：无任何 WS 客户端 或 无操作超阈值 时，tick 放慢到 ≥5s（稳态 CPU 回落）
  const slow = (processing === 0 && (gov.isIdle(TICK_IDLE_MS) || noClients));
  const iv = slow ? Math.max(telemetry.get('tickMs'), 5000) : telemetry.get('tickMs');
  setTimeout(() => { tick(); scheduleTick(); }, iv);
}
scheduleTick();
// 演示系统"自动化总开关"订阅：开启瞬间重置空闲计时并立即唤醒一拍 tick，
// 避免"冷启无操作"被空闲降频误判为暂停；关闭时无动作（tick 自动回到冻结）。
onAutomationChange((on) => {
  if (on) {
    gov.touch();
    try { tick(); } catch (_) {}
    scheduleTick();
    const resumed = engine.resume ? engine.resume() : 0;   // 关闸期间停驻的在制批次重新入队续跑
    log(`▶ 自动化已开启：空闲计时重置，仿真心跳/自动循环恢复全速${resumed ? `，续跑停驻批次 ${resumed} 个` : ''}`);
  }
});
// 主动预测告警：进入统一并发闸门（≤2 并发 / 30s 时间预算），空闲态(>3min)跳过扫描省 CPU。
const PRED_SCAN_MS = process.env.PRED_SCAN_MS ? +(process.env.PRED_SCAN_MS) : 30000;
const PRED_IDLE_MS = process.env.PRED_IDLE_MS ? +(process.env.PRED_IDLE_MS) : 60000;
function schedulePredScan() {
  if (!isAutomationEnabled()) { setTimeout(schedulePredScan, telemetry.get('predScanMs')); return; }   // 总开关关：跳过预测扫描（保活，恢复后自动续扫）
  const idle = gov.isIdle(IDLE_MS);
  setTimeout(() => {
    // 执行前再查一次闸：即使排队期间被人为关闭，也不再启动扫描（杜绝"关后仍跑"尾巴）
    if (isAutomationEnabled() && !idle) {
      gov.runTask('predScan', () => predScan(), []).then(a => { if (a && a.length) log(`[预测告警] 自动扫描发现 ${a.length} 条预测告警`); }).catch(() => {});
    }
    schedulePredScan();
  }, idle ? Math.max(telemetry.get('predScanMs'), PRED_IDLE_MS) : telemetry.get('predScanMs'));
}
setTimeout(schedulePredScan, 20000);
// P1-4：APS 计划回填（计划→执行闭环）。改为事件驱动：仅当 WIP 指纹变化才重算；
//       空闲态(>3min 无操作)拉长到 60s。间隔客户可配；自动化关时彻底不重算（采集停）。
const APS_IDLE_MS = process.env.APS_IDLE_MS ? +(process.env.APS_IDLE_MS) : 60000;
let _apsSig = '';
function _apsSigNow() { return engine.lots.length + '|' + engine.stats.wip + '|' + tools.filter(t => t.status === 'RUN').length; }
function scheduleAps() {
  if (!isAutomationEnabled()) { setTimeout(scheduleAps, telemetry.get('apsMs')); return; }   // 自动化关：不重算（省资源）
  const idle = gov.isIdle(IDLE_MS);
  const interval = idle ? Math.max(telemetry.get('apsMs'), APS_IDLE_MS) : telemetry.get('apsMs');
  setTimeout(() => {
    try {
      const sig = _apsSigNow();
      if (sig !== _apsSig) { recomputeApsDirective(); _apsSig = sig; }   // 事件驱动：变化才算
    } catch (e) { log('APS 指令重算异常: ' + e.message); }
    scheduleAps();
  }, interval);
}
recomputeApsDirective();    // 启动即首算，确保派工指令立即可用
scheduleAps();
