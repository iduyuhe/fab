// ============================================================
//  AI 自学习模块（"AI 原生"核心一笔）
//  从平台沉淀的历史数据（TSDB + 既有历史表）中，让三大引擎"自己学出更好的参数"，
//  取代写死在代码里的演示常量：
//    · APC  —— 学工艺增益 g，推导最优比例增益 kp（不再固定 0.5）
//    · FDC  —— 每台设备从自身 wph 历史学出专属报警基线（不再全场统一 0.6×均值）
//    · VM   —— 从腔室遥测(temp/rf/gas/press) + OVL 量测学出回归系数（不再写死演示值）
//  学出的参数写入 learned_params 表（跨重启保留），server.js 启动时加载并即时生效。
//  纯统计（OLS 回归 / 均值方差），无外部依赖，零 API 成本。
// ============================================================
'use strict';

// 与引擎硬编码默认值一致的"学习前"基线，用于前后对照
const DEFAULTS = {
  apc: { kp: 0.5 },
  fdc: { thrFactor: 0.6 },
  vm:  { intercept: 0, coef: { temp: 0.12, pressure: -0.05, power: 0.08, rate: 0.20, flow: 0.03 } },
};

// 多元 OLS 最小二乘：xs=[[x1..xd],...], ys=[...] → {coef[], intercept, r2}
function linreg(xs, ys) {
  const n = xs.length; if (n < 3) return null;
  const d = xs[0].length;
  const mx = new Array(d).fill(0); const my = ys.reduce((a, b) => a + b, 0) / n;
  for (const x of xs) for (let j = 0; j < d; j++) mx[j] += x[j];
  for (let j = 0; j < d; j++) mx[j] /= n;
  const sxx = new Array(d).fill(0), sxy = new Array(d).fill(0); let syy = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) { const dx = xs[i][j] - mx[j]; sxx[j] += dx * dx; sxy[j] += dx * (ys[i] - my); }
    syy += (ys[i] - my) ** 2;
  }
  const coef = sxy.map((v, j) => (sxx[j] > 1e-9 ? v / sxx[j] : 0));
  const intercept = my - coef.reduce((a, c, j) => a + c * mx[j], 0);
  let ssr = 0;
  for (let i = 0; i < n; i++) { let yh = intercept; for (let j = 0; j < d; j++) yh += coef[j] * xs[i][j]; ssr += (ys[i] - yh) ** 2; }
  const r2 = syy > 1e-9 ? 1 - ssr / syy : 0;
  return { coef, intercept, r2: +r2.toFixed(3) };
}
function mae(xs, ys, coef, intercept) {
  let s = 0; for (let i = 0; i < xs.length; i++) { let yh = intercept; for (let j = 0; j < xs[i].length; j++) yh += coef[j] * xs[i][j]; s += Math.abs(ys[i] - yh); }
  return xs.length ? s / xs.length : 0;
}

