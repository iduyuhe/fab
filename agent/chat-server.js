// ============================================================
//  L1+L2+L3 对话 / 导师 / 协作副驾 Agent（零 API 成本）
//  L1 社区级：纯规则引擎，意图识别 + 场景模板 + 检索优先(实时调 REST)。
//  L2 教学级：在 L1 之上扩展"带教导师"模式——对教学/实验类问题只给
//            提示/线索/分步引导，绝不代做；基于真实 REST 状态给个性化反馈。
//  L3 协作级(COPILOT)：面向工程师的"协作副驾"——基于真实深化后的引擎
//            数据(SPC/FDC/PdM/VM/APS)做根因分析、生成处置建议与"工单草稿"
//            文本。副驾只出分析与建议，绝不替工程师执行写操作(inject/sim/
//            release/派单写库)，与导师铁律一致：提示/建议不代执行。
//  不调用任何外部 LLM API；仅只读消费 MES(:8124) / ERP(:8126) REST 端点。
//  导师铁律：教学类回复提示不代做，绝不替学生调用 /api/spc/inject 或 /api/aps/sim。
//  副驾铁律：只生成分析与建议(含工单草稿文本)，绝不调用 inject/sim/release 等写接口；
//            只读 REST、不直写 DB、不绕开事件总线(CONTRACT.md 红线)。
//  启动： node agent/chat-server.js   (默认 :8127, env AGENT_PORT 可覆盖)
// ============================================================
const http = require('http');
const path = require('path');
const fs = require('fs');
const { PLATFORM, SCENARIOS, MENU, TUTOR, LAB_EXPERIMENTS, COPILOT, ROOTCAUSE } = require('./knowledge');
const { executeAction } = require('../autonomy/executor');
const sg = require('../autonomy/safeguard');
const { WebSocket, WebSocketServer } = require('ws');

// L4 自治会话状态：记住"上一条副驾建议"的可执行动作，供 autonomyConfirm 解析
// 带 ts 新鲜度标记：仅最近 CONFIRM_WINDOW_MS 内的建议可被确认执行，避免跨轮次遗留误执行
const CONFIRM_WINDOW_MS = 5 * 60 * 1000;
const lastSuggestion = { action: null, payload: null, text: '', ts: 0 };
const CONFIRM_HINT = '（如需让副驾自动执行，可回复"确认执行"——默认需人审，且任何写操作须经安全护栏白名单。）';

const PORT = process.env.AGENT_PORT || 8127;
const MES_HTTP = process.env.MES_HTTP || 'http://127.0.0.1:8124';
const ERP_HTTP = process.env.ERP_HTTP || 'http://127.0.0.1:8126';

// ---------- 实时数据检索（只读 GET，绝不写）----------
async function getJSON(base, pathname) {
  const url = base.replace(/\/$/, '') + pathname;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    return { __error: e.message, __url: url };
  }
}

const mesh = (p) => getJSON(MES_HTTP, p);
const erp = (p) => getJSON(ERP_HTTP, p);

// ============================================================
//  P1-5 Agent 编排器串五大引擎上 OTD 主轴
//  Agent 订阅 MES 事件总线（唯一数字主线），实时维护各引擎态势缓冲，
//  使对话/编排基于「实时流」而非按需快照——把 FDC/SPC/APC/VM/APS + OTD 串成闭环视图。
// ============================================================
const MES_WS = process.env.MES_WS || 'ws://127.0.0.1:8124';
const liveEvents = [];                 // 滚动缓冲（最近 N 条主轴事件）
const LIVE_MAX = 800;
const engineCounts = {};               // 累计各引擎事件数（验证/健康用）
const ENGINE_SET = ['FDC', 'SPC', 'APC', 'VM', 'APS', 'PdM', 'OTD'];
function classifyEngine(type) {
  if (type === 'fdcAlarm' || type === 'fdcAutoResp' || type === 'fdcMetric') return 'FDC';
  if (type === 'spc' || type === 'spcAlarm' || type === 'spcInject') return 'SPC';
  if (type === 'apc' || type === 'apcSetpoint') return 'APC';
  if (type === 'vmPrediction' || type === 'vm') return 'VM';
  if (type === 'apsDirective' || type === 'apsPlan') return 'APS';
  if (type === 'pdmAlert' || type === 'pdm') return 'PdM';
  if (type === 'lotStart' || type === 'lotStepDone' || type === 'lotDone' || type === 'shipment' || type === 'delivery' || type === 'toolStatus') return 'OTD';
  return null;
}
// C5：增量编排状态——按事件类型维护结构化最近态，避免每次问答全量扫描 liveEvents
const state = {
  fdc: [], spc: [], apc: [], vm: [], aps: [], pdm: [], pred: [],
  otd: { lots: [], ships: [], dels: [] },
};
const MAX_STATE = 5;
const pushState = (arr, e) => { arr.push(e); if (arr.length > MAX_STATE) arr.shift(); };
const ORCH_HANDLERS = {
  fdcAlarm: e => pushState(state.fdc, e),
  spcAlarm: e => pushState(state.spc, e),
  apcSetpoint: e => pushState(state.apc, e),
  vmPrediction: e => pushState(state.vm, e),
  apsDirective: e => pushState(state.aps, e),
  pdmAlert: e => pushState(state.pdm, e),
  lotDone: e => pushState(state.otd.lots, e),
  shipment: e => pushState(state.otd.ships, e),
  delivery: e => pushState(state.otd.dels, e),
  predAlarm: e => { pushState(state.pred, e); maybeProactivePredAlarm(e); },
};
function ingest(ev) {
  if (!ev || !ev.type) return;
  liveEvents.push(ev);
  if (liveEvents.length > LIVE_MAX) liveEvents.shift();
  const h = ORCH_HANDLERS[ev.type];           // 增量派发到结构化状态（可扩展：新增引擎只需加一条 handler）
  if (h) h(ev);
  const eng = classifyEngine(ev.type);
  if (eng) engineCounts[eng] = (engineCounts[eng] || 0) + 1;
}
let busConnected = false;
function connectMesBus() {
  try {
    const ws = new WebSocket(MES_WS);
    ws.on('open', () => { busConnected = true; console.log('[agent] 已订阅 MES 事件总线（五大引擎 + OTD 主轴实时态势）'); });
    ws.on('message', (buf) => { try { const e = JSON.parse(buf.toString()); if (e && e.type) ingest(e); } catch (_) {} });
    ws.on('close', () => { busConnected = false; setTimeout(connectMesBus, 5000); });
    ws.on('error', () => { busConnected = false; });
  } catch (e) { busConnected = false; setTimeout(connectMesBus, 5000); }
}

