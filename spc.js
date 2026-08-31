// ============================================================
//  SPC 统计过程控制引擎（S4 智能应用）
//  订阅量测事件 → 按 (product|param|tool) 建立控制图监控组
//  判异规则（L3 专业版完整 Western Electric 规则集）：
//   · 基础硬基准：规格限 USL/LSL 作为不可稀释的硬控制限（保证明显超规格必报）
//   · 动态限：样本≥5 后切换为 mean±3σ 用于趋势判异
//   阶段0 规则（保留）：
//    R1 单点超出控制限（3σ / 规格限）
//    R2 连续 9 点位于均值同侧（漂移）
//    R3 连续 6 点递增/递减（趋势）
//   L3 新增完整 Western Electric 规则集（detectWesternElectric）：
//    WE1 单点出 ±3σ；WE2 连续9点中心线同侧；WE3 连续6点单调；
//    WE4 连续14点交替上下；WE5 连续3点中2点超±2σ；WE6 连续5点中4点超±1σ
//  违反规则 → spcAlarm（由上层执行自动停线 hold/release）
// ============================================================
class SPC {
  constructor(opts = {}) {
    this.onAlarm = opts.onAlarm || null;
    this.groups = new Map();
    this.alarms = [];                                   // 最近报警（内存）
  }
  _key(ev) { return `${ev.product}|${ev.param}|${ev.tool}`; }
  onMetrology(ev) {
    const key = this._key(ev);
    let g = this.groups.get(key);
    if (!g) {
      g = { product: ev.product, param: ev.param, tool: ev.tool, unit: ev.unit,
        values: [], mean: ev.target, sd: 0, ucl: ev.usl, lcl: ev.lsl, n: 0, violated: false, lastValue: null };
      this.groups.set(key, g);
    }
    g.values.push(ev.value); if (g.values.length > 60) g.values.shift();
    g.n++;
    const vs = g.values;
    g.mean = vs.reduce((a, v) => a + v, 0) / vs.length;
    g.sd = vs.length > 1 ? Math.sqrt(vs.reduce((a, v) => a + (v - g.mean) * (v - g.mean), 0) / (vs.length - 1)) : 0;
    // 控制限双基准：① 规格限（USL/LSL）作为硬控制限，不被样本稀释，保证明显超规格必报；
    //            ② 基于基线 σ 的动态限（初始用规格限，样本≥5后切换为 3σ）用于趋势判异（R2/R3）
    const specU = ev.usl != null ? ev.usl : g.ucl;
    const specL = ev.lsl != null ? ev.lsl : g.lcl;
    g.ucl = vs.length >= 5 && g.sd > 0 ? Math.max(specU, g.mean + 3 * g.sd) : specU;
    g.lcl = vs.length >= 5 && g.sd > 0 ? Math.min(specL, g.mean - 3 * g.sd) : specL;
    g.lastValue = ev.value;

    // 判异规则
    const rules = [];
    const v = ev.value;
    if (v > g.ucl || v < g.lcl) rules.push('R1 超控制限');
    if (vs.length >= 9 && vs.slice(-9).every(x => x > g.mean)) rules.push('R2 连续9点偏上');
    if (vs.length >= 9 && vs.slice(-9).every(x => x < g.mean)) rules.push('R2 连续9点偏下');
    if (vs.length >= 6 && vs.slice(-6).every((x, i, a) => i === 0 || x > a[i - 1])) rules.push('R3 连续6点上升');
    if (vs.length >= 6 && vs.slice(-6).every((x, i, a) => i === 0 || x < a[i - 1])) rules.push('R3 连续6点下降');

    // L3 新增：Western Electric 完整规则集（基于当前点的近窗序列）
    const we = SPC.detectWesternElectric(vs, g.mean, g.sd, { specU: specU, specL: specL });
    for (const r of we) if (!rules.includes(r)) rules.push(r);

    g.violated = rules.length > 0;
    if (g.violated) {
      const alarm = { ts: Date.now(), product: ev.product, param: ev.param, tool: ev.tool, unit: ev.unit,
        value: v, mean: +g.mean.toFixed(2), ucl: +g.ucl.toFixed(2), lcl: +g.lcl.toFixed(2), rules };
      this.alarms.push(alarm);
      if (this.alarms.length > 100) this.alarms.shift();
      if (this.onAlarm) this.onAlarm(alarm);
      return alarm;
    }
    return null;
  }
  snapshot() {
    const groups = [...this.groups.values()].map(g => ({
      product: g.product, param: g.param, tool: g.tool, unit: g.unit, n: g.n,
      mean: +g.mean.toFixed(2), sd: +g.sd.toFixed(2), ucl: +g.ucl.toFixed(2), lcl: +g.lcl.toFixed(2),
      lastValue: g.lastValue, violated: g.violated,
      values: g.values.slice(),   // 真实量测样本序列（最多 60），供控制图绘制
    }));
    return { groups, alarms: this.alarms.slice().reverse() };
  }

