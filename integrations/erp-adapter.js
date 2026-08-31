// ============================================================
//  ERP 对接适配骨架（L4 工厂级 · 真实 ERP 集成适配层）
//  ------------------------------------------------------------
//  设计目标：将现有演示版 fab-erp.js(:8126) 与「真实 ERP」
//  （SAP S/4HANA / 用友 U9 / 真实财务-库存系统）包装为标准集成适配器，
//  抹平财务/库存数据差异，对外暴露统一的端点映射与
//  canonical 数据映射接口，供上层（portal 成本视图 / agent）消费。
//
//  模式（ERP_MODE，默认 demo）：
//    demo   —— 指向本地 fab-erp.js(:8126)，即现有演示闭环，零影响
//    sap    —— SAP S/4HANA（OData / BAPI 语义），读 env 配置，不实际连
//    yonyou —— 用友 U9（OpenAPI 语义），读 env 配置，不实际连
//
//  契约红线：适配器只做「端点映射 + 数据映射 + 配置读取」，
//            不改动 fab-erp.js / server.js / portal.js / agent 业务逻辑。
//            与 L3 设备适配层(adapters/) 同范式：适配层 + env 切换 + 默认 demo。
// ============================================================
//  ⚠️ 蓝图态(BLUEPRINT)：L4 ERP 对接适配器骨架。当前 ERP 以 fab-erp.js(:8126) standalone 形态接入 spine（仅做 CORS/成本修复），不经过此适配器（默认 demo、bindInProcErp 未被调用）；按"串主轴不推翻"策略保持蓝图态。
'use strict';

// 默认本地演示端点（与现有进程地址严格一致：fab-erp.js :8126）
const DEMO = {
  rest: 'http://127.0.0.1:8126',
};

/**
 * ERP 对接适配器
 * @param {object} opts
 * @param {string} opts.mode  'demo' | 'sap' | 'yonyou'（默认 demo）
 */
class ErpAdapter {
  constructor({ mode } = {}) {
    this.mode = (mode || process.env.ERP_MODE || 'demo').toLowerCase();
    this.real = this.mode === 'sap' || this.mode === 'yonyou';
    this.config = this._readConfig();
  }

  // 读取真实 ERP 连接配置（env），不实际连接
  _readConfig() {
    if (!this.real) return {};
    return {
      url:     process.env.ERP_REAL_URL     || '',
      token:   process.env.ERP_REAL_TOKEN   || '',
      apiKey:  process.env.ERP_REAL_APIKEY  || '',
      tenant:  process.env.ERP_REAL_TENANT  || '',   // 用友/U9 多租户
      system:  this.mode,                             // 'sap' | 'yonyou'
    };
  }

  /**
   * 返回当前 ERP 的 REST 端点映射。
   * demo → 本地 fab-erp.js；real → env 指定的真实 ERP。
   */
  getEndpoints() {
    if (this.mode === 'demo') {
      return {
        mode: 'demo',
        system: 'fab-erp-demo',
        rest: DEMO.rest,
        health: `${DEMO.rest}/api/erp/health`,
        routes: {
          costs:     `${DEMO.rest}/api/erp/costs`,
          inventory: `${DEMO.rest}/api/erp/inventory`,
          materials: `${DEMO.rest}/api/erp/materials`,
          tx:        `${DEMO.rest}/api/erp/tx`,
          suppliers: `${DEMO.rest}/api/erp/suppliers`,
          customers: `${DEMO.rest}/api/erp/customers`,
          po:        `${DEMO.rest}/api/erp/po`,
          so:        `${DEMO.rest}/api/erp/so`,
          arap:      `${DEMO.rest}/api/erp/arap`,
        },
        // 上游 MES（ERP 订阅其事件流 + 轮询，CONTRACT §2.3）
        upstreamMes: {
          ws:   'ws://127.0.0.1:8124',
          http: 'http://127.0.0.1:8124',
        },
      };
    }
    // real / sap / yonyou：指向 env（仅声明，不连接）
    const base = (this.config.url || '').replace(/\/$/, '');
    return {
      mode: this.mode,
      system: this.mode === 'sap' ? 'sap-s4' : 'yonyou-u9',
      rest: this.config.url || null,
      health: base ? `${base}/health` : null,
      routes: {
        costs:     base ? `${base}/costs`     : null,
        inventory: base ? `${base}/inventory` : null,
      },
      credential: this.config.token ? '***configured***' : 'missing',
    };
  }

