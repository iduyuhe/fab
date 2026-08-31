// ============================================================
//  VM 虚拟量测引擎（S3 智能引擎）
//  用工艺上下文预测即将发生的量测值，减少实物量测：
//    - lot 开始 METRO 加工 → 按 (product|param|tool) 的 EWMA 历史均值预测（vmPrediction 事件）
//    - 实际 metrology 到达 → 对比误差并更新模型（vmResult 事件 + vm_log 落库）
//  冷启动：无历史时用工艺 target 作为基线
//  L3 专业版新增：predictVirtual(tool, sensors) 回归虚拟量测
//    用预置线性系数，从易测传感器（如温度/压力/功率/速率）回归预测
//    难测参数；返回 predicted / residual（相对工艺 target 的残差）。
// ============================================================
const ALPHA = 0.3;                                  // EWMA 平滑系数

// 预置回归系数（演示用，按 tool/module 可扩展）：
//  难测参数 y = intercept + Σ coef_i × sensor_i
//  这里给一个通用默认系数集，覆盖常见传感器字段。
const DEFAULT_REG = {
  intercept: 0,
  coef: { temp: 0.12, pressure: -0.05, power: 0.08, rate: 0.20, flow: 0.03 },
  // 对应难测参数的工艺 target（用于残差基准），可由调用方覆盖
};

class VMPredictor {
  constructor() {
    this.models = new Map();        // `${product}|${param}|${tool}` -> {mean, n}
    this.log = [];                  // 预测结果（内存 + server 落库）
    this.regModels = new Map();     // `${tool}|${param}` -> 回归系数（支持在线微调）
    this._learnedReg = null;        // AI 自学习出的全局回归系数 {intercept, coef}
  }
  // AI 自学习：注入从历史学出的回归系数（覆盖默认演示值）
  setReg(reg) {
    if (reg && reg.coef) this._learnedReg = { intercept: reg.intercept || 0, coef: reg.coef };
  }
  _key(product, param, tool) { return `${product}|${param}|${tool}`; }
  // lot 进入 METRO 时：预测该 lot 各参数（params 来自调用方传入的产品参数定义）
  predict(lotId, product, tool, params) {
    return params.map(p => {
      const m = this.models.get(this._key(product, p.param, tool));
      const pred = m ? +(m.mean).toFixed(2) : p.target;
      return { lot: lotId, product, tool, param: p.param, unit: p.unit, pred, target: p.target, cold: !m };
    });
  }
  // 实际量测到达：记录对比并更新模型
  record(ev) {
    const m = this.models.get(this._key(ev.product, ev.param, ev.tool));
    const model = m ? { mean: ALPHA * ev.value + (1 - ALPHA) * m.mean, n: m.n + 1 } : { mean: ev.value, n: 1 };
    this.models.set(this._key(ev.product, ev.param, ev.tool), model);
    return model;
  }
  // 精度统计（基于已对比结果）
  stats(results) {
    const n = results.length;
    if (!n) return { n: 0 };
    const mape = results.reduce((a, r) => a + (r.actual !== 0 ? Math.abs(r.errPct) : 0), 0) / n;
    const hit3 = results.filter(r => Math.abs(r.errPct) <= 3).length;
    const hit5 = results.filter(r => Math.abs(r.errPct) <= 5).length;
    return { n, mape: +mape.toFixed(2), hit3Pct: +(100 * hit3 / n).toFixed(1), hit5Pct: +(100 * hit5 / n).toFixed(1) };
  }

  // ============================================================
  //  predictVirtual(tool, sensors, opts) — 回归虚拟量测（L3）
  //  sensors: { temp, pressure, power, rate, flow, ... } 易测传感器读数
  //  opts: { param, target, coef, intercept }
  //    param  难测参数名（用于回归系数缓存键）
  //    target 工艺目标值（残差基准）
  //    coef/interct 可选覆盖默认回归系数
  //  返回: { tool, param, predicted, residual, sensorsUsed }
  //  说明：纯线性回归，系数可在线累积微调（演示骨架，不依赖外部包）。
  // ============================================================
  predictVirtual(tool, sensors = {}, opts = {}) {
    const param = opts.param || 'VIRTUAL';
    const key = `${tool}|${param}`;
    let reg = this.regModels.get(key);
    if (!reg) {
      // 优先用 AI 自学习出的全局回归系数；否则回退到写死演示值
      reg = this._learnedReg
        ? { intercept: this._learnedReg.intercept, coef: { ...this._learnedReg.coef, ...(opts.coef || {}) }, target: opts.target != null ? opts.target : 0 }
        : { intercept: opts.intercept != null ? opts.intercept : DEFAULT_REG.intercept, coef: { ...DEFAULT_REG.coef, ...(opts.coef || {}) }, target: opts.target != null ? opts.target : 0 };
      this.regModels.set(key, reg);
    }
    // 线性回归求和
    let y = reg.intercept;
    const used = [];
    for (const k of Object.keys(reg.coef)) {
      if (sensors[k] != null) { y += reg.coef[k] * sensors[k]; used.push(k); }
    }
    const predicted = +y.toFixed(3);
    const target = opts.target != null ? opts.target : reg.target;
    const residual = +(predicted - target).toFixed(3);
    return { tool, param, predicted, residual, target, sensorsUsed: used };
  }
}

module.exports = { VMPredictor };
