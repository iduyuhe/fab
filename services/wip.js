// ============================================================
//  WIP 服务（§6.2 / C9）：包 WIPEngine 实例化 + persist 持久化钩子。
//  persist 绑定 storage（原 server.js:597-603）。
//  server.js 通过本模块注入 engine 与 persist，删除原内联实例化。
// ============================================================
const { WIPEngine } = require('../core');

// safe: DB 写异常隔离，不阻塞事件循环（与原 server.js 一致）
const safe = fn => { try { fn(); } catch (e) { console.log('DB 写异常(已忽略): ' + e.message); } };

function createWIP({ byId, tools, emitEv, storage, shouldRun }) {
  const persist = {
    woCreate: wo => safe(() => storage.insertWO(wo)),
    lotCreate: lot => safe(() => storage.insertLot(lot)),
    lotUpdate: lot => safe(() => storage.updateLot(lot)),
    lotStepDone: (lotId, h) => safe(() => storage.insertLotHist(lotId, h)),
    waferCreate: (lot, wafers) => safe(() => storage.insertWafers(lot.id, wafers)),
    waferUpdate: lot => safe(() => storage.updateWafersByLot(lot.id, lot.wafers)),
  };
  const engine = new WIPEngine(byId, tools, emitEv, { rule: 'HYBRID', speed: 180, persist, shouldRun });
  return { engine, persist };
}

// C1：重启重建 —— 从 fab-mes.db 读回在制/暂停批次，重建内存 WIP 引擎，
// 使 OTD / NPI 主轴在 MES 重启后仍能对账（否则内存 WIP 为空，ERP/WMS 对账基础坍塌）。
// 只读重建：增量重放 route（由 meta_routes 派生）、wafers（由 wafers 表）、soId/customer（lots 列）。
function loadAndHydrate(engine, storage) {
  if (!storage || !storage.queryActiveLots) return 0;
  try {
    const rows = storage.queryActiveLots();
    if (!rows.length) return 0;
    const baseRoutes = {};
    let n = 0;
    for (const r of rows) {
      if (engine.byLot.has(r.id)) continue;
      const base = (baseRoutes[r.product] || (baseRoutes[r.product] = (storage.queryRouteForProduct ? storage.queryRouteForProduct(r.product) : [])));
      let route = base.slice();
      const target = (r.step || 0) + (r.rem != null ? r.rem : 0);
      while (route.length < target && base.length) route = route.concat(base);
      route = route.slice(0, target);
      const wafers = storage.queryWafers ? storage.queryWafers(r.id) : null;
      const lot = {
        id: r.id, wo: r.wo, product: r.product, productLabel: r.productLabel,
        route, step: r.step || 0, rem: r.rem != null ? r.rem : (route.length - (r.step || 0)),
        status: r.status || 'WIP', due: new Date(r.due).getTime(), created: new Date(r.created).getTime(),
        hist: [], curTool: null, curStart: null, _pt: 0,
        wafers: wafers ? wafers.map(w => ({ slot: w.slot, wafer: w.wafer, status: w.status, step: w.step || 0, tool: w.tool || null, holdReason: w.hold_reason || null })) : null,
        soId: r.soId || null, customer: r.customer || null,
        designId: r.designId || null, maskId: r.maskId || null, productType: r.productType || 'volume',
      };
      engine.lots.push(lot); engine.byLot.set(lot.id, lot);
      if (lot.status === 'WIP' && route[lot.step] != null) engine._enqueue(lot, route[lot.step]);
      n++;
    }
    // 重新统计在制数（避免与运行期 createWO 双计；本函数仅启动期调用一次）
    engine.stats.wip = engine.lots.filter(l => l.status === 'WIP').length;
    if (n) console.log(`[WIP] 重启重载 ${n} 批在制(lots) 自 fab-mes.db，主轴对账基础已恢复`);
    return n;
  } catch (e) { console.log('[WIP] 重启重载异常(已忽略): ' + e.message); return 0; }
}

module.exports = { createWIP, loadAndHydrate };
