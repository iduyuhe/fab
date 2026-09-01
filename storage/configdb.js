// ============================================================
//  fab-config — 共享主数据配置库（ERP / WMS 共用的"真相源"）
//  ------------------------------------------------------------
//  设计：把原先散落在 erp-service.js / wms-service.js 里的硬编码常量
//  （MATERIALS / BOM / LABOR_RATE / EQUIP_RATE / STEP_H / SUPPLIERS /
//   CUSTOMERS）外置到统一配置库 fab-config.db，支持真实 CRUD。
//
//  职责边界（领域数据隔离）：
//    fab-config.db  = 主数据（产品/物料/BOM/费率/供应商/客户）—— 只读被 WMS 消费，可写经 ERP 管理 UI
//    fab-erp.db    = ERP 交易账本（库存流水/成本/PO/SO/ARAP）
//    fab-wms.db    = WMS 实物账本（库位/批次库存/任务/收发流水）
//  主数据外置后，ERP/WMS 不再各自写死 BOM，新增产品只改配置库一处。
// ============================================================
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

function openConfig(dbPath, readOnly = false) {
  const DB_PATH = dbPath || path.join(__dirname, '..', 'fab-config.db');
  // ERP（读写，需 seed）与 WMS（只读）共用 WAL。默认以可写方式打开，避免“已存在的库被 readOnly 打开后 seed 写失败”。
  // WMS 如需只读保护，可显式传入 readOnly=true（仅读不写，无副作用）。
  // 注意：Node 22 的 DatabaseSync 不接受 undefined 作为 options 参数，故分两种构造，绝不传 undefined。
  const db = readOnly
    ? new DatabaseSync(DB_PATH, { readOnly: true })
    : new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=8000;
    CREATE TABLE IF NOT EXISTS products(
      code TEXT PRIMARY KEY, name TEXT, kind TEXT, uom TEXT, std_cycle_h REAL, active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS materials(
      code TEXT PRIMARY KEY, name TEXT, cat TEXT, unit TEXT,
      price REAL, safety_stock REAL, lead_days INTEGER, active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS bom(
      id INTEGER PRIMARY KEY AUTOINCREMENT, product TEXT, seq INTEGER, material TEXT, qty REAL
    );
    CREATE TABLE IF NOT EXISTS cost_rates(
      module TEXT PRIMARY KEY, labor_rate REAL, equip_rate REAL, step_h REAL
    );
    CREATE TABLE IF NOT EXISTS suppliers(
      id TEXT PRIMARY KEY, name TEXT, contact TEXT, lead_days INTEGER
    );
    CREATE TABLE IF NOT EXISTS customers(
      id TEXT PRIMARY KEY, name TEXT, region TEXT
    );
  `);
  return db;
}

// 真实可替换的种子数据（300mm 晶圆厂代表值，标记为非硬编码——经管理 UI 可改）
const SEED = {
  products: [
    { code: 'N2',   name: 'N2 2nm 逻辑芯片',  kind: 'FIN', uom: '片', std_cycle_h: 6.5, active: 1 },
    { code: 'A16',  name: 'A16 先进制程',      kind: 'FIN', uom: '片', std_cycle_h: 5.8, active: 1 },
    { code: 'CIS',  name: 'CIS 图像传感器',    kind: 'FIN', uom: '片', std_cycle_h: 4.2, active: 1 },
  ],
  materials: [
    { code: 'WAFER-300',  name: '300mm 硅片',       cat: 'RAW', unit: '片', price: 850,   safety_stock: 8000,  lead_days: 30 },
    { code: 'RESIST-ARF', name: 'ArF 光刻胶',       cat: 'RAW', unit: '瓶', price: 3200,  safety_stock: 1500,  lead_days: 21 },
    { code: 'TARGET-CU',  name: '铜溅射靶材',       cat: 'RAW', unit: '块', price: 48000, safety_stock: 200,   lead_days: 45 },
    { code: 'GAS-MIX',    name: '工艺特气混合',     cat: 'RAW', unit: '瓶', price: 1500,  safety_stock: 1000,  lead_days: 14 },
    { code: 'SLURRY-CMP', name: 'CMP 抛光液',       cat: 'RAW', unit: '桶', price: 2600,  safety_stock: 800,   lead_days: 21 },
    { code: 'CHEM-CLEA',  name: '清洗化学品',       cat: 'RAW', unit: '桶', price: 900,   safety_stock: 600,   lead_days: 14 },
    { code: 'PHOTOMASK',  name: '光罩',            cat: 'RAW', unit: '片', price: 12000, safety_stock: 50,    lead_days: 35 },
    { code: 'FIN-N2',     name: 'N2 成品晶圆',      cat: 'FIN', unit: '片', price: 38000, safety_stock: 0,     lead_days: 0 },
    { code: 'FIN-A16',    name: 'A16 成品晶圆',     cat: 'FIN', unit: '片', price: 26000, safety_stock: 0,     lead_days: 0 },
    { code: 'FIN-CIS',    name: 'CIS 成品晶圆',     cat: 'FIN', unit: '片', price: 9500,  safety_stock: 0,     lead_days: 0 },
  ],
  bom: [
    { product: 'N2',  seq: 1, material: 'WAFER-300',  qty: 25 },
    { product: 'N2',  seq: 2, material: 'RESIST-ARF', qty: 1.2 },
    { product: 'N2',  seq: 3, material: 'TARGET-CU',  qty: 0.35 },
    { product: 'N2',  seq: 4, material: 'GAS-MIX',    qty: 2 },
    { product: 'N2',  seq: 5, material: 'SLURRY-CMP', qty: 1.5 },
    { product: 'N2',  seq: 6, material: 'CHEM-CLEA',  qty: 0.8 },
    { product: 'N2',  seq: 7, material: 'PHOTOMASK',  qty: 0.04 },
    { product: 'A16', seq: 1, material: 'WAFER-300',  qty: 25 },
    { product: 'A16', seq: 2, material: 'RESIST-ARF', qty: 1 },
    { product: 'A16', seq: 3, material: 'TARGET-CU',  qty: 0.3 },
    { product: 'A16', seq: 4, material: 'GAS-MIX',    qty: 1.5 },
    { product: 'A16', seq: 5, material: 'SLURRY-CMP', qty: 1.2 },
    { product: 'A16', seq: 6, material: 'CHEM-CLEA',  qty: 0.7 },
    { product: 'A16', seq: 7, material: 'PHOTOMASK',  qty: 0.05 },
    { product: 'CIS', seq: 1, material: 'WAFER-300',  qty: 25 },
    { product: 'CIS', seq: 2, material: 'RESIST-ARF', qty: 0.9 },
    { product: 'CIS', seq: 3, material: 'GAS-MIX',    qty: 1.8 },
    { product: 'CIS', seq: 4, material: 'SLURRY-CMP', qty: 1.3 },
    { product: 'CIS', seq: 5, material: 'CHEM-CLEA',  qty: 0.6 },
  ],
  cost_rates: [
    { module: 'LITHO', labor_rate: 3000, equip_rate: 4200, step_h: 0.28 },
    { module: 'ETCH',  labor_rate: 1800, equip_rate: 2200, step_h: 0.17 },
    { module: 'DEP',   labor_rate: 1600, equip_rate: 1800, step_h: 0.21 },
    { module: 'CMP',   labor_rate: 1200, equip_rate: 1400, step_h: 0.19 },
    { module: 'IMPL',  labor_rate: 2000, equip_rate: 2500, step_h: 0.23 },
    { module: 'METRO', labor_rate: 900,  equip_rate: 1000, step_h: 0.31 },
  ],
  suppliers: [
    { id: 'SUP-001', name: '信越化学 ShinEtsu', contact: '张经理', lead_days: 30 },
    { id: 'SUP-002', name: 'JSR 光刻胶',        contact: '李工',   lead_days: 21 },
    { id: 'SUP-003', name: '三菱综合材料',       contact: '王工',   lead_days: 45 },
    { id: 'SUP-004', name: '液化空气 A-L',       contact: '陈经理', lead_days: 14 },
  ],
  customers: [
    { id: 'CUS-001', name: '英伟达 NVDA',   region: '美国' },
    { id: 'CUS-002', name: '苹果 AAPL',     region: '美国' },
    { id: 'CUS-003', name: '海思 HiSilicon', region: '中国' },
  ],
};

function seedConfig(db) {
  const pCount = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  if (pCount > 0) return false; // 已初始化，避免覆盖用户数据
  const insP  = db.prepare('INSERT OR IGNORE INTO products(code,name,kind,uom,std_cycle_h,active) VALUES(?,?,?,?,?,?)');
  const insM  = db.prepare('INSERT OR IGNORE INTO materials(code,name,cat,unit,price,safety_stock,lead_days,active) VALUES(?,?,?,?,?,?,?,?)');
  const insB  = db.prepare('INSERT INTO bom(product,seq,material,qty) VALUES(?,?,?,?)');
  const insC  = db.prepare('INSERT OR IGNORE INTO cost_rates(module,labor_rate,equip_rate,step_h) VALUES(?,?,?,?)');
  const insS  = db.prepare('INSERT OR IGNORE INTO suppliers(id,name,contact,lead_days) VALUES(?,?,?,?)');
  const insCu = db.prepare('INSERT OR IGNORE INTO customers(id,name,region) VALUES(?,?,?)');
  SEED.products.forEach(r => insP.run(r.code, r.name, r.kind, r.uom, r.std_cycle_h, r.active));
  SEED.materials.forEach(r => insM.run(r.code, r.name, r.cat, r.unit, r.price, r.safety_stock, r.lead_days, 1));
  SEED.bom.forEach(r => insB.run(r.product, r.seq, r.material, r.qty));
  SEED.cost_rates.forEach(r => insC.run(r.module, r.labor_rate, r.equip_rate, r.step_h));
  SEED.suppliers.forEach(r => insS.run(r.id, r.name, r.contact, r.lead_days));
  SEED.customers.forEach(r => insCu.run(r.id, r.name, r.region));
  return true;
}

// ---- 访问器（读取）----
function buildStore(db) {
  const qProducts   = db.prepare('SELECT * FROM products ORDER BY code');
  const qProduct    = db.prepare('SELECT * FROM products WHERE code=?');
  const qMaterials  = db.prepare('SELECT * FROM materials ORDER BY code');
  const qMaterial   = db.prepare('SELECT * FROM materials WHERE code=?');
  const qBom        = db.prepare('SELECT * FROM bom WHERE product=? ORDER BY seq');
  const qAllBom     = db.prepare('SELECT * FROM bom ORDER BY product, seq');
  const qCost       = db.prepare('SELECT * FROM cost_rates WHERE module=?');
  const qCostAll    = db.prepare('SELECT * FROM cost_rates ORDER BY module');
  const qSuppliers  = db.prepare('SELECT * FROM suppliers ORDER BY id');
  const qSupplier   = db.prepare('SELECT * FROM suppliers WHERE id=?');
  const qCustomers  = db.prepare('SELECT * FROM customers ORDER BY id');
  const qCustomer   = db.prepare('SELECT * FROM customers WHERE id=?');

  const finCode = (product) => 'FIN-' + String(product || '').toUpperCase();

  return {
    finCode,
    getProducts: () => qProducts.all(),
    getProduct: (c) => qProduct.get(c),
    getMaterials: () => qMaterials.all(),
    getMaterial: (c) => qMaterial.get(c),
    getBom: (product) => qBom.all(product),
    getBomMap: (product) => {
      const m = {}; qBom.all(product).forEach(r => { m[r.material] = r.qty; }); return m;
    },
    getAllBom: () => qAllBom.all(),
    getCostRate: (mod) => qCost.get(mod),
    getCostRates: () => qCostAll.all(),
    getSuppliers: () => qSuppliers.all(),
    getSupplier: (id) => qSupplier.get(id),
    getCustomers: () => qCustomers.all(),
    getCustomer: (id) => qCustomer.get(id),
  };
}

// ---- CRUD（写入，仅 ERP 管理 UI 调用）----
function buildCrud(db) {
  const upsP  = db.prepare('INSERT INTO products(code,name,kind,uom,std_cycle_h,active) VALUES(?,?,?,?,?,1) ON CONFLICT(code) DO UPDATE SET name=excluded.name,kind=excluded.kind,uom=excluded.uom,std_cycle_h=excluded.std_cycle_h');
  const delP  = db.prepare('DELETE FROM products WHERE code=?');
  const upsM  = db.prepare('INSERT INTO materials(code,name,cat,unit,price,safety_stock,lead_days,active) VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(code) DO UPDATE SET name=excluded.name,cat=excluded.cat,unit=excluded.unit,price=excluded.price,safety_stock=excluded.safety_stock,lead_days=excluded.lead_days');
  const delM  = db.prepare('DELETE FROM materials WHERE code=?');
  const insB  = db.prepare('INSERT INTO bom(product,seq,material,qty) VALUES(?,?,?,?)');
  const delBp = db.prepare('DELETE FROM bom WHERE product=?');
  const delB1 = db.prepare('DELETE FROM bom WHERE id=?');
  const upsC  = db.prepare('INSERT INTO cost_rates(module,labor_rate,equip_rate,step_h) VALUES(?,?,?,?) ON CONFLICT(module) DO UPDATE SET labor_rate=excluded.labor_rate,equip_rate=excluded.equip_rate,step_h=excluded.step_h');
  const upsS  = db.prepare('INSERT INTO suppliers(id,name,contact,lead_days) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,contact=excluded.contact,lead_days=excluded.lead_days');
  const delS  = db.prepare('DELETE FROM suppliers WHERE id=?');
  const upsCu = db.prepare('INSERT INTO customers(id,name,region) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,region=excluded.region');
  const delCu = db.prepare('DELETE FROM customers WHERE id=?');

  return {
    upsertProduct: (r) => upsP.run(r.code, r.name, r.kind, r.uom, +r.std_cycle_h || 0),
    deleteProduct: (c) => delP.run(c),
    upsertMaterial: (r) => upsM.run(r.code, r.name, r.cat, r.unit, +r.price || 0, +r.safety_stock || 0, +r.lead_days || 0),
    deleteMaterial: (c) => delM.run(c),
    setBom: (product, items) => { // items: [{seq,material,qty}]
      delBp.run(product);
      (items || []).forEach((it, i) => insB.run(product, it.seq ?? (i + 1), it.material, +it.qty || 0));
    },
    deleteBomItem: (id) => delB1.run(id),
    upsertCostRate: (r) => upsC.run(r.module, +r.labor_rate || 0, +r.equip_rate || 0, +r.step_h || 0),
    upsertSupplier: (r) => upsS.run(r.id, r.name, r.contact, +r.lead_days || 0),
    deleteSupplier: (id) => delS.run(id),
    upsertCustomer: (r) => upsCu.run(r.id, r.name, r.region),
    deleteCustomer: (id) => delCu.run(id),
  };
}

module.exports = { openConfig, seedConfig, buildStore, buildCrud };
