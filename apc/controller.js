// ============================================================
//  L4 先进过程控制 (apc/controller.js)
//  核心：基于 VM 虚拟量测预测值 + 反馈闭环，自动微调设备/量测参数，
//        使过程均值回归工艺 target（演示用偏移补偿 / PID 控制律）。
//  默认安全：APC 默认开启（闭环微调生效）；仅当显式 APC_ENABLED=0 才降级为"仅建议"。
//            与 bin/start-community.sh 的 APC_ENABLED=1 一致，消除"验收态≠默认态"误判。
//  与现有架构衔接：读 GET /api/vm（真实 VM 预测），写走白名单 inject。
//  零 API 成本：纯规则计算，不调外部 LLM。
// ============================================================
'use strict';

const sg = require('../autonomy/safeguard');

// APC 启用开关：默认开启（闭环微调真实生效）；显式 APC_ENABLED=0 才降级为"仅建议"
const APC_ENABLED = process.env.APC_ENABLED !== '0';

// 控制律参数（演示用，保守增益，防止过调）
const DEFAULT_KP = 0.5;       // 比例增益（偏移补偿）
const DEFAULT_DEADBAND = 0.05; // 死区：残差绝对值小于此比例(tool 相对 target)不调

// AI 自学习覆盖：经 learner 从 APC 闭环历史学出的最优 kp（null=沿用默认 0.5）
let learnedKp = null;
function setLearnedKp(v) { learnedKp = (typeof v === 'number' && isFinite(v)) ? v : null; }

// 控制律：偏移补偿（含死区），可扩展为 PID
// 输入：predicted 当前预测值，target 工艺目标，opts { kp, deadband }
// 返回：{ adjust, residual, inDeadband, law }
function apcAdvise(tool, predicted, target, opts = {}) {
  const kp = opts.kp != null ? opts.kp : (learnedKp != null ? learnedKp : DEFAULT_KP);
  const deadband = opts.deadband != null ? opts.deadband : DEFAULT_DEADBAND;
  const targetValid = typeof target === 'number' && target !== 0;
  const scale = targetValid ? Math.abs(target) : 1;
  const residual = +(predicted - target).toFixed(4);
  const rel = scale ? residual / scale : 0; // 相对残差
  const inDeadband = Math.abs(rel) <= deadband;
  // 修正量 = 反向补偿预测偏差（比例控制）；死区内不动
  const adjust = inDeadband ? 0 : +( -kp * residual ).toFixed(4);
  return {
    tool,
    predicted,
    target,
    residual,
    relResidual: +rel.toFixed(4),
    adjust,                 // 建议修正量（加到设备设定/补偿量测）
    inDeadband,
    law: `offset-compensate P(kp=${kp}, deadband=${deadband})`,
    enabled: APC_ENABLED,
  };
}

// 创建 APC 控制器实例：注入 mesh(只读 GET) 与 emitEv（事件总线唯一出口）
function createApc({ mesh, emitEv } = {}) {
  if (!mesh) throw new Error('createApc 需要 mesh（只读 GET）');
  if (!emitEv) throw new Error('createApc 需要 emitEv（事件总线唯一出口）');

  // 单步：读取某 tool 的 VM 预测，计算建议修正量，按需闭环
  // tool: 机台；param: 参数；target: 工艺目标；predicted: 可由调用方给，否则读 /api/vm
  async function step({ tool, param, target, predicted, product, lot }) {
    let pred = predicted;
    if (pred == null) {
      const vm = await mesh('/api/vm');
      // /api/vm 返回最近若干预测记录；取该 tool 的最新一条 predicted
      const rows = (vm && vm.results) || [];
      const hit = rows.filter(r => r.tool === tool).slice(-1)[0];
      pred = hit ? hit.pred : null;
    }
    if (pred == null) {
      const advice = { tool, param, target, error: '无 VM 预测数据，跳过' };
      emitEv({ type: 'apc', stage: 'skip', ...advice });
      return advice;
    }
    const advice = apcAdvise(tool, pred, target, {});
    emitEv({ type: 'apc', stage: 'advise', ...advice });

    // 仅在显式开启且偏差超死区时，经白名单真实 inject 闭环微调
    if (APC_ENABLED && !advice.inDeadband) {
      const g = sg.guard('spc.inject', { tool, param, value: advice.adjust });
      if (g.ok) {
        // P1-2：APC 收敛后的 setpoint 经主轴事件下发，由 EAP 经 S2F41 真实回灌设备（而非仅展示）
        const setpoint = +( (target || 0) + advice.adjust ).toFixed(4);
        emitEv({ type: 'apcSetpoint', tool, param, predicted: pred, target, adjust: advice.adjust,
                 setpoint, product, lot, source: 'apc', ts: Date.now() });
        // 真实闭环：把修正量作为一次量测注入（演示用，触发反馈修正）
        // 注意：依赖 server.js POST /api/spc/inject，已核对存在
        try {
          const r = await fetch(
            `${process.env.MES_HTTP || 'http://127.0.0.1:8124'}${g.endpoint.path}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(g.endpoint.build({ tool, param, value: advice.adjust, product, lot, source: 'apc' })) }
          );
          const res = await r.json().catch(() => ({}));
          emitEv({ type: 'apc', stage: 'inject', ok: r.ok, ...advice, response: res });
          return { ...advice, executed: r.ok, response: res };
        } catch (e) {
          emitEv({ type: 'apc', stage: 'inject-error', reason: e.message, ...advice });
          return { ...advice, executed: false, error: e.message };
        }
      }
      // 护栏拒绝则仅建议不调
      emitEv({ type: 'apc', stage: 'guard-blocked', reason: g.reason, ...advice });
      return { ...advice, executed: false, blocked: g.reason };
    }
    // 默认关：仅建议，不真调
    return { ...advice, executed: false, note: APC_ENABLED ? 'deadband 内，无需调整' : 'APC 已显式关闭(APC_ENABLED=0)，仅输出建议修正量' };
  }

  return { step, apcAdvise, setLearnedKp, enabled: APC_ENABLED };
}

module.exports = { createApc, apcAdvise, setLearnedKp, APC_ENABLED, DEFAULT_KP, DEFAULT_DEADBAND };