// 跨引擎 + OTD 主轴实时编排视图（基于增量维护的 state，O(1) 读取，非每次全量扫描）
function liveOrchestration() {
  let s = `【实时主轴态势 · 五大引擎 + OTD（数据来自 MES 事件总线实时订阅）】\n`;
  s += `· 缓冲区：累计引擎事件 ${ENGINE_SET.filter(k => engineCounts[k]).map(k => `${k}:${engineCounts[k]}`).join(' ') || '无'}\n`;
  const fdc = state.fdc.slice(-3);
  if (fdc.length) s += `· FDC：最近判异 ${fdc.map(f => `${f.id || f.tool || '?'}(${f.below60 ? 'wph<60%' : 'score超阈'})`).join('、')} → 已自动触发 PdM 观察(fdcAutoResp/pdmAlert)。\n`;
  const spc = state.spc.slice(-3);
  if (spc.length) s += `· SPC：最近判异 ${spc.length} 条（${spc.map(a => a.tool || a.id || '?').join('、')}），需 Hold/调机。\n`;
  const apc = state.apc.slice(-3);
  if (apc.length) s += `· APC：最近 setpoint 回灌 ${apc.map(a => `${a.tool || '?'}/${a.param || ''}=${a.setpoint}`).join('；')}（VM 预测→APC 闭环驱动设备）。\n`;
  const vm = state.vm.slice(-3);
  if (vm.length) s += `· VM：最近虚拟量测 ${vm.map(v => `${v.tool || '?'}/${v.param || ''} pred=${v.pred}`).join('；')}。\n`;
  const aps = state.aps.slice(-3);
  if (aps.length) s += `· APS：最近调度指令 瓶颈=${aps.map(a => JSON.stringify(a.bottleneckMods)).join('')} 关键批次×${aps.reduce((n, a) => n + (a.criticalCount || 0), 0)}（已回填派工）。\n`;
  const pdm = state.pdm.slice(-3);
  if (pdm.length) s += `· PdM：${pdm.length} 条预测性维护观察。\n`;
  const pred = state.pred.slice(-3);
  if (pred.length) {
    const items = pred.map(p => `${p.level === 'bad' ? '⚠越界' : '⚠预警'} ${p.metric}${p.product ? '/' + p.product : ''}${p.tool ? '/' + p.tool : ''} 预测第 ${p.firstStep} 步将越界`).join('；');
    s += `· 主动预测告警：${items}。\n`;
  }
  const lots = state.otd.lots.slice(-3);
  const ships = state.otd.ships.slice(-2);
  const dels = state.otd.dels.slice(-2);
  if (lots.length || ships.length || dels.length) s += `· OTD：最近完工 ${lots.map(l => l.lot || l.id || '?').join('、') || '—'}；发运 ${ships.length} / 交付 ${dels.length}。\n`;
  const anyEng = fdc.length || spc.length || apc.length || vm.length || aps.length || pdm.length || pred.length || lots.length;
  if (!anyEng) s += `· 当前总线平静，无引擎事件。\n`;
  s += `\n跨引擎关联（数字主线）：FDC 退化→PdM 观察；VM 预测→APC 闭环回灌设备；APS 瓶颈/关键批次→派工优先。五大引擎经同一主轴驱动 OTD（接单→投料→加工→量测→发运→交付）。`;
  return s;
}

// ---------- 工具函数 ----------
function has(msg, ...keys) { return keys.some(k => msg.includes(k)); }
function errReply(label, data) {
  return `暂时无法获取${label}（数据源：${data.__url}，错误：${data.__error}）。请确认 MES/ERP 进程已启动。`;
}
function fmtMoney(n) { return '¥' + Number(n || 0).toLocaleString('zh-CN'); }

// ---------- 各意图处理器（返回 {reply, cards?, data?}）----------
async function overview() {
  const mods = PLATFORM.modules.map(m => m.name).join('、');
  const engines = PLATFORM.engines.map(e => e.name).join('、');
  return {
    reply: `${PLATFORM.name}：${PLATFORM.tagline}\n\n工艺模块：${mods}。\n五大引擎：${engines}。\n数字孪生分装备/产线/工厂三级。\n\n想深入了解哪一块？可问"怎么看孪生""五大引擎是什么""查实时 WIP"等。`,
    cards: [{ title: '可问方向', items: MENU }],
  };
}

function twinGuide() {
  const lines = PLATFORM.twins.map(t => `· ${t.level}（${t.page}）：${t.desc}`).join('\n');
  return { reply: `数字孪生三级视角：\n${lines}\n\n装备级看单机台 SPC/事件流；产线级看 WIP 与瓶颈；工厂级看全厂产能与经营视图。` };
}

function enginesGuide() {
  const lines = PLATFORM.engines.map(e => `· ${e.name}：${e.desc}\n  怎么看：${e.howto}`).join('\n');
  return { reply: `五大引擎讲解：\n${lines}` };
}

async function wipStatus() {
  const d = await mesh('/api/wip');
  if (d.__error) return { reply: errReply('WIP 快照', d) };
  const byMod = Object.entries(d.byModule || {}).map(([k, v]) => `${k}:${v}`).join('  ');
  const byProd = Object.entries(d.byProduct || {}).map(([k, v]) => `${k}:${v}`).join('  ');
  return {
    reply:
      `当前 WIP 快照（规则：${d.rule || '?'}，平均周期 ${d.avgCycleH ?? '?'}h）：\n` +
      `· 在制(lots)：${d.wip ?? '?'}  · 已完成：${d.done ?? '?'}  · 今日搬移：${d.moves ?? '?'}  · 投放：${d.releases ?? '?'}\n` +
      `· 按模块：${byMod}\n· 按产品：${byProd}`,
    data: d,
  };
}

async function toolStatus() {
  const d = await mesh('/api/tools');
  if (d.__error) return { reply: errReply('设备状态', d) };
  const bs = d.byStatus || {};
  const mods = Object.entries(d.byModule || {}).map(([k, v]) => `${k}:${v}`).join('  ');
  return {
    reply:
      `设备状态：共 ${d.total ?? '?'} 台。\n` +
      `· 运行(RUN)：${bs.RUN ?? 0}  · 空闲(IDLE)：${bs.IDLE ?? 0}  · 维护(PM)：${bs.PM ?? 0}  · 故障(DOWN)：${bs.DOWN ?? 0}\n` +
      `· 按模块：${mods}`,
    data: d,
  };
}

