// ============================================================
//  StorageAdapter — 阶段0 存储抽象基类（§5.2）
//  仅定义方法签名；具体实现见 ./sqlite.js（node:sqlite）。
//  所有对外方法语义必须与 server.js 原裸 db 调用完全等价。
// ============================================================
class StorageAdapter {
  // ---- 初始化 ----
  initSchema() { throw new Error('not implemented: initSchema'); }
  seedMeta({ modules, products, routes }) { throw new Error('not implemented: seedMeta'); }

  // ---- 事件队列落库（批写） ----
  enqueueEvent(ts, type, payloadStr) { throw new Error('not implemented: enqueueEvent'); }
  flushEvents() { throw new Error('not implemented: flushEvents'); }
  queryEvents({ after = 0, limit = 100, from, to, type } = {}) { throw new Error('not implemented: queryEvents'); }

  // ---- 设备 ----
  upsertTool(t) { throw new Error('not implemented: upsertTool'); }
  updateToolStatus(id, status, ts) { throw new Error('not implemented: updateToolStatus'); }
  updateToolMetric(id, util, wafers, wph, ts) { throw new Error('not implemented: updateToolMetric'); }

  // ---- 工单 / 批次 / 历史 ----
  insertWO(w) { throw new Error('not implemented: insertWO'); }
  insertLot(l) { throw new Error('not implemented: insertLot'); }
  updateLot(l) { throw new Error('not implemented: updateLot'); }
  insertLotHist(lotId, h) { throw new Error('not implemented: insertLotHist'); }

  // ---- 量测 / VM / SPC ----
  insertMetrology(ts, m) { throw new Error('not implemented: insertMetrology'); }
  insertVmLog(ts, v) { throw new Error('not implemented: insertVmLog'); }
  insertSpcAlarm(ts, a) { throw new Error('not implemented: insertSpcAlarm'); }
  queryMetrology({ param, lot, product, limit = 100 } = {}) { throw new Error('not implemented: queryMetrology'); }
  queryMetrologyStats() { throw new Error('not implemented: queryMetrologyStats'); }
  queryVmLog(limit = 50) { throw new Error('not implemented: queryVmLog'); }
  querySpcAlarms(limit = 30) { throw new Error('not implemented: querySpcAlarms'); }

  // ---- 主数据读取 ----
  queryMetaModules() { throw new Error('not implemented: queryMetaModules'); }
  queryMetaProducts() { throw new Error('not implemented: queryMetaProducts'); }
  queryMetaRoutes() { throw new Error('not implemented: queryMetaRoutes'); }
  queryRouteForProduct(product) { throw new Error('not implemented: queryRouteForProduct'); }
}

module.exports = { StorageAdapter };
