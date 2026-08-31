// ============================================================
//  合规审计层装配器（L4）
//  initAudit({storage, eventbus})：
//    - 注册 eventbus.onEmit 只读订阅，将关键"写操作/状态变更"事件
//      经 storage.appendAudit 追加到不可篡改审计链。
//    - 导出 logAction() 供业务/副驾显式留痕（副驾建议、自治执行）。
//    - 导出 queryAudit() 供 REST /api/audit 查询。
//  设计原则：
//    * 仅订阅现有 emitEv，绝不新造事件（CONTRACT §8 红线）。
//    * 链式 hash 在 storage 层实现（appendAudit），本层只传记录字段。
// ============================================================
const { semiOf } = require('./semi-map');

// 经 emitEv 落下审计的事件白名单（写操作 / 状态变更 / 智能引擎判异）
// 不含纯读数事件（hello/toolMetric 的高频采样不强制留痕，但 toolMetric 亦列入 E10 范畴可选）
//
// 状态标注（2026-08-27 战略审计）：
//   · 活事件（spine 真实 emit，已落审计）：toolStatus/toolHold/toolRelease、lotRelease/lotStart/lotStepDone/
//     lotDone/lotHold/lotReleaseHold、spcAlarm/fdcAlarm、apc(由 apc/controller.js emit，顾问级无订阅者属正常)。
//   · 蓝图态/预留事件（当前 spine 尚未 emit，留在白名单以便未来接真实设备/副驾时即自动留痕，不会误触发）：
//     recipeLoad(E30 RMS 预留)、amhs/carrierMove(E87 载具流转预留)、copilotSuggest/copilotAutoExec(L4 副驾显式 logAction 亦可，非总线触发)。
//   · WMS 仓储执行域（fab-wms :8128）：wmsPick/wmsPutaway/wmsGoodsReceipt/wmsShip 已登记白名单，由 WMS 本地 wms_tx 落不可变仓储流水留痕（独立 DB，未回推 MES 总线，避免红线）。
const AUDIT_EVENTS = new Set([
  'toolStatus', 'toolHold', 'toolRelease',
  'lotRelease', 'lotStart', 'lotStepDone', 'lotDone', 'lotHold', 'lotReleaseHold',
  'recipeLoad', 'amhs', 'carrierMove',
  'spcAlarm', 'fdcAlarm',
  'copilotSuggest', 'copilotAutoExec',
  // WMS 仓储执行域（独立进程 :8128，经本地 wms_tx 留痕；未来可经 MES /api/ingest generic 并入统一审计链）
  'wmsPick', 'wmsPutaway', 'wmsGoodsReceipt', 'wmsShip',
]);

function defaultActor(ev) {
  // 设备触发的状态/指标事件 → actor 取设备 id；否则 'system'
  if (ev.id) return ev.id;
  if (ev.tool) return ev.tool;
  if (ev.lot) return ev.lot;
  return 'system';
}

function initAudit({ storage, eventbus }) {
  if (!storage || !eventbus) throw new Error('initAudit 需要 storage 与 eventbus 实例');

  // 确保审计表存在（幂等；不影响现有表）
  if (typeof storage.initAuditSchema === 'function') storage.initAuditSchema();

  // 只读订阅：现有 emitEv 出口唯一，本订阅不广播、不落 events 表、不新造事件
  const off = eventbus.onEmit(ev => {
    try {
      if (!ev || !ev.type) return;
      if (!AUDIT_EVENTS.has(ev.type)) return;
      const target = ev.id || ev.lot || ev.tool || ev.foup || null;
      storage.appendAudit({
        tenant: 'default',
        actor: defaultActor(ev),
        action: ev.type,
        target,
        payload: ev,
        semi: semiOf(ev.type),
      });
    } catch (e) {
      // 审计失败不影响主业务流程（订阅异常隔离，与 eventbus 行为一致）
      console.error('[audit] appendAudit 失败(已忽略): ' + e.message);
    }
  });

  // 业务/副驾显式留痕：actor 默认 system，action 自由定义
  function logAction({ actor = 'system', action, target = null, payload = {}, semi = [] } = {}) {
    if (!action) throw new Error('logAction 需要 action');
    return storage.appendAudit({
      tenant: 'default',
      actor,
      action,
      target,
      payload: typeof payload === 'string' ? { note: payload } : payload,
      semi: Array.isArray(semi) ? semi : (semi ? [semi] : []),
    });
  }

  function queryAudit(opts = {}) {
    if (typeof storage.queryAudit !== 'function') return [];
    return storage.queryAudit(opts);
  }

  return { off, logAction, queryAudit };
}

module.exports = { initAudit };