// 腔室级真实遥测问答（来自 /api/chambers）：指定设备看逐腔细节，否则看全厂退化概览
async function chamberStatus(msg) {
  const m = (msg || '').match(/([A-Z]{3,5})-(\d{2,3})/);
  if (m) {
    const tool = m[0];
    const d = await mesh('/api/chambers?tool=' + encodeURIComponent(tool));
    if (d.__error) return { reply: errReply('腔室遥测', d) };
    if (!d.chambers || !d.chambers.length) return { reply: `未找到设备 ${tool} 的腔室数据。` };
    let s = `设备 ${tool}（${d.profile || d.module}）逐腔室真实遥测：\n`;
    d.chambers.forEach(c => {
      const tag = c.fault > 0 ? ` ⚠退化Lv${c.fault}(偏离${c.dev.toFixed(0)}%)` : '';
      const pr = c.press >= 1 ? c.press.toFixed(0) : c.press.toFixed(3);
      s += `· ${c.ch}: 腔温${c.temp.toFixed(1)}°C / RF${c.rf > 0 ? Math.round(c.rf) + 'W' : '—'} / 气${c.gas > 0 ? c.gas.toFixed(0) : '—'} / 压${pr}Torr · ${c.state}${tag}\n`;
    });
    s += `\n（数据来自仿真引擎腔室级状态模型，随设备 RUN/IDLE 实时演进。）`;
    return { reply: s, data: d };
  }
  // 无指定设备 → 全厂退化概览
  const sum = await mesh('/api/chambers');
  if (sum.__error) return { reply: errReply('腔室概览', sum) };
  const drifted = Object.entries(sum.tools || {}).filter(([, v]) => v.drift > 0).slice(0, 8);
  let s = `全厂腔室遥测概览：共 ${sum.total ?? '?'} 台设备。\n`;
  if (drifted.length) {
    s += `当前有腔室退化的设备（共 ${drifted.length} 台，取前 8）：\n` +
      drifted.map(([k, v]) => `· ${k}（${v.n}腔·${v.active}运行·${v.drift}腔退化）`).join('\n') +
      `\n可追问如 "详尽 ETCH-015 腔室" 看逐腔细节。`;
  } else {
    s += `当前全厂腔室均运行正常，无退化报警。\n可追问具体设备，如 "ETCH-015 腔室遥测"。`;
  }
  return { reply: s, data: sum };
}

async function erpCost() {
  const [c, inv, h] = await Promise.all([erp('/api/erp/costs'), erp('/api/erp/inventory'), erp('/api/erp/health')]);
  if (c.__error) return { reply: errReply('ERP 成本', c) };
  let s = `ERP 经营视图：\n· 批次成本总数：${c.count ?? '?'}  · 总成本：${fmtMoney(c.totalCost)}  · 平均批次成本：${fmtMoney(c.avgCost)}\n`;
  if (inv && !inv.__error) s += `· 库存金额：${fmtMoney(inv.value)}\n`;
  if (h && !h.__error) s += `· ERP 与 MES 连接：${h.mesConnected ? '已连通' : '未连通'}\n`;
  const byProd = Object.entries(c.byProduct || {}).map(([k, v]) => `${k}:${v.n}批/均${fmtMoney(Math.round(v.sum / v.n))}`).join('  ');
  if (byProd) s += `· 分产品：${byProd}`;
  return { reply: s, data: { costs: c, inventory: inv, health: h } };
}

function whatifGuide() {
  return {
    reply: `what-if 仿真：在 sim.html 调整产能/节拍/投放节奏，观察 WIP、周期与瓶颈变化。\n` +
      `也可通过 APS 的 /api/aps/sim 做情景推演（前端 sim.html 已封装）。\n${PLATFORM.whatif}`,
    cards: [{ title: '相关引擎', items: PLATFORM.engines.filter(e => e.key === 'APS').map(e => e.name) }],
  };
}

function scenarioSpcCd() {
  const sc = SCENARIOS.spc_cd;
  return { reply: `${sc.title}：\n${sc.steps.join('\n')}`, cards: [{ title: '深入', items: ['查实时 SPC 报警', '看装备级孪生页'] }] };
}

function scenarioSpcRealtime() {
  return mesh('/api/spc').then(d => {
    if (d.__error) return { reply: errReply('SPC 状态', d) };
    const alarms = (d.alarms || []).slice(0, 5);
    let s = `SPC 实时状态：共 ${d.count ?? '?'} 条报警。`;
    if (alarms.length) s += '\n最近报警：\n' + alarms.map(a => `· ${a.tool || a.id || '?'} ${a.param || ''} ${a.msg || a.rule || ''}`).join('\n');
    else s += '（当前无报警）';
    return { reply: s, data: d };
  });
}

// ============================================================
//  L2 导师处理函数（提示不代做；只读检索真实状态给个性化反馈）
// ============================================================

// 读取真实 SPC 状态，判断学生是否已注入并触发 CD 报警
function readSpcState() { return mesh('/api/spc'); }

// 读取真实 APS 状态（瓶颈 / 负荷）
function readApsState() { return mesh('/api/aps'); }

// 读取真实 WIP 快照
function readWipState() { return mesh('/api/wip'); }

// 实验 A 导师：基于真实 /api/spc 判断学生是否已触发 CD 报警
async function tutorSpc(msg) {
  const exp = LAB_EXPERIMENTS.A_spc_cd;
  const d = await readSpcState();
  if (d.__error) {
    return {
      reply: `${TUTOR.prefix} ${errReply('SPC 状态', d)}\n\n（提示：导师没法替你注入——你需要自己调用 /api/spc/inject，注入 value 超过 CD 控制上限 ucl 的量测值。）`,
      cards: [{ title: '可继续问', items: TUTOR.followups.spc }],
    };
  }
  const alarms = d.alarms || [];
  const cdAlarms = alarms.filter(a => (a.param || '').toUpperCase() === 'CD');
  let statusLine;
  if (cdAlarms.length) {
    const a = cdAlarms[0];
    statusLine =
      `已检测到！你的注入已触发 CD 判异：工具 ${a.tool}，值 ${a.value}（控制上限 ucl=${a.ucl}），命中规则 [${a.rules.join('、')}]。\n` +
      `接下来请在 twin.html 确认对应设备是否被 hold（停线）。${exp.steps[3]}`;
  } else {
    statusLine =
      `目前 /api/spc 的 alarms 里还没有 CD 判异记录。README 提示：要触发报警，注入的 CD 量测值必须超过该组控制上限 ucl（通常需大于 USL）。\n` +
      `${TUTOR.spc_prompts.why_no_alarm}`;
  }
  const mis = TUTOR.spc_common_misunderstand.map(s => '· ' + s).join('\n');
  return {
    reply:
      `${TUTOR.prefix} 实验 A「${exp.name}」导师引导（不会替你注入）：\n\n` +
      `【当前真实状态】${statusLine}\n\n` +
      `【分步提示】${exp.steps.join('\n')}\n\n` +
      `【常见误区】\n${mis}\n\n` +
      `【想一想】${TUTOR.spc_prompts.how_to_alarm}`,
    cards: [{ title: '可继续问', items: TUTOR.followups.spc }],
    data: { alarmsCount: alarms.length, cdAlarms: cdAlarms.length },
  };
}