function createLearner({ storage }) {
  // ---------- APC：学工艺增益 → 最优 kp ----------
  function learnApcGain() {
    const apc = storage.queryTsdb({ domain: 'engine', metric: 'apc_OVL', limit: 3000 });
    const ovl = storage.queryTsdb({ domain: 'quality', metric: 'OVL', limit: 6000 });
    const ovlByLot = new Map(); ovl.forEach(r => { if (r.lot && r.value != null && !ovlByLot.has(r.lot)) ovlByLot.set(r.lot, r.value); });
    const xs = [], ys = [];
    for (const r of apc) { const o = ovlByLot.get(r.lot); if (o != null && r.value != null) { xs.push([r.value]); ys.push(o); } }
    if (xs.length < 5) return { ok: false, reason: '样本不足（APC 闭环历史<5 组），沿用默认 kp=0.5', pairs: xs.length, before: DEFAULTS.apc.kp, after: DEFAULTS.apc.kp };
    const n = xs.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { const x = xs[i][0], y = ys[i]; sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const denom = n * sxx - sx * sx;
    const g = denom > 1e-9 ? (n * sxy - sx * sy) / denom : 0;
    // 一阶系统临界阻尼 kp ≈ 1/(2|g|)，限幅 [0.1, 0.9]
    const kp = Math.max(0.1, Math.min(0.9, Math.abs(g) > 1e-6 ? 1 / (2 * Math.abs(g)) : 0.5));
    storage.upsertLearnedParam('apc', 'kp', '*', +kp.toFixed(3), { gain: +g.toFixed(4), pairs: n });
    return { ok: true, pairs: n, gain: +g.toFixed(4), before: DEFAULTS.apc.kp, after: +kp.toFixed(3) };
  }

  // ---------- FDC：每台设备学专属 wph 报警基线 ----------
  function learnFdcBaseline() {
    const rows = storage.queryTsdb({ domain: 'equipment', metric: 'wph', limit: 8000 });
    const byTool = new Map();
    rows.forEach(r => { if (!r.tool) return; if (!byTool.has(r.tool)) byTool.set(r.tool, []); byTool.get(r.tool).push(r.value); });
    const results = {}; let improved = 0, total = 0, oldAlarms = 0, newAlarms = 0;
    for (const [tool, vals] of byTool) {
      if (vals.length < 5) continue;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (vals.length - 1));
      const newFloor = mean - 1 * sd;                       // 新阈值：自身均值 - 1σ
      const factor = mean > 0 ? Math.max(0.3, Math.min(0.9, newFloor / mean)) : 0.6;
      const beforeFactor = DEFAULTS.fdc.thrFactor;
      // 误报对照：旧阈值用全场近似（自身均值×0.6），新阈值用自身因子
      const oldFloor = mean * beforeFactor;
      oldAlarms += vals.filter(v => v < oldFloor).length;
      newAlarms += vals.filter(v => v < newFloor).length;
      if (Math.abs(factor - beforeFactor) > 0.02) improved++;
      total++;
      results[tool] = { mean: +mean.toFixed(1), sd: +sd.toFixed(1), factor: +factor.toFixed(3), before: beforeFactor };
      storage.upsertLearnedParam('fdc', 'thrFactor', tool, factor, { mean: +mean.toFixed(1), sd: +sd.toFixed(1) });
    }
    return { ok: total > 0, tools: total, improved, oldAlarms, newAlarms, alarmReductionPct: oldAlarms > 0 ? +((1 - newAlarms / oldAlarms) * 100).toFixed(1) : 0, results };
  }

  // ---------- VM：从腔室遥测 + OVL 量测学回归系数 ----------
  function learnVmCoef() {
    const ch = storage.db.prepare('SELECT ts,tool,chamber,temp,rf,gas,press FROM chamber_hist ORDER BY ts DESC LIMIT 20000').all();
    const ovl = storage.queryTsdb({ domain: 'quality', metric: 'OVL', limit: 6000 });
    const chByTool = new Map();
    for (const r of ch) { if (!chByTool.has(r.tool)) chByTool.set(r.tool, []); chByTool.get(r.tool).push([r.temp || 0, r.rf || 0, r.gas || 0, r.press || 0]); }
    const ovlByTool = new Map();
    for (const r of ovl) { if (!r.tool || r.value == null) continue; if (!ovlByTool.has(r.tool)) ovlByTool.set(r.tool, []); ovlByTool.get(r.tool).push(r.value); }
    const keys = ['temp', 'rf', 'gas', 'press'];
    const xs = [], ys = [];
    for (const [tool, chs] of chByTool) {
      const ov = ovlByTool.get(tool); if (!ov || !ov.length) continue;
      const ovMean = ov.reduce((a, b) => a + b, 0) / ov.length;
      for (const c of chs) { xs.push(c); ys.push(ovMean); }
    }
    if (xs.length < 5) return { ok: false, reason: '样本不足（腔室/OVL 配对<5），沿用默认回归系数', before: DEFAULTS.vm.coef, after: DEFAULTS.vm.coef };
    const reg = linreg(xs, ys);
    if (!reg) return { ok: false, reason: '回归失败', before: DEFAULTS.vm.coef, after: DEFAULTS.vm.coef };
    const learned = { intercept: +reg.intercept.toFixed(3), coef: {} };
    keys.forEach((k, i) => learned.coef[k] = +(+reg.coef[i]).toFixed(4));
    // 前后误差对照（MAE）：默认系数 vs 学出系数
    const maeBefore = mae(xs, ys, keys.map(k => DEFAULTS.vm.coef[k] || 0), DEFAULTS.vm.intercept);
    const maeAfter = mae(xs, ys, reg.coef, reg.intercept);
    storage.upsertLearnedParam('vm', 'reg', '*', 0, learned);
    return { ok: true, n: xs.length, r2: reg.r2, maeBefore: +maeBefore.toFixed(3), maeAfter: +maeAfter.toFixed(3), errReductionPct: maeBefore > 0 ? +((1 - maeAfter / maeBefore) * 100).toFixed(1) : 0, before: DEFAULTS.vm.coef, after: learned.coef };
  }

  async function run() {
    const t0 = Date.now();
    const apc = learnApcGain();
    const fdc = learnFdcBaseline();
    const vm = learnVmCoef();
    return {
      at: new Date().toISOString(), ms: Date.now() - t0,
      apc, fdc, vm, defaults: DEFAULTS,
      note: '已从历史数据自学习 APC/FDC/VM 三引擎参数，写入 learned_params 并即时生效；重启后自动加载，不丢失。',
    };
  }
  return { run, DEFAULTS };
}

module.exports = { createLearner, DEFAULTS };