  // ============================================================
  //  Western Electric 判异规则集（L3 专业版）
  //  入参 points：该监控组的最近量测序列（升序）
  //       mean / sd：当前均值与标准差（sd>0 才有 ±kσ 判定意义）
  //       opts.specU / opts.specL：规格限（硬基准，WE1 亦参考）
  //  返回：命中的规则描述字符串数组（可空）
  //  说明：WE1~WE3 与阶段0 R1~R3 语义对应但补全覆盖；WE4~WE6 为新增多维趋势判定
  // ============================================================
  static detectWesternElectric(points, mean, sd, opts = {}) {
    const r = [];
    if (!points || points.length === 0) return r;
    const n = points.length;
    if (sd > 0) {
      const u3 = mean + 3 * sd, l3 = mean - 3 * sd;
      const u2 = mean + 2 * sd, l2 = mean - 2 * sd;
      const u1 = mean + 1 * sd, l1 = mean - 1 * sd;
      const last = points[n - 1];
      // WE1：单点出 ±3σ（或超出规格硬限也计）
      if (last > u3 || last < l3 ||
          (opts.specU != null && last > opts.specU) || (opts.specL != null && last < opts.specL)) {
        r.push('WE1 单点超±3σ');
      }
      // WE5：连续3点中至少2点超 ±2σ
      if (n >= 3) {
        const w = points.slice(-3);
        const cnt2 = w.filter(x => x > u2 || x < l2).length;
        if (cnt2 >= 2) r.push('WE5 连续3点中2点超±2σ');
      }
      // WE6：连续5点中至少4点超 ±1σ
      if (n >= 5) {
        const w = points.slice(-5);
        const cnt1 = w.filter(x => x > u1 || x < l1).length;
        if (cnt1 >= 4) r.push('WE6 连续5点中4点超±1σ');
      }
    }
    // WE2：连续9点中心线同侧（漂移）
    if (n >= 9) {
      const w = points.slice(-9);
      if (w.every(x => x > mean)) r.push('WE2 连续9点偏上');
      else if (w.every(x => x < mean)) r.push('WE2 连续9点偏下');
    }
    // WE3：连续6点单调（递增或递减，趋势）
    if (n >= 6) {
      const w = points.slice(-6);
      let up = true, down = true;
      for (let i = 1; i < w.length; i++) {
        if (!(w[i] > w[i - 1])) up = false;
        if (!(w[i] < w[i - 1])) down = false;
      }
      if (up) r.push('WE3 连续6点上升');
      else if (down) r.push('WE3 连续6点下降');
    }
    // WE4：连续14点交替上下（周期/震荡）
    if (n >= 14) {
      const w = points.slice(-14);
      let alt = true;
      for (let i = 1; i < w.length; i++) {
        const d1 = w[i] - w[i - 1], d0 = w[i - 1] - w[i - 2];
        if (d1 === 0 || d0 === 0 || (d1 > 0) === (d0 > 0)) { alt = false; break; }
      }
      if (alt) r.push('WE4 连续14点交替上下');
    }
    return r;
  }
}

module.exports = { SPC };