// 实验 B 导师：基于真实 /api/aps 与 /api/wip 判断瓶颈与进度
async function tutorAps(msg) {
  const exp = LAB_EXPERIMENTS.B_aps_bottleneck;
  const [aps, wip] = await Promise.all([readApsState(), readWipState()]);
  if (aps.__error) {
    return {
      reply: `${TUTOR.prefix} ${errReply('APS 状态', aps)}\n\n（提示：导师不替你跑 sim——你需要自己向 /api/aps/sim 提交 downTools 或 extraWos。）`,
      cards: [{ title: '可继续问', items: TUTOR.followups.aps }],
    };
  }
  const bn = (aps.bottleneck && aps.bottleneck[0]) || null;
  const kpi = aps.kpi || {};
  let statusLine;
  if (bn) {
    statusLine =
      `当前真实瓶颈模块是 ${bn.module}（${bn.name}），负荷率 ${bn.loadPct}%。原因：${bn.reason}\n` +
      `APS 建议：${bn.suggest}`;
  } else {
    statusLine = `当前 APS 未识别出明显瓶颈（bottleneck 为空），说明负荷较均衡。可尝试用 /api/aps/sim 制造一个瓶颈来验证冲击。`;
  }
  const mis = TUTOR.aps_common_misunderstand.map(s => '· ' + s).join('\n');
  const wipNote = wip.__error ? '' : `（当前在制 ${wip.wip ?? '?'} lots，来自 /api/wip）`;
  return {
    reply:
      `${TUTOR.prefix} 实验 B「${exp.name}」导师引导（不会替你跑 sim）：\n\n` +
      `【当前真实状态】${statusLine} ${wipNote}\n\n` +
      `【分步提示】${exp.steps.join('\n')}\n\n` +
      `【常见误区】\n${mis}\n\n` +
      `【想一想】${TUTOR.aps_prompts.how_to_bottleneck}`,
    cards: [{ title: '可继续问', items: TUTOR.followups.aps }],
    data: { bottleneckModule: kpi.bottleneckModule, bottleneckLoad: kpi.bottleneckLoad },
  };
}

// 通用导师帮助：识别学生当前步骤并给下一步
async function tutorHelp(msg) {
  const spc = await readSpcState();
  const aps = await readApsState();
  const lines = [];
  const cdAlarms = (spc.alarms || []).filter(a => (a.param || '').toUpperCase() === 'CD').length;
  const bn = (aps.bottleneck && aps.bottleneck[0]);
  lines.push(`· 实验 A（SPC 拦截 CD）：当前 CD 报警记录 ${cdAlarms} 条${cdAlarms ? '——已完成注入+判异，下一步去 twin.html 确认停线' : '——还没触发，先注入超 USL 的 CD 值'}`);
  lines.push(`· 实验 B（APS 瓶颈）：当前瓶颈 ${bn ? bn.module + '(' + bn.loadPct + '%)' : '无'}——${bn ? '下一步想怎样缓解（downTools/extraWos）？' : '先确认瓶颈模块'}`);
  return {
    reply:
      `${TUTOR.prefix} 导师总览（基于真实状态）：\n${lines.join('\n')}\n\n` +
      `${TUTOR.help_scaffold.reflection}\n${TUTOR.help_scaffold.next_step}`,
    cards: [{ title: '可继续问', items: TUTOR.followups.help }],
  };
}

// ============================================================
//  L3 协作副驾处理函数（只读 GET /api/*，绝不写）
//  区别：导师(tutor_*)面向学生提示不代做；副驾(copilot_*)面向工程师
//        给专业根因 + 处置建议 + 工单草稿，但仍不越权执行写操作。
// ============================================================

// 小工具：把 SPC 报警的 rules 文本映射到 ROOTCAUSE.scp 配置
function spcRootOf(rules) {
  const r = (rules || []).join(' ');
  if (r.includes('R1 超控制限')) return ROOTCAUSE.spc['R1 超控制限'];
  if (r.includes('R2')) return ROOTCAUSE.spc['R2'];
  if (r.includes('R3')) return ROOTCAUSE.spc['R3'];
  return ROOTCAUSE.spc._fallback;
}
// 小工具：按负荷率取瓶颈根因配置
function bnRootOf(loadPct) {
  const p = Number(loadPct) || 0;
  return ROOTCAUSE.bottleneck.find(b => p >= b.min) || ROOTCAUSE.bottleneck[ROOTCAUSE.bottleneck.length - 1];
}

