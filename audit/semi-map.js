// ============================================================
//  SEMI 追溯映射（L4 合规审计层）
//  将平台事件类型映射到半导体行业标准条款，
//  满足 E10 设备状态 / E30 配方管理 / E87 载具控制追溯要求。
//  纯静态映射，无副作用，可被 audit/index.js 与文档复用。
// ============================================================

// ---- SEMI 标准条款定义 ----
const SEMI_TRACING = {
  E10: {
    desc: 'SEMI E10 — 设备可靠度/可用性/可维护性与状态模型',
    // 平台状态机覆盖的设备状态（Run/Idle/PM/Down + 派工派生 RUN）
    states: ['RUN', 'IDLE', 'PM', 'DOWN'],
  },
  E30: {
    desc: 'SEMI E30 — 通用设备模型(GEM) 配方管理(RMS)',
    recipeMgmt: true, // 平台保有 recipe 字段，配方加载/切换需留痕
  },
  E87: {
    desc: 'SEMI E87 — 载具(FOUP/Reticle Pod)控制与追溯',
    carrier: true,    // 平台 AMHS 事件含 foup 流转，需追溯载具移动
  },
};

// ---- 平台事件 → SEMI 条款映射 ----
// 用于审计落库时标记每条记录的 semi 归属，便于合规报表筛选。
const EVENT_TO_SEMI = {
  // E10 设备状态
  toolStatus:      ['E10'],
  toolMetric:      ['E10'],
  toolHold:        ['E10'],
  toolRelease:     ['E10'],
  // E30 配方管理（平台当前 recipe 字段变更时建议 emitEv recipeLoad，此处预留映射）
  recipeLoad:      ['E30'],
  // E87 载具控制
  amhs:            ['E87'],
  carrierMove:     ['E87'],
  // 以下写操作/工单批次流转，归 E30/E87 范畴的人机追溯（无严格单一条款，标记 E30）
  lotRelease:      ['E30'],
  lotStart:        ['E30'],
  lotStepDone:     ['E30'],
  lotDone:         ['E30'],
  lotHold:         ['E30'],
  lotReleaseHold:  ['E30'],
  // 智能引擎判异/自治动作（L4 副驾留痕，归 E30 操作追溯）
  spcAlarm:        ['E30'],
  fdcAlarm:        ['E30'],
  // 显式副驾/自治动作（logAction 调用）：建议/自动执行，归 E30 操作追溯
  copilotSuggest:  ['E30'],
  copilotAutoExec: ['E30'],
};

// 反向：条款 → 事件类型集合（供审计查询按 SEMI 过滤）
function semiOf(type) {
  return EVENT_TO_SEMI[type] || [];
}

module.exports = { SEMI_TRACING, EVENT_TO_SEMI, semiOf };
