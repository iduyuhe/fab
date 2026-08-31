// ============================================================
//  FDC 故障检测与分类引擎（S4 智能应用，L3 专业版）
//  L1/L2 演示版：server.js 内联 fdcCheck —— 单变量阈值（wph < 模块均值 60% → 记录）
//  L3 专业版新增：多变量异常检测骨架 detectMultivariate(samples)
//    采用「协方差 + 马氏距离近似」的 PCA-lite 思路：
//      1) 对多变量样本矩阵计算均值向量与协方差矩阵（含正则项防奇异）
//      2) 以马氏距离 d²=(x-μ)ᵀΣ⁻¹(x-μ) 作为异常分值（score）
//      3) top 贡献变量 = 各维度标准化残差 |z_i| 排序（近似主成分载荷贡献）
//  纯函数、无外部包依赖；可作为设备综合退化评分的增强信号。
//  注意：server.js 的 /api/fdc 返回结构（count / alarms[]）保持不变，
//        仅 alarm 对象在 L3 增加 score / contrib 字段，不删除任何原有字段。
// ============================================================

// 矩阵工具：均值向量
function meanVec(rows) {
  const d = rows[0].length;
  const m = new Array(d).fill(0);
  for (const row of rows) for (let j = 0; j < d; j++) m[j] += row[j];
  return m.map(v => v / rows.length);
}
// 协方差矩阵 + 对角正则（λ 防止 Σ 奇异，等价于 PCA 收缩）
function covMat(rows, mean, lambda = 1e-6) {
  const n = rows.length, d = mean.length;
  const C = Array.from({ length: d }, () => new Array(d).fill(0));
  for (const row of rows) {
    for (let i = 0; i < d; i++) {
      const a = row[i] - mean[i];
      for (let j = 0; j < d; j++) C[i][j] += a * (row[j] - mean[j]);
    }
  }
  for (let i = 0; i < d; i++) { for (let j = 0; j < d; j++) C[i][j] /= (n - 1 || 1); }
  for (let i = 0; i < d; i++) C[i][i] += lambda;
  return C;
}
// 2x2 / NxN 求逆（高斯消元）；这里用通用实现以兼容任意变量数
function invMat(A) {
  const n = A.length;
  const M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let j = 0; j < 2 * n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(r => r.slice(n));
}
// 马氏距离平方
function mahalanobis(x, mean, invC) {
  const d = x.length;
  let s = 0;
  for (let i = 0; i < d; i++) {
    let t = 0;
    for (let j = 0; j < d; j++) t += invC[i][j] * (x[j] - mean[j]);
    s += (x[i] - mean[i]) * t;
  }
  return Math.max(0, s);
}

// ============================================================
//  detectMultivariate(samples)
//  samples: 样本数组，每个样本 = { tool, vars:{k:v,...} } 或 数值数组
//  返回: { mean, scoreByTool:{tool:score}, contrib:{tool:[{var,weight}]}, anomalies:[{tool,score,vars}] }
//  说明：无历史基线时，用首批样本自身估计均值/协方差（在线 PCA-lite）。
//        当样本数不足（< 变量数+1）退化为单变量加权阈值（z-score 平方和）。
// ============================================================
function detectMultivariate(samples) {
  const out = { scoreByTool: {}, contrib: {}, anomalies: [] };
  if (!samples || samples.length === 0) return out;

  // 统一为 {tool, vec} 与变量名序列
  const keys = [];
  const parsed = samples.map(s => {
    const v = s.vars || (Array.isArray(s) ? s : null);
    if (Array.isArray(v)) return { tool: s.tool || 'UNK', vec: v, names: v.map((_, i) => `v${i}`) };
    const ks = Object.keys(v);
    ks.forEach(k => { if (!keys.includes(k)) keys.push(k); });
    return null;
  }).filter(Boolean);
  // 若混合结构，用统一 keys 重建向量
  const rows = parsed.length ? parsed : samples.map(s => {
    const v = s.vars || {};
    const vec = keys.map(k => +v[k] || 0);
    return { tool: s.tool || 'UNK', vec, names: keys };
  });
  if (rows.length === 0) return out;

  const dim = rows[0].vec.length;
  const names = rows[0].names;
  const mat = rows.map(r => r.vec);
  const mean = meanVec(mat);

  let invC;
  if (mat.length > dim + 1) {
    const C = covMat(mat, mean);
    invC = invMat(C);
  } else {
    // 退化：对角逆（单变量方差），等价于各维独立 z-score
    const v = new Array(dim).fill(0);
    for (const row of mat) for (let j = 0; j < dim; j++) v[j] += (row[j] - mean[j]) ** 2;
    for (let j = 0; j < dim; j++) v[j] = 1 / Math.max(1e-9, v[j] / (mat.length || 1));
    invC = Array.from({ length: dim }, (_, i) => { const r = new Array(dim).fill(0); r[i] = v[i]; return r; });
  }

  // 阈值：χ²(df) 95% 分位（Wilson-Hilferty 近似，比原 dim+2√dim 更接近统计临界值，降低误报）
  const thr = +(dim * Math.pow(1 - 2 / (9 * dim) + 1.645 * Math.sqrt(2 / (9 * dim)), 3)).toFixed(3);

  for (const r of rows) {
    const score = +mahalanobis(r.vec, mean, invC).toFixed(3);
    out.scoreByTool[r.tool] = score;
    // 各变量标准化残差贡献（|z_i|），取 top3
    const contrib = r.vec.map((x, j) => {
      const sd = Math.sqrt(Math.max(1e-9, 1 / (invC[j][j] || 1e-9)));
      return { var: names[j], weight: +(Math.abs((x - mean[j]) / sd)).toFixed(3) };
    }).sort((a, b) => b.weight - a.weight).slice(0, 3);
    out.contrib[r.tool] = contrib;
    if (score > thr) out.anomalies.push({ tool: r.tool, score, vars: r.vec });
  }
  out.threshold = +thr.toFixed(3);
  return out;
}