// 副驾 A：SPC/FDC 报警根因分析 + 处置建议 + 工单草稿
async function copilotRootcauseSp(msg) {
  const [spc, fdc] = await Promise.all([mesh('/api/spc'), mesh('/api/fdc')]);
  if (spc.__error) return { reply: `${COPILOT.prefix} ${errReply('SPC 状态', spc)}\n${COPILOT.prefixNote}` };
  const alarms = (spc.alarms || []);
  let s = `${COPILOT.prefix} SPC 报警根因分析（数据源 /api/spc，共 ${alarms.length} 条）：\n`;
  if (!alarms.length) s += '· 当前无 SPC 报警，过程受控。\n';
  const tickets = [];
  alarms.slice(0, 8).forEach((a, i) => {
    const rc = spcRootOf(a.rules);
    const tgt = `${a.tool || '?'} / 参数 ${a.param || '?'} / 产品 ${a.product || '?'}`;
    s += `\n[报警${i + 1}] ${tgt}\n` +
      `  值=${a.value}（控制限 ucl=${a.ucl} / lcl=${a.lcl}）命中规则：[${a.rules.join('、')}]\n` +
      `  根因：${rc.cause}\n` +
      `  处置：${rc.action}\n`;
    tickets.push(COPILOT.ticketDraft({
      title: `SPC判异·${rc.ticket}·${a.tool || '?'}`, source: '/api/spc',
      priority: a.rules && a.rules.some(x => x.includes('R2') || x.includes('R3')) ? '高' : '中',
      target: tgt, cause: rc.cause, action: rc.action,
      actions: ['Hold 相关批次/机台', rc.ticket, '工程师确认后由 SPC release/调机流程执行'],
    }));
  });
  // FDC 性能退化报警（若存在）
  if (!fdc.__error && (fdc.alarms || []).length) {
    s += `\n[设备性能 FDC] 检测到 ${fdc.alarms.length} 条性能退化报警（wph 低于模块均值 60%）：\n`;
    fdc.alarms.slice(0, 5).forEach(a => {
      s += `  · ${a.tool} (${a.module}) wph=${a.wph} / 均值 ${a.avgWph} → ${ROOTCAUSE.fdc.action}\n`;
    });
    tickets.push(COPILOT.ticketDraft({
      title: `FDC性能退化排查·${fdc.alarms[0].tool}`, source: '/api/fdc',
      priority: '中', target: fdc.alarms[0].tool, cause: ROOTCAUSE.fdc.cause,
      action: ROOTCAUSE.fdc.action, actions: ['机台点检', '清腔/降负荷', '工程师确认后执行'],
    }));
  }
  if (tickets.length) s += `\n────────────\n${tickets.join('\n────────────\n')}\n────────────`;
  s += `\n${COPILOT.prefixNote}\n${CONFIRM_HINT}`;
  const srcAlarm = (spc.alarms || [])[0];
  lastSuggestion.action = srcAlarm ? 'spc.release' : null;
  lastSuggestion.payload = srcAlarm ? { tool: srcAlarm.tool } : null;
  lastSuggestion.text = s;
  lastSuggestion.ts = Date.now();
  return { reply: s, data: { spcAlarms: alarms.length, fdcAlarms: fdc.__error ? 0 : (fdc.alarms || []).length }, cards: [{ title: '可继续问', items: ['瓶颈怎么缓解？', '给个处置工单', '整体健康诊断一下', '确认执行'] }] };
}

// 副驾 B：APS 瓶颈根因 + 缓解方案 + 工单草稿
async function copilotBottleneck(msg) {
  const aps = await mesh('/api/aps');
  if (aps.__error) return { reply: `${COPILOT.prefix} ${errReply('APS 状态', aps)}\n${COPILOT.prefixNote}` };
  const bn = (aps.bottleneck || []);
  const kpi = aps.kpi || {};
  let s = `${COPILOT.prefix} 产能瓶颈分析（数据源 /api/aps）：\n` +
    `· 当前瓶颈模块：${kpi.bottleneckModule || '无'}  负荷率 ${kpi.bottleneckLoad ?? '?'}%\n` +
    `· 平均负荷 ${kpi.avgLoadPct ?? '?'}%  交期达标率 ${kpi.onTimePct ?? '?'}%  （逾期工单 ${kpi.lateWos ?? '?'}）\n`;
  if (!bn.length || bn[0].loadPct < 75) s += '· 当前无显著瓶颈，产能均衡。\n';
  const tickets = [];
  bn.filter(b => b.loadPct >= 75).forEach((b, i) => {
    const rc = bnRootOf(b.loadPct);
    s += `\n[瓶颈${i + 1}] ${b.module} (${b.name}) 负荷 ${b.loadPct}%\n` +
      `  根因：${rc.cause}\n` +
      `  系统建议：${b.suggest}\n` +
      `  副驾补充处置：${rc.action}\n`;
    tickets.push(COPILOT.ticketDraft({
      title: `产能瓶颈缓解·${b.module}`, source: '/api/aps',
      priority: b.loadPct >= 100 ? '高' : '中', target: `${b.module} (${b.name})`,
      cause: rc.cause, action: rc.action,
      actions: ['增设备/加班扩容 或 重排程转移负荷', '用 /api/aps/sim 推演验证（副驾不代跑）', '工程师确认后执行'],
    }));
  });
  if (tickets.length) s += `\n────────────\n${tickets.join('\n────────────\n')}\n────────────`;
  s += `\n${COPILOT.prefixNote}（如需验证缓解方案，请用 what-if 仿真 /api/aps/sim，副驾不会替您提交。）\n${CONFIRM_HINT}`;
  // 瓶颈场景：可执行动作为 aps.sim（推演）或 spc.release（若伴随 SPC 报警）
  const spcForBn = await mesh('/api/spc');
  const bnAlarm = (spcForBn.alarms || [])[0];
  lastSuggestion.action = bnAlarm ? 'spc.release' : 'aps.sim';
  lastSuggestion.payload = bnAlarm ? { tool: bnAlarm.tool } : { downTools: [], extraWos: [], horizon: 24 };
  lastSuggestion.text = s;
  lastSuggestion.ts = Date.now();
  return { reply: s, data: { bottleneckModule: kpi.bottleneckModule, bottleneckLoad: kpi.bottleneckLoad }, cards: [{ title: '可继续问', items: ['整体健康诊断一下', '给处置工单', 'SPC报警根因', '确认执行'] }] };
}

// 副驾 C：处置/建议/工单（通用）—— 默认综合 SPC+APS 给可派单清单
async function copilotAction(msg) {
  const [spc, aps] = await Promise.all([mesh('/api/spc'), mesh('/api/aps')]);
  if (spc.__error) return { reply: `${COPILOT.prefix} ${errReply('SPC 状态', spc)}` };
  const tickets = [];
  (spc.alarms || []).slice(0, 5).forEach(a => {
    const rc = spcRootOf(a.rules);
    tickets.push(COPILOT.ticketDraft({
      title: `SPC判异·${rc.ticket}·${a.tool || '?'}`, source: '/api/spc',
      priority: a.rules && a.rules.some(x => x.includes('R2') || x.includes('R3')) ? '高' : '中',
      target: `${a.tool} / ${a.param}`, cause: rc.cause, action: rc.action,
      actions: ['Hold 批次/机台', rc.ticket, '工程师确认后执行'],
    }));
  });
  if (!aps.__error) (aps.bottleneck || []).filter(b => b.loadPct >= 85).forEach(b => {
    const rc = bnRootOf(b.loadPct);
    tickets.push(COPILOT.ticketDraft({
      title: `产能瓶颈缓解·${b.module}`, source: '/api/aps',
      priority: b.loadPct >= 100 ? '高' : '中', target: b.module, cause: rc.cause,
      action: rc.action, actions: ['扩容/重排程', 'sim 验证', '工程师确认后执行'],
    }));
  });
  let s = `${COPILOT.prefix} 处置建议汇总（基于真实 SPC+APS 状态，待您确认派单）：\n`;
  if (!tickets.length) s += '· 当前无需要处置的报警或瓶颈，过程健康。\n';
  else s += tickets.map(t => '────────────\n' + t).join('\n') + '\n────────────';
  s += `\n${COPILOT.prefixNote}\n${CONFIRM_HINT}`;
  // 记录上一条建议：取首个报警的可释放 tool 作为可执行动作示例
  const firstAlarm = (spc.alarms || [])[0];
  lastSuggestion.action = firstAlarm ? 'spc.release' : null;
  lastSuggestion.payload = firstAlarm ? { tool: firstAlarm.tool } : null;
  lastSuggestion.text = s;
  lastSuggestion.ts = Date.now();
  return { reply: s, data: { tickets: tickets.length }, cards: [{ title: '可继续问', items: ['整体健康诊断一下', 'SPC报警根因', '瓶颈怎么缓解', '确认执行'] }] };
}