  /**
   * 将「标准 ERP 财务/库存数据」映射为平台 canonical 数据模型。
   * 平台 canonical（与 fab-erp.js 输出对齐）：
   *   costBatch  : { lot, product, matCost, laborCost, equipCost, totalCost, cycleH }
   *   inventory  : { value, materials:[{code,name,cat,unit,price,stock,safetyStock}] }
   * 适配器只做字段对齐，输出与现有 /api/erp/costs / /api/erp/inventory 同构。
   * @param {object} d  标准 ERP 数据（财务/库存），字段随系统而异
   * @param {string}   kind  'cost' | 'inventory'
   * @returns {object} 平台 canonical 数据
   */
  mapErpData(d, kind) {
    if (!d) return null;
    if (kind === 'cost') {
      // 兼容 SAP BAPI / 用友 U9 字段名 → 平台 canonical costBatch
      const mat   = Number(d.matCost ?? d.materialCost ?? d.mat_cost ?? 0);
      const labor = Number(d.laborCost ?? d.labor_cost ?? 0);
      const equip = Number(d.equipCost ?? d.equip_cost ?? d.machineCost ?? 0);
      const total = Number(d.totalCost ?? d.total_cost ?? (mat + labor + equip));
      return {
        type: 'costBatch',
        lot:   String(d.lot ?? d.lotId ?? ''),
        product: String(d.product ?? ''),
        matCost:   +mat.toFixed(0),
        laborCost: +labor.toFixed(0),
        equipCost: +equip.toFixed(0),
        totalCost: +total.toFixed(0),
        cycleH: Number(d.cycleH ?? d.cycleHours ?? 0),
      };
    }
    if (kind === 'inventory') {
      // 兼容真实 ERP 物料/库存结构 → 平台 canonical inventory
      const raw = Array.isArray(d.materials) ? d.materials : (Array.isArray(d.items) ? d.items : []);
      const materials = raw.map(m => ({
        code:  String(m.code ?? m.materialCode ?? m.sku ?? ''),
        name:  String(m.name ?? m.materialName ?? ''),
        cat:   String(m.cat ?? m.category ?? 'RAW'),     // RAW 原材料 / FIN 成品
        unit:  String(m.unit ?? ''),
        price: Number(m.price ?? 0),
        stock: Number(m.stock ?? m.onHand ?? 0),
        safetyStock: Number(m.safetyStock ?? m.safety_stock ?? 0),
      }));
      const value = materials.reduce((s, m) => s + m.stock * m.price, 0);
      return { type: 'inventory', value: +value.toFixed(0), materials };
    }
    return null;
  }
}

module.exports = { ErpAdapter, DEMO_ERP_ENDPOINTS: DEMO, bindInProcErp };

/**
 * 将本地 erp-service 绑定到 MES 事件总线（demo/in-proc 模式）。
 * 由 server.js 在 ERP_INPROC=1 时调用，使 ERP 经 MES eventbus 订阅，
 * 与 standalone 模式共用同一份 erp-service 逻辑，消除双订阅通道。
 * @param {object} ctx  { eventbus, mesHttp }
 * @returns {object|null}  erpSvc 或 null（非 in-proc 模式）
 */
// 蓝图态：社区栈默认 ERP standalone(:8126)，server.js 不调用本函数（MES 内联了等价处理）；
// 仅当 ERP_INPROC=1 时才装配，属"未接 spine"的挂枝适配器，避免被误读为已接。
function bindInProcErp({ eventbus, mesHttp } = {}) {
  if (process.env.ERP_MODE && process.env.ERP_MODE !== 'demo') return null; // 真实 ERP 不 in-proc
  if (process.env.ERP_INPROC !== '1') return null;
  try {
    const { createErpService } = require('../services/erp-service');
    const svc = createErpService({ inProc: true, mesHttp: mesHttp || process.env.MES_HTTP || 'http://127.0.0.1:8124' });
    eventbus.onEmit(ev => svc.handleMesEvent(ev));
    svc.refreshWoCaches();
    return svc;
  } catch (e) {
    console.error('[erp-adapter] in-proc 绑定失败: ' + e.message);
    return null;
  }
}