// ============================================================
//  FDC 引擎包装（供 server.js fdcCheck 复用，保持向后兼容）
//  assess(tool, ev, ctx) 在 L1/L2 单变量阈值基础上叠加多变量异常分值，
//  返回增强 alarm 对象（含 score / contrib），不删除原有字段。
// ============================================================
class FDC {
  constructor(opts = {}) {
    this.alarms = [];
    // per-tool 在线样本缓冲（多变量基线）：tool -> [{vars}]
    this.sampleBuf = new Map();
    this.maxBuf = opts.maxBuf || 30;   // 每设备保留最近 N 个样本估计基线
  }
  // 累积样本到在线基线缓冲（每次 toolMetric 都调用，不触发 alarm）
  feed(ev, ctx = {}, sensors = null) {
    if (!sensors || !sensors.vars) return;
    const buf = this.sampleBuf.get(ev.id) || [];
    buf.push(sensors.vars);
    if (buf.length > this.maxBuf) buf.shift();
    this.sampleBuf.set(ev.id, buf);
  }
  // ev: {id, util, wph}；ctx: {avgWph, module}；可选 sensors 为多变量向量 {vars:{k:v}}
  assess(ev, ctx = {}, sensors = null) {
    const a = {
      ts: Date.now(), tool: ev.id, module: ctx.module || null,
      wph: ev.wph, avgWph: +(ctx.avgWph || 0).toFixed(1), util: ev.util,
    };
    // 单变量阈值（L1/L2 行为保留）；阈值系数优先用 AI 自学习出的 per-tool 因子(ctx.thrFactor)，否则默认 0.6
    const factor = (ctx.thrFactor != null ? ctx.thrFactor : 0.6);
    if (ctx.avgWph && ev.wph < ctx.avgWph * factor) a.below60 = true;
    // 多变量异常分值（L3 专业版）：基于该设备在线样本基线算马氏距离
    if (sensors && sensors.vars) {
      const buf = this.sampleBuf.get(ev.id) || [];
      // 用该设备近期样本作为基线（>=2 个样本才有多变量意义）
      if (buf.length >= 2) {
        const mv = detectMultivariate(buf.map(v => ({ tool: ev.id, vars: v })));
        a.score = mv.scoreByTool[ev.id] != null ? mv.scoreByTool[ev.id] : 0;
        a.contrib = mv.contrib[ev.id] || [];
        a.mvThreshold = mv.threshold;
      } else {
        a.score = 0; a.contrib = [];   // 样本不足，基线尚未建立
      }
    }
    this.alarms.push(a);
    if (this.alarms.length > 100) this.alarms.shift();
    return a;
  }
  snapshot() { return { count: this.alarms.length, alarms: this.alarms.slice().reverse() }; }
}

module.exports = { FDC, detectMultivariate };