// 副驾 D：深度/综合诊断（SPC+FDC+PdM+VM+APS 整体健康 + 优先级）
async function copilotDeep(msg) {
  const [spc, fdc, pdm, vm, aps] = await Promise.all([
    mesh('/api/spc'), mesh('/api/fdc'), mesh('/api/pdm'), mesh('/api/vm'), mesh('/api/aps'),
  ]);
  const risks = [];
  const spcN = spc.__error ? 0 : (spc.alarms || []).length;
  if (spcN) risks.push({ w: spcN * 3 + 5, tag: 'SPC', txt: `${spcN} 条判异报警`, fix: '见副驾 SPC 根因分析' });
  const fdcN = fdc.__error ? 0 : (fdc.alarms || []).length;
  if (fdcN) risks.push({ w: fdcN * 2, tag: 'FDC', txt: `${fdcN} 条设备性能退化`, fix: '机台点检/清腔' });
  const pdmHigh = pdm.__error ? 0 : (pdm.highRisk || 0);
  if (pdmHigh) risks.push({ w: pdmHigh * 4, tag: 'PdM', txt: `${pdmHigh} 台设备高风险`, fix: '提前 PM' });
  const vmape = (!vm.__error && vm.stats && vm.stats.mape != null) ? vm.stats.mape : 0;
  if (vmape > 5) risks.push({ w: 2, tag: 'VM', txt: `虚拟量测偏差 MAPE=${vmape}%`, fix: '提升实体抽检' });
  let bnTxt = '无显著瓶颈', bnW = 0;
  if (!aps.__error) {
    const bl = (aps.kpi || {}).bottleneckLoad || 0;
    if (bl >= 100) { bnTxt = `瓶颈 ${aps.kpi.bottleneckModule} 过载 ${bl}%`; bnW = 10; }
    else if (bl >= 85) { bnTxt = `瓶颈 ${aps.kpi.bottleneckModule} 偏紧 ${bl}%`; bnW = 6; }
  }
  // 组装
  let s = `${COPILOT.prefix} 全厂综合健康诊断（数据源 SPC/FDC/PdM/VM/APS）：\n`;
  const healthy = !risks.length && !bnW;
  s += `· 整体态势：${healthy ? '健康，无紧急处置项。' : '存在需关注项，按优先级如下。'}\n`;
  if (spcN || fdcN) s += `· 质量侧：SPC ${spcN} 条 / FDC ${fdcN} 条；建议优先处理 R2/R3 趋势类判异与性能退化机台。\n`;
  if (!pdm.__error) s += `· 设备侧：PdM 高风险 ${pdmHigh} 台${pdmHigh ? '（' + (pdm.top || []).slice(0, 3).map(t => t.id).join('、') + '）' : ''}；VM 偏差 MAPE=${vmape}%。\n`;
  if (!aps.__error) s += `· 产能侧：${bnTxt}；交期达标率 ${aps.kpi.onTimePct ?? '?'}%。\n`;
  if (risks.length) {
    s += `\n【处置优先级（高→低）】\n` + COPILOT.healthRank(risks).map((r, i) =>
      `  ${i + 1}. [${r.tag}] ${r.txt} → ${r.fix}`).join('\n') + '\n';
    if (bnW) s += `  ${risks.length + 1}. [APS] ${bnTxt} → 扩容/重排程缓解。\n`;
  }
  s += `\n${COPILOT.prefixNote}\n（提示：SPC/FDC/PdM 报警如需缓解可分别用 /api/spc/release、/api/aps/sim 等写接口，副驾不代执行，请工程师确认后操作。）\n${CONFIRM_HINT}`;
  // 记录上一条建议：若 SPC 有报警，可执行 spc.release；否则无建议动作
  const dAlarm = (spc.alarms || [])[0];
  lastSuggestion.action = dAlarm ? 'spc.release' : null;
  lastSuggestion.payload = dAlarm ? { tool: dAlarm.tool } : null;
  lastSuggestion.text = s;
  lastSuggestion.ts = Date.now();
  return { reply: s, data: { spc: spcN, fdc: fdcN, pdmHigh, vmMape: vmape, bottleneck: bnTxt }, cards: [{ title: '可继续问', items: ['SPC报警根因', '瓶颈怎么缓解', '给处置工单', '确认执行'] }] };
}

function fallback() {
  return {
    reply: '我是一个零成本规则助手，能基于平台实时数据回答。没太理解您的问题，您可以从这些方向问我：',
    cards: [{ title: '可问的问题', items: MENU }],
  };
}

// P1-5：实时主轴编排视图（订阅 MES 总线，跨五大引擎 + OTD 串联）
function orchestrate() {
  if (!busConnected && !liveEvents.length) {
    return {
      reply: '当前尚未连上 MES 事件总线，无法给出实时主轴态势。请确认 MES 进程(:8124)已启动且总线可达。',
      cards: [{ title: '可先问', items: ['整体健康诊断一下', 'SPC报警根因'] }],
    };
  }
  return { reply: liveOrchestration(), data: { busConnected, buffered: liveEvents.length, engineCounts }, cards: [{ title: '可继续', items: ['整体健康诊断一下', 'SPC报警根因', '瓶颈怎么缓解'] }] };
}

