'use strict';
// ============================================================
//  演示系统"自动化总开关" —— 人为干预闸门
// ------------------------------------------------------------
//  设计原则（用户明确要求）：
//   1. 默认【关】。服务器一部署/一重启，绝不自己跑任何自动循环。
//   2. 每次重启强制关：本模块【不持久化】开关状态，仅取环境变量
//      FAB_AUTOMATION 作为"本次启动默认值"。所以即便上次人工开过，
//      重启后仍回到关，必须人再开一次（最保守，杜绝无人值守空转）。
//   3. 人工干预入口：
//      · 启动默认开：环境变量 FAB_AUTOMATION=1（仅影响本次启动）。
//      · 运行时开/关：POST /api/admin/automation {"enabled":true|false}
//        （设了 FAB_ADMIN_TOKEN 则要求头 x-fab-admin 匹配）。
//   4. 关掉时冻结：仿真心跳(tick)、LDA 看门狗、自动投料、预测扫描、
//      ERP 自动接单、WMS 自动补料、ERP/WMS 事件重放 —— 全部 no-op。
//      监控(健康检查/资源观测/事件持久化/DB 保留裁剪)始终运行（近零成本）。
//   5. 手工操作（手工导入 LDA 设计、手工建工单/订单）任何时候可用，
//      被闸住的只是"自动乱跑"，不是人的主动操作。
// ============================================================
let _enabled = process.env.FAB_AUTOMATION === '1';
const _listeners = new Set();

function isAutomationEnabled() { return _enabled; }

function setAutomationEnabled(v) {
  const nv = !!v;
  if (nv === _enabled) return _enabled;
  _enabled = nv;
  for (const cb of _listeners) { try { cb(_enabled); } catch (_) {} }
  return _enabled;
}

// 订阅开关变化（服务层可在 ON/OFF 切换时做清理/日志）
function onAutomationChange(cb) {
  if (typeof cb === 'function') { _listeners.add(cb); return () => _listeners.delete(cb); }
  return () => {};
}

// 跨进程开关同步（独立进程：ERP/WMS/EAP/Agent 用）。
// MES 是开关的权威源（POST /api/admin/automation 只改 MES 进程内状态）；
// 独立进程每 syncMs 轮询一次 MES 的 /api/admin/automation 并同步到本地，
// 使"演示开闸/关闸"对整个平台一致生效（2026-09-01 发现：跨进程不同步是隐藏 bug）。
// 轮询本身极轻（10s 一次 GET），且自动化关时不额外增加采集开销。
function syncFromMes(mesHttp, syncMs = 10000) {
  if (!mesHttp) return () => {};
  let stopped = false;
  let timer = null;
  const poll = async () => {
    if (stopped) return;
    try {
      const r = await fetch(`${mesHttp}/api/admin/automation`, { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      if (typeof j.enabled === 'boolean') setAutomationEnabled(j.enabled);
    } catch (_) { /* MES 未就绪时保持本地状态，下次再试 */ }
  };
  poll();
  timer = setInterval(poll, syncMs);
  if (timer.unref) timer.unref();
  return () => { stopped = true; if (timer) clearInterval(timer); };
}

module.exports = { isAutomationEnabled, setAutomationEnabled, onAutomationChange, syncFromMes, FAB_AUTOMATION_ENV: 'FAB_AUTOMATION' };
