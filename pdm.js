// ============================================================
//  PdM 预测性维护引擎（S3 智能引擎）
//  输入：设备状态(E10 累计 + tools 指标) → 输出：故障风险评分与建议
//  风险 = 0.25×利用率 + 0.25×加工磨损 + 0.20×故障次数 + 0.15×停机时长 + 0.15×当前状态
//  全部按全局归一化；可作为"哪台设备最可能下一台故障"的决策依据
//  L3 专业版新增：estimateRUL(tool) 剩余寿命估算
//    基于运行时长 / 累计告警次数 / 振动趋势（演示用非线性退化模型）
//    返回 { rulHours, riskLevel, degradation }，纳入 assess 的每行返回，不删原有字段。
// ============================================================

// 设备设计寿命基准（小时，演示值；可按设备类别扩展）
const DESIGN_LIFE_H = { LITHO: 60000, ETCH: 80000, DEP: 80000, CMP: 70000, IMPL: 75000, METRO: 90000 };
// 振动趋势恶化系数阈值（演示）— 每单位增量对 RUL 的折损
const VIB_DEGRAD_RATE = 0.35;

class PdMEngine {
  // e10Dev: e10.dev (Map toolId -> {module, time, downCount, downSec})
  // tools:  设备数组（id/module/status/util/wafers/wph）
  // 可选 rulCtx: 设备运行上下文 Map toolId -> { runHours, vibTrend }
  //   runHours  已运行小时（无则从 wafers 近视估计）
  //   vibTrend  近期振动斜率（>0 恶化，演示单位 1e-3 g/step）
  assess(e10Dev, tools, rulCtx = new Map()) {
    const t = tools;
    const maxWafers = Math.max(1, ...t.map(x => x.wafers || 0));
    const maxDown = Math.max(1, ...t.map(x => (e10Dev.get(x.id) || {}).downCount || 0));
    const maxDownSec = Math.max(1, ...t.map(x => (e10Dev.get(x.id) || {}).downSec || 0));
    const rows = t.map(x => {
      const d = e10Dev.get(x.id) || {};
      const utilPct = (x.util || 0) / 100;
      const wear = (x.wafers || 0) / maxWafers;
      const downHist = (d.downCount || 0) / maxDown;
      const downTime = (d.downSec || 0) / maxDownSec;
      const stateRisk = x.status === 'DOWN' ? 1 : x.status === 'PM' ? 0.3 : 0;
      const risk = 0.25 * utilPct + 0.25 * wear + 0.20 * downHist + 0.15 * downTime + 0.15 * stateRisk;
      const rul = this.estimateRUL(x, d, rulCtx.get(x.id) || {});
      return { id: x.id, module: x.module, status: x.status, util: x.util, wafers: x.wafers,
        downCount: d.downCount || 0, downSec: d.downSec || 0, risk: +risk.toFixed(3),
        rulHours: rul.rulHours, rulRisk: rul.riskLevel, rulDegradation: rul.degradation,
        suggest: risk > 0.7 ? 'PROACTIVE_PM' : risk > 0.45 ? 'INSPECT' : 'NORMAL',
        suggestText: risk > 0.7 ? '提前维护' : risk > 0.45 ? '检查/监控' : '正常' };
    });
    rows.sort((a, b) => b.risk - a.risk);
    const byModule = {};
    rows.forEach(r => { byModule[r.module] = (byModule[r.module] || 0) + r.risk; });
    return { generated: Date.now(), top: rows.slice(0, 10), count: rows.length,
      highRisk: rows.filter(r => r.risk > 0.7).length,
      byModule: Object.entries(byModule).map(([k, v]) => ({ module: k, totalRisk: +v.toFixed(2) })).sort((a, b) => b.totalRisk - a.totalRisk) };
  }

  // ============================================================
  //  estimateRUL(tool, e10Rec, ctx) — 剩余寿命估算（L3）
  //  退化模型（演示用，非线性）：
  //    baseLife = DESIGN_LIFE_H[module]（默认 80000）
  //    consumed  = runHours（缺省以 wafers×单步时长近似）
  //    wearRate  = 1 + 0.15×downCount + VIB_DEGRAD_RATE×max(0,vibTrend)
  //    effective = consumed × wearRate
  //    degradation = clamp(effective / baseLife, 0..1)
  //    rulHours  = max(0, (baseLife - effective))
  //    riskLevel = 退化率映射：>0.8 HIGH / >0.6 MED / else LOW
  // ============================================================
  estimateRUL(tool, e10Rec = {}, ctx = {}) {
    const baseLife = DESIGN_LIFE_H[tool.module] || 80000;
    const runHours = ctx.runHours != null ? ctx.runHours
      : (tool.wafers || 0) * (tool.avgStepH || 2);            // 近似：晶圆数 × 单步时长
    const downCount = (e10Rec && e10Rec.downCount) || 0;
    const vibTrend = ctx.vibTrend != null ? ctx.vibTrend : 0; // 演示：外部传感趋势
    const wearRate = 1 + 0.15 * downCount + VIB_DEGRAD_RATE * Math.max(0, vibTrend);
    const effective = runHours * wearRate;
    const degradation = Math.min(1, Math.max(0, effective / baseLife));
    const rulHours = +Math.max(0, baseLife - effective).toFixed(0);
    const riskLevel = degradation > 0.8 ? 'HIGH' : degradation > 0.6 ? 'MED' : 'LOW';
    return { rulHours, riskLevel, degradation: +degradation.toFixed(3), wearRate: +wearRate.toFixed(2) };
  }
}

module.exports = { PdMEngine };