// ---------- L4 自治：人审确认执行 ----------
// 解析上一条副驾建议的动作，经 executor 自动执行（带 confirmed=true）
async function autonomyConfirm(msg) {
  const fresh = (Date.now() - lastSuggestion.ts) <= CONFIRM_WINDOW_MS;
  if (!lastSuggestion.action || !fresh) {
    lastSuggestion.action = null; // 过期即作废，避免跨轮次遗留误执行
    return {
      reply: `${COPILOT.prefix} 当前没有待确认执行的副驾建议（或建议已过期，安全起见需重新获取）。请先问"SPC报警根因""瓶颈怎么缓解"或"给处置工单"，副驾会给出可自动执行的动作，再回复"确认执行"。\n${CONFIRM_HINT}`,
      cards: [{ title: '可先问', items: ['SPC报警根因', '瓶颈怎么缓解', '给处置工单'] }],
    };
  }
  const action = lastSuggestion.action;
  const payload = lastSuggestion.payload || {};

  const result = await executeAction({ action, payload, confirmed: true });
  let s = `${COPILOT.prefix} [自治执行·人审确认]\n`;
  s += `· 动作：${action}  端点：${sg.ACTION_ENDPOINTS[action] ? sg.ACTION_ENDPOINTS[action].path : '(未知)'}\n`;
  s += `· 参数：${JSON.stringify(payload)}\n`;
  if (result.ok) {
    s += `· 结果：✅ 已执行（MES 写端点返回成功）。\n· 响应：${JSON.stringify(result.response || {}).slice(0, 300)}\n`;
  } else if (result.blocked === 'consent') {
    s += `· 结果：⛔ 被护栏拦截（需人审）。${result.reason}\n`;
  } else if (result.blocked === 'guard') {
    s += `· 结果：⛔ 被护栏拦截（白名单/参数）。${result.reason}\n`;
  } else {
    s += `· 结果：⚠️ 执行未成功。${result.reason || ''}\n`;
  }
  s += `\n（安全策略：默认 requireExplicitConsent=${sg.requireExplicitConsent}；executor 仅接受白名单动作，绝不绕过护栏。）`;
  return { reply: s, data: { action, result }, cards: [{ title: '可继续', items: ['自治状态', '整体健康诊断一下'] }] };
}

// ---------- L4 自治：护栏/模式状态 ----------
function autonomyStatus() {
  const on = !sg.requireExplicitConsent;
  let s = `${COPILOT.prefix} [L4 自治闭环·护栏状态]\n`;
  s += `· 人审默认策略 requireExplicitConsent = ${sg.requireExplicitConsent}（${on ? '已显式关闭，可无人值守自动执行' : '默认开启，任何写操作必须 confirm'}）\n`;
  s += `· 自治白名单动作（仅这些可自动执行）：\n  - ${sg.ALLOWED_AUTO_ACTIONS.join('\n  - ')}\n`;
  s += `· 对应真实 MES 写端点：\n` +
    sg.ALLOWED_AUTO_ACTIONS.map(a => `  - ${a} → ${sg.ACTION_ENDPOINTS[a].method} ${sg.ACTION_ENDPOINTS[a].path}`).join('\n') + '\n';
  s += `· APC 先进过程控制：默认关闭（APC_ENABLED=0），仅输出建议修正量；需 APC_ENABLED=1 并经 spc.inject 闭环才真调。\n`;
  s += `· 红线：WS 源唯一(:8124)，所有执行经真实 MES POST 端点，不直写 DB、不绕开事件总线。\n`;
  s += `\n回复"确认执行"可让副驾对上一条建议自动执行（需经人审闸门与护栏）。`;
  return { reply: s, cards: [{ title: '可继续', items: ['确认执行', 'SPC报警根因'] }] };
}

// ---------- 意图识别 ----------
function recognize(msg) {
  const m = msg.toLowerCase();
  // ===== L4 自治意图（最高优先，避免被副驾/导师分支吞掉）=====
  // autonomy_confirm：仅在用户**明确确认**时才执行——必须含确认性动词
  //   （确认/同意/照做/apply/confirm/按建议做），且**排除**请求性/疑问性措辞
  //   （要/能/想/给/建议/怎么/如何/需要/可以吗）——避免"给个能自动执行的工单"
  //   这类普通建议请求被误判为确认执行（L4 安全铁律：建议≠确认）。
  const confirmVerb = has(msg, '确认执行', '确认', '同意执行', '同意', '照做', '按建议做', 'apply', 'confirm', '执行吧', '就这么办');
  const requestVerb = has(msg, '要', '能', '想', '给', '建议', '怎么', '如何', '需要', '可以吗', '吗', '？', '?');
  const isAutonomyStatusQ = has(msg, '自治', '自动执行', '闭环', '确认模式') && has(msg, '状态', '模式', '开', '关', '是否', '怎么', '情况');
  if (confirmVerb && !requestVerb && !isAutonomyStatusQ) return 'autonomy_confirm';
  // autonomy_status：自治/自动执行/模式
  if (has(msg, '自治', '自动执行', '自治模式', '闭环模式', '确认模式') && has(msg, '状态', '模式', '开', '关', '是否', '怎么', '情况'))
    return 'autonomy_status';
  // ===== L3 协作副驾意图（优先于 L2 导师判定）=====
  // 区分原则：导师用"怎么/为什么/教我"等学习词；副驾用"分析/根因/处置/建议/
  //          工单/怎么办/优化/排查/深度/综合/诊断"等工程实操词。
  // 当消息含工程实操词（即便也含"怎么"），优先判为副驾，避免被导师分支吞掉。
  const copilotKw = has(msg, '副驾', 'copilot', '工程师', '根因', '处置', '建议', '工单', '怎么办', '优化', '排查', '缓解', '诊断', '深度分析', '综合分析', '整体健康', '分析', '派单');
  const deepKw = has(msg, '深度分析', '综合分析', '整体健康', '诊断', '全厂', '综合', '整体');
  const bnKw = has(msg, '瓶颈', '产能', '负荷', '缓解', '调度', '排程', '优化');
  const actKw = has(msg, '处置', '建议', '工单', '派单', '下一步怎么办', '怎么办', '怎么做');
  const spcKw = has(msg, 'spc', '控制图', '判异', '拦截', 'cd', '漂移', '规格', '报警');
  const apsKw = has(msg, 'aps', '瓶颈', '排程', '产能', '负荷', 'what-if', 'whatif', '模拟', '仿真', '排产');
  // 副驾优先拦截（工程实操词命中即进入副驾分支）
  if (deepKw || (copilotKw && has(msg, '深度', '综合', '整体', '全厂', '诊断'))) return 'copilot_deep';
  if ((spcKw || has(msg, 'fdc', '异常', '报警')) && has(msg, '分析', '根因', '为什么发生', '怎么排查', '排查', '根因')) return 'copilot_rootcause_sp';
  if (bnKw && (copilotKw || has(msg, '缓解', '怎么办', '分析', '根因', '建议'))) return 'copilot_bottleneck';
  if (actKw && copilotKw) return 'copilot_action';
  if (copilotKw) return 'copilot_deep';

  // ===== L2 教学意图（含教学词时，仅在非副驾场景下优先）=====
  const teach = has(msg, '怎么', '为什么', '提示', '教', '实验', '下一步', '导师', '教我', '引导', '怎么做', '如何');
  // 教学词 + SPC 类词 → 导师(SPC)
  if (teach && spcKw) return 'tutor_spc';
  // 教学词 + APS 类词 → 导师(APS)
  if (teach && apsKw) return 'tutor_aps';
  // 纯教学/求助词（无明确引擎）→ 通用导师
  if (teach && has(msg, '实验', '下一步', '导师', '教我', '引导', '该做', '卡住', '不会')) return 'tutor_help';

  // P1-5：实时主轴编排（串五大引擎 + OTD）——置于 overview/engines 之前，避免被通用引擎讲解吞掉
  if (has(msg, '串起来', '编排', '主轴', '主干', '态势', '全貌', '五大引擎', '全局总览', '总览', '现在工厂', '在干嘛', '全局', '实时全貌', '主轴态势'))
    return 'orchestrate';
  if (has(msg, '概览', '介绍', '你们做', '是什么', '做什么', '平台', '关于') && !has(msg, '成本', '设备', 'wip'))
    return 'overview';
  if (has(msg, '孪生', 'twin', '装备级', '产线级', '工厂级', '怎么看'))
    return 'twin';
  if (has(msg, '引擎', 'spc', 'fdc', 'pdm', 'vm', 'aps') && !has(msg, '成本', '查设备', 'wip'))
    return 'engines';
  if (has(msg, 'cd', '漂移', '拦截') && has(msg, 'spc'))
    return 'scenario_spc_cd';
  if (has(msg, 'spc') && (has(msg, '报警', '实时', '状态', '查')))
    return 'scenario_spc_rt';
  if (has(msg, '成本', 'cost', 'erp', '库存', '金额', '经营'))
    return 'erp';
  if (has(msg, '设备', '机台', 'tool', '状态', '运行', '故障', '空闲'))
    return 'tools';
  // 腔室级真实遥测（指定设备看逐腔，否则看全厂退化概览）
  if (has(msg, '腔室', 'chamber', 'rf', '腔温', '遥测', '真空度') &&
     (has(msg, '状态', '遥测', '如何', '怎样', '什么', '查', '看', '哪些', '退化', '漂移', '报警') ||
      /[A-Z]{3,5}-\d/.test(msg)))
    return 'chamber';
  if (has(msg, 'wip', '在制', '产线', '产能', '在制品') || has(msg, '状态') && has(msg, '实时', '现在', '当前'))
    return 'wip';
  if (has(msg, 'what-if', 'whatif', '仿真', '推演', '情景'))
    return 'whatif';
  return 'fallback';
}

const HANDLERS = {
  overview, twin: twinGuide, engines: enginesGuide,
  wip: wipStatus, tools: toolStatus, erp: erpCost, chamber: chamberStatus,
  whatif: whatifGuide, scenario_spc_cd: scenarioSpcCd, scenario_spc_rt: scenarioSpcRealtime,
  // P1-5：实时主轴编排（订阅 MES 总线，跨五大引擎 + OTD 串联）
  orchestrate,
  // L2 导师意图（向下兼容，不破坏 L1）
  tutor_spc: tutorSpc, tutor_aps: tutorAps, tutor_help: tutorHelp,
  // L3 协作副驾意图（只读 GET，绝不写；向下兼容，不破坏 L1/L2）
  copilot_rootcause_sp: copilotRootcauseSp,
  copilot_bottleneck: copilotBottleneck,
  copilot_action: copilotAction,
  copilot_deep: copilotDeep,
  // L4 自治闭环：人审确认执行 + 护栏状态查询（默认需确认，只读默认）
  autonomy_confirm: autonomyConfirm,
  autonomy_status: autonomyStatus,
  fallback,
};

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'POST' && req.url.startsWith('/api/agent/chat')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let msg = '', history = [];
      try { const o = body ? JSON.parse(body) : {}; msg = (o.message || '').trim(); history = o.history || []; } catch (_) {}
      if (!msg) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ reply: '请输入您的问题。', cards: [{ title: '可问的问题', items: MENU }] })); }
      const intent = recognize(msg);
      let out;
      try { out = await HANDLERS[intent](msg); }
      catch (e) { out = { reply: '处理出错：' + e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ reply: out.reply, cards: out.cards, data: out.data, intent }));
    });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/agent/health')) {
    return res.end(JSON.stringify({ ok: true, service: 'fab-agent', port: PORT, mes: MES_HTTP, erp: ERP_HTTP, busConnected, bufferedEvents: liveEvents.length, engineCounts }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

// ---------- 副驾主动推送（不等用户问）：WebSocket 服务端 ----------
// 问答页(agent.html)连接此 WS；一旦总线出现 predAlarm 即主动把提醒推到已连接的聊天页。
const wss = new WebSocketServer({ server, path: '/api/agent/ws' });
const wsClients = new Set();
wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});
function broadcastProactive(text, data) {
  if (!wsClients.size) return;
  const payload = JSON.stringify({ type: 'proactive', text, data: data || null });
  for (const ws of wsClients) { try { ws.send(payload); } catch (_) {} }
}
// 同签名告警 5 分钟内只主动播报一次，避免自动扫描(每30s)反复刷屏
const predPushed = new Map(); // sig -> lastTs
function maybeProactivePredAlarm(e) {
  if (!e || e.type !== 'predAlarm') return;
  const sig = `${e.level}|${e.metric}|${e.product || ''}|${e.tool || ''}|${e.firstStep}`;
  const now = Date.now();
  const last = predPushed.get(sig) || 0;
  if (now - last < 5 * 60 * 1000) return;     // 5 分钟去重
  predPushed.set(sig, now);
  const where = [e.metric, e.product, e.tool].filter(Boolean).join('/');
  const verb = e.level === 'bad' ? '将越界' : '存在越界风险';
  const text =
    `⚠ 副驾主动提醒（预测告警）：${where} 预测第 ${e.firstStep} 步${verb}。\n` +
    (e.message ? e.message + '\n' : '') +
    `\n建议：提前核查该指标趋势，可在副驾问"整体健康诊断一下"或"给处置工单"获取根因与处置建议。`;
  broadcastProactive(text, e);
}

server.listen(PORT, () => {
  console.log(`fab-agent (L1 对话式 Agent · 零 API 成本) 已启动`);
  console.log(`  端口 : http://127.0.0.1:${PORT}/api/agent/chat`);
  console.log(`  MES  : ${MES_HTTP}   ERP : ${ERP_HTTP}   BUS : ${MES_WS}`);
  connectMesBus();   // P1-5：订阅 MES 事件总线，实时串五大引擎 + OTD 主轴
});
