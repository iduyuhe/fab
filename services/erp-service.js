// ============================================================
//  ERP 服务（MES 底座内的统一 ERP 集成模块）
//  ------------------------------------------------------------
//  由 fab-erp.js（独立进程入口）与 server.js（in-proc 并入底座）
//  共用同一份逻辑。
//
//  2026-08-28 演进：
//   [Phase 0] 主数据外置到共享配置库 fab-config.db（products/materials/
//     bom/cost_rates/suppliers/customers），ERP 从配置库读主数据，并暴露
//     /api/erp/config/* CRUD 端点。ERP 交易账本存 fab-erp.db。
//   [Phase 1] 真实 ERP 能力补完：
//     · 总账(G/L)：accounts / vouchers / voucher_entries + postVoucher 过账
//     · 应付应收(AP/AR) + 发票税务(13% 进项/销项)
//     · 采购审批流：PO 状态机 DRAFT→PENDING→OPEN→RECEIVED→CLOSED
//     · MRP 物料需求计划：WO×BOM 净需求 → 一键生成采购单进审批流
// ============================================================
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { openConfig, seedConfig, buildStore, buildCrud } = require('../storage/configdb');

const VAT_RATE = +(process.env.ERPVAT || 0.13); // 增值税率，默认 13%

function createErpService({ dbPath, mesHttp, inProc = false } = {}) {
  const DB_PATH = dbPath || path.join(__dirname, '..', 'fab-erp.db');
  const MES_HTTP = mesHttp || process.env.MES_HTTP || 'http://127.0.0.1:8124';
  let mesConnected = !!inProc;

  // ---------- 共享配置库（主数据真相源，ERP 持有读写权）----------
  const cfgDb = openConfig(path.join(__dirname, '..', 'fab-config.db'));
  seedConfig(cfgDb);
  const cfg = buildStore(cfgDb);
  const crud = buildCrud(cfgDb);

  // ---------- SQLite（ERP 交易账本 + 总账）----------
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS material_stock(
      code TEXT PRIMARY KEY, stock REAL DEFAULT 0, avg_cost REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS inv_tx(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, material TEXT, qty REAL,
      type TEXT, ref TEXT, note TEXT
    );
    CREATE TABLE IF NOT EXISTS purchase_orders(
      id TEXT PRIMARY KEY, supplier TEXT, material TEXT, qty REAL, price REAL,
      status TEXT, created TEXT, received_at TEXT, approver TEXT
    );
    CREATE TABLE IF NOT EXISTS sales_orders(
      id TEXT PRIMARY KEY, customer TEXT, product TEXT, qty REAL, price REAL,
      due TEXT, status TEXT, created TEXT, shipped_at TEXT
    );
    CREATE TABLE IF NOT EXISTS cost_batches(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, lot TEXT, product TEXT,
      mat_cost REAL, labor_cost REAL, equip_cost REAL, total_cost REAL, cycle_h REAL
    );
    CREATE TABLE IF NOT EXISTS arap(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, kind TEXT,
      ref TEXT, amount REAL, status TEXT
    );
    CREATE TABLE IF NOT EXISTS accounts(
      code TEXT PRIMARY KEY, name TEXT, type TEXT, balance REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS vouchers(
      id TEXT PRIMARY KEY, ts TEXT, summary TEXT, status TEXT, created_by TEXT
    );
    CREATE TABLE IF NOT EXISTS voucher_entries(
      id INTEGER PRIMARY KEY AUTOINCREMENT, voucher_id TEXT, account TEXT,
      dr REAL DEFAULT 0, cr REAL DEFAULT 0, note TEXT
    );
    CREATE TABLE IF NOT EXISTS ap_invoices(
      id TEXT PRIMARY KEY, supplier TEXT, po_id TEXT, amount REAL,
      tax_rate REAL, tax REAL, total REAL, due TEXT, status TEXT, created TEXT
    );
    CREATE TABLE IF NOT EXISTS ar_invoices(
      id TEXT PRIMARY KEY, customer TEXT, so_id TEXT, amount REAL,
      tax_rate REAL, tax REAL, total REAL, due TEXT, status TEXT, created TEXT
    );
  `);
  // 兼容旧库：purchase_orders 可能缺 approver 列
  try { db.exec('ALTER TABLE purchase_orders ADD COLUMN approver TEXT'); } catch (e) { /* 已存在 */ }
  // SO 状态机延展：新增 delivered_at（签收时间），状态 OPEN→IN_TRANSIT→DELIVERED→CLOSED
  try { db.exec('ALTER TABLE sales_orders ADD COLUMN delivered_at TEXT'); } catch (e) { /* 已存在 */ }

  const nowISO = () => new Date().toISOString();
  const safe = fn => { try { fn(); } catch (e) { log('DB 异常: ' + e.message); } };
  const log = (msg) => console.log(`[ERP ${new Date().toTimeString().slice(0, 8)}] ${msg}`);

  // 事件化发运/交付（P0-2）：经 MES 单一事件出口(/api/mes/emit)广播给所有订阅方（含 WMS 实物域），
  // 保证“财务发运”与“仓储实物发运”双域一致，杜绝各域自建通道造成的分歧。
  function emitToMes(ev) {
    fetch(`${MES_HTTP}/api/mes/emit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
    }).then(() => {}).catch(e => log('emit→MES 失败: ' + e.message));
  }

  // 预置语句
  const insStock = db.prepare('INSERT OR IGNORE INTO material_stock(code,stock,avg_cost) VALUES(?,?,?)');
  const qStock = db.prepare('SELECT * FROM material_stock');
  const getStock = db.prepare('SELECT * FROM material_stock WHERE code=?');
  const updStock = db.prepare('UPDATE material_stock SET stock=stock+? WHERE code=?');
  const insTx = db.prepare('INSERT INTO inv_tx(ts,material,qty,type,ref,note) VALUES(?,?,?,?,?,?)');
  const insPo = db.prepare('INSERT INTO purchase_orders(id,supplier,material,qty,price,status,created,approver) VALUES(?,?,?,?,?,?,?,?)');
  const qPo = db.prepare('SELECT * FROM purchase_orders ORDER BY created DESC LIMIT 300');
  const getPo = db.prepare('SELECT * FROM purchase_orders WHERE id=?');
  const updPo = db.prepare("UPDATE purchase_orders SET status=?, received_at=? WHERE id=?");
  const updPoApprover = db.prepare("UPDATE purchase_orders SET status=?, approver=? WHERE id=?");
  const insSo = db.prepare('INSERT INTO sales_orders(id,customer,product,qty,price,due,status,created) VALUES(?,?,?,?,?,?,?,?)');
  const qSo = db.prepare('SELECT * FROM sales_orders ORDER BY created DESC LIMIT 300');
  const getSo = db.prepare('SELECT * FROM sales_orders WHERE id=?');
  const updSo = db.prepare("UPDATE sales_orders SET status=?, shipped_at=? WHERE id=?");
  const updSoDelivered = db.prepare("UPDATE sales_orders SET status=?, delivered_at=? WHERE id=?");
  const insCost = db.prepare('INSERT INTO cost_batches(ts,lot,product,mat_cost,labor_cost,equip_cost,total_cost,cycle_h) VALUES(?,?,?,?,?,?,?,?)');
  const qCost = db.prepare('SELECT * FROM cost_batches ORDER BY id DESC LIMIT 300');
  const insArap = db.prepare('INSERT INTO arap(ts,kind,ref,amount,status) VALUES(?,?,?,?,?)');
  const qArap = db.prepare('SELECT * FROM arap ORDER BY id DESC LIMIT 300');

  // 总账预置语句
  const qAcct = db.prepare('SELECT * FROM accounts WHERE code=?');
  const qAccts = db.prepare('SELECT * FROM accounts ORDER BY code');
  const updAcct = db.prepare('UPDATE accounts SET balance=balance+? WHERE code=?');
  const insAcct = db.prepare('INSERT OR IGNORE INTO accounts(code,name,type,balance) VALUES(?,?,?,?)');
  const insV = db.prepare('INSERT INTO vouchers(id,ts,summary,status,created_by) VALUES(?,?,?,?,?)');
  const insVe = db.prepare('INSERT INTO voucher_entries(voucher_id,account,dr,cr,note) VALUES(?,?,?,?,?)');
  const qV = db.prepare('SELECT * FROM vouchers ORDER BY id DESC LIMIT 300');
  const qVe = db.prepare('SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY id');
  const insApInv = db.prepare('INSERT INTO ap_invoices(id,supplier,po_id,amount,tax_rate,tax,total,due,status,created) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const qApInv = db.prepare("SELECT * FROM ap_invoices WHERE status=? OR 'ALL'=? ORDER BY created DESC LIMIT 300");
  const getApInv = db.prepare('SELECT * FROM ap_invoices WHERE id=?');
  const updApInv = db.prepare("UPDATE ap_invoices SET status=? WHERE id=?");
  const insArInv = db.prepare('INSERT INTO ar_invoices(id,customer,so_id,amount,tax_rate,tax,total,due,status,created) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const qArInv = db.prepare("SELECT * FROM ar_invoices WHERE status=? OR 'ALL'=? ORDER BY created DESC LIMIT 300");
  const getArInv = db.prepare('SELECT * FROM ar_invoices WHERE id=?');
  const updArInv = db.prepare("UPDATE ar_invoices SET status=? WHERE id=?");

  // 库存账初始化：以配置库主数据为准，RAW 给安全库存量、FIN 给 0（健康期初，避免演示期透支为负数）
  (function seedStock() {
    const masters = cfg.getMaterials();
    masters.forEach(m => {
      const exist = getStock.get(m.code);
      if (!exist) {
        const init = m.cat === 'RAW' ? (m.safety_stock || 0) : 0;
        safe(() => insStock.run(m.code, init, m.price || 0));
      }
    });
    log(`库存账已对齐配置库主数据（${masters.length} 项）`);
  })();

  // 总账初始化：会计科目表
  (function seedGL() {
    const GL = [
      ['1001', '库存现金', 'ASSET', 0],
      ['1002', '银行存款', 'ASSET', 0],
      ['1201', '原材料', 'ASSET', 0],
      ['1243', '库存商品', 'ASSET', 0],
      ['1122', '应收账款', 'ASSET', 0],
      ['2202', '应付账款', 'LIABILITY', 0],
      ['2221-IN', '应交税费-进项税额', 'LIABILITY', 0],
      ['2221-OUT', '应交税费-销项税额', 'LIABILITY', 0],
      ['5001', '生产成本', 'EXPENSE', 0],
      ['6001', '主营业务成本', 'EXPENSE', 0],
      ['6051', '主营业务收入', 'REVENUE', 0],
    ];
    let n = 0;
    GL.forEach(([c, nm, t, b]) => { const r = insAcct.run(c, nm, t, b); if (r.changes) n++; });
    if (n) log(`总账科目已初始化（${n} 个）`);
  })();

  // ---------- 库存动作 ----------
  function stockMove(mat, qty, type, ref, note) {
    const ex = getStock.get(mat);
    if (!ex) safe(() => insStock.run(mat, 0, cfg.getMaterial(mat)?.price || 0));
    safe(() => { updStock.run(qty, mat); insTx.run(nowISO(), mat, qty, type, ref, note); });
  }
  function issueBom(product, ref) {
    const bom = cfg.getBomMap(product);
    if (!bom || !Object.keys(bom).length) return;
    for (const [mat, q] of Object.entries(bom)) stockMove(mat, -q, 'ISSUE', ref, `${product} 领料`);
  }
  function receiveFinish(product, ref) {
    const code = cfg.finCode(product);
    if (!code) return null;
    stockMove(code, 25, 'FINISH', ref, `${product} 完工入库 25 片`);
    return code;
  }

  // ---------- 总账过账 ----------
  // entries: [{account, dr, cr, note}]  —— dr/cr 为绝对金额（不含符号）
  function postVoucher(summary, entries, createdBy = 'SYSTEM') {
    try {
      db.exec('BEGIN');
      const vid = `V-${Date.now().toString(36).toUpperCase()}`;
      insV.run(vid, nowISO(), summary, 'POSTED', createdBy);
      for (const e of entries) {
        const ac = qAcct.get(e.account);
        if (!ac) throw new Error('科目不存在: ' + e.account);
        const dr = +e.dr || 0, cr = +e.cr || 0;
        let delta = 0;
        // ASSET/EXPENSE 正常借余（dr 增，cr 减）；LIABILITY/EQUITY/REVENUE 正常贷余（cr 增，dr 减）
        if (ac.type === 'ASSET' || ac.type === 'EXPENSE') delta = dr - cr;
        else delta = cr - dr;
        updAcct.run(delta, e.account);
        insVe.run(vid, e.account, dr, cr, e.note || '');
      }
      db.exec('COMMIT');
      log(`📒 凭证过账 ${vid}：${summary}（${entries.length} 条分录）`);
      return vid;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      log('凭证过账失败: ' + err.message);
      return null;
    }
  }
  function trialBalance() {
    const rows = qAccts.all();
    let td = 0, tc = 0;
    const items = rows.map(a => {
      let d = 0, c = 0;
      if (a.type === 'ASSET' || a.type === 'EXPENSE') { if (a.balance >= 0) d = a.balance; else c = -a.balance; }
      else { if (a.balance >= 0) c = a.balance; else d = -a.balance; }
      td += d; tc += c;
      return { code: a.code, name: a.name, type: a.type, balance: a.balance, debit: +d.toFixed(2), credit: +c.toFixed(2) };
    });
    return { items, totalDebit: +td.toFixed(2), totalCredit: +tc.toFixed(2), balanced: Math.abs(td - tc) < 0.01 };
  }

  // ---------- 批次成本归集（读配置库费率/BOM/物料价）----------
  async function costLot(lotId, product, cycleH) {
    let hist = [];
    try {
      const r = await fetch(`${MES_HTTP}/api/lots/${encodeURIComponent(lotId)}`);
      if (r.ok) { const d = await r.json(); hist = (d && d.hist) || []; }
    } catch (e) { log(`拉取 ${lotId} 历史失败: ${e.message}`); }
    const rateMap = {}; cfg.getCostRates().forEach(x => rateMap[x.module] = x);
    let labor = 0, equip = 0;
    for (const h of hist) {
      const mod = h.mod || '';
      const rate = rateMap[mod] || { labor_rate: 1000, equip_rate: 800, step_h: 0.2 };
      labor += (rate.step_h || 0.2) * (rate.labor_rate || 1000);
      equip += (rate.step_h || 0.2) * (rate.equip_rate || 800);
    }
    const bom = cfg.getBomMap(product) || {};
    let mat = 0;
    for (const [code, q] of Object.entries(bom)) {
      const m = cfg.getMaterial(code);
      if (m) mat += (m.price || 0) * q;
    }
    const total = mat + labor + equip;
    safe(() => insCost.run(nowISO(), lotId, product, +mat.toFixed(0), +labor.toFixed(0), +equip.toFixed(0), +total.toFixed(0), cycleH));
    log(`💰 成本归集 ${lotId} ${product}: 料 ${mat.toFixed(0)} + 工时 ${labor.toFixed(0)} + 设备 ${equip.toFixed(0)} = ${total.toFixed(0)} 元`);
    return { mat, labor, equip, total };
  }

  // ---------- 事件联动（经 MES 事件总线 onEmit / WS 触发）----------
  const woCache = new Map();
  function handleMesEvent(ev) {
    try {
      if (ev.type === 'lotRelease') {
        const wo = woCache.get(ev.wo);
        const product = wo ? wo.product : (ev.product || 'N2');
        issueBom(product, ev.lot);
        log(`📤 领料 ${ev.lot} (${product})`);
      } else if (ev.type === 'lotDone') {
        if (ev.lot && ev.product) {
          // 完工入库（库存商品账） + 成本归集（异步）+ 完工 GL 过账（借1243 贷5001，P0-4 结算纠偏）
          receiveFinish(ev.product, ev.lot);
          (async () => {
            const c = await costLot(ev.lot, ev.product, ev.cycleH || 0);
            if (c && c.total > 0) {
              postVoucher(`完工入库 ${ev.lot} (${ev.product})`, [
                { account: '1243', dr: c.total, note: `库存商品 ${ev.product}` },
                { account: '5001', cr: c.total, note: '生产成本结转' },
              ], 'MES');
            }
            // 订单驱动履约（P0-1）：仅当批次归属某 SO 时才自动发运；否则仅入成品库，不触发应收
            if (ev.so) tryFulfill(ev.so);
          })();
        }
      }
    } catch (e) { log('事件处理异常: ' + e.message); }
  }
  async function refreshWoCaches() {
    try {
      const r = await fetch(`${MES_HTTP}/api/wos`);
      if (r.ok) { const d = await r.json(); (d.wos || []).forEach(w => woCache.set(w.id, w)); }
    } catch (e) { /* MES 未起，跳过 */ }
  }

  // 自动发运（遗留/补偿用）：按产品找最早 OPEN SO，库存足则发运（reconcile 补算路径使用）
  function autoShip(product) {
    const code = cfg.finCode(product);
    if (!code) return;
    const so = db.prepare("SELECT * FROM sales_orders WHERE status='OPEN' AND product=? ORDER BY created LIMIT 1").get(product);
    if (!so) return;
    const m = getStock.get(code);
    if (!m || m.stock < so.qty) return;
    shipOrder(so.id);
  }

  // 订单驱动履约（P0-1）：按 SO id 精确履约。库存不足则等后续 lotDone 补货后重试（由各自 lotDone 再次触发）。
  function tryFulfill(soId) {
    const so = getSo.get(soId);
    if (!so || so.status !== 'OPEN') return false;
    const code = cfg.finCode(so.product);
    if (!code) return false;
    const m = getStock.get(code);
    if (!m || m.stock < so.qty) return false;   // 成品库存不足 → 暂不发运，待本 SO 的 WO 继续完工补货
    shipOrder(so.id);
    return true;
  }

  // ---------- 采购审批流 + 应付发票 ----------
  function receivePo(id) {
    const po = getPo.get(id);
    if (!po) return { ok: false, error: 'PO 不存在' };
    if (po.status === 'RECEIVED' || po.status === 'CLOSED') return { ok: false, error: 'PO 已收货/关闭' };
    if (po.status !== 'OPEN') return { ok: false, error: 'PO 未审批(状态:' + po.status + ')，不能收货' };
    const amount = po.qty * po.price;        // 不含税金额
    const tax = +(amount * VAT_RATE).toFixed(2);
    const total = +(amount + tax).toFixed(2);
    const due = new Date(Date.now() + 30 * 864e5).toISOString();
    const invId = `AP-${Date.now().toString(36).toUpperCase()}`;
    stockMove(po.material, po.qty, 'RECV', po.id, `PO 收货 ${po.supplier}`);
    safe(() => insApInv.run(invId, po.supplier, po.id, amount, VAT_RATE, tax, total, due, 'UNPAID', nowISO()));
    // 凭证：借 原材料 / 借 进项税额 / 贷 应付账款
    postVoucher(`采购收货 ${po.id} (${po.material})`, [
      { account: '1201', dr: amount, note: `原材料 ${po.material} ×${po.qty}` },
      { account: '2221-IN', dr: tax, note: '进项税额' },
      { account: '2202', cr: total, note: `应付 ${po.supplier}` },
    ], 'ERP');
    safe(() => updPo.run('RECEIVED', nowISO(), id));
    safe(() => insArap.run(nowISO(), 'AP', po.id, total, 'OPEN'));
    log(`📥 PO ${id} 收货 ${po.material} ×${po.qty} → 应付发票 ${invId} 含税 ${total.toFixed(0)}`);
    return { ok: true, invoice: invId, amount, tax, total };
  }
  function approvePo(id, approver) {
    const po = getPo.get(id);
    if (!po) return { ok: false, error: 'PO 不存在' };
    if (po.status === 'DRAFT' || po.status === 'PENDING') {
      safe(() => updPoApprover.run('OPEN', (approver || 'AUTO').toString().slice(0, 32), id));
      log(`✅ PO ${id} 审批通过（${approver || 'AUTO'}）→ OPEN`);
      return { ok: true, id, status: 'OPEN', approver: approver || 'AUTO' };
    }
    return { ok: false, error: '当前状态(' + po.status + ') 不可审批' };
  }
  function payAp(invId) {
    const inv = getApInv.get(invId);
    if (!inv) return { ok: false, error: '应付发票不存在' };
    if (inv.status === 'PAID') return { ok: false, error: '已付款' };
    safe(() => updApInv.run('PAID', invId));
    postVoucher(`支付货款 ${invId}`, [
      { account: '2202', dr: inv.total, note: `付 ${inv.supplier}` },
      { account: '1002', cr: inv.total, note: '银行存款' },
    ], 'ERP');
    log(`💸 付款 ${invId} 含税 ${inv.total.toFixed(0)}`);
    return { ok: true };
  }

  // ---------- 销售 + 应收发票 ----------
  function shipOrder(id) {
    const so = getSo.get(id);
    if (!so) return { ok: false, error: 'SO 不存在或非 OPEN' };
    const code = cfg.finCode(so.product);
    if (!code) return { ok: false, error: '未知产品' };
    const m = getStock.get(code);
    if (!m || m.stock < so.qty) return { ok: false, error: '成品库存不足' };
    const amount = so.qty * so.price;
    const tax = +(amount * VAT_RATE).toFixed(2);
    const total = +(amount + tax).toFixed(2);
    const due = new Date(Date.now() + 30 * 864e5).toISOString();
    const invId = `AR-${Date.now().toString(36).toUpperCase()}`;
    stockMove(code, -so.qty, 'SHIP', so.id, `SO 发运 ${so.customer}`);
    safe(() => insArInv.run(invId, so.customer, so.id, amount, VAT_RATE, tax, total, due, 'UNPAID', nowISO()));
    // 凭证：借 应收账款 / 贷 主营业务收入 / 贷 销项税额
    postVoucher(`销售发货 ${so.id} (${so.product})`, [
      { account: '1122', dr: total, note: `应收 ${so.customer}` },
      { account: '6051', cr: amount, note: '主营业务收入' },
      { account: '2221-OUT', cr: tax, note: '销项税额' },
    ], 'ERP');
    safe(() => updSo.run('IN_TRANSIT', nowISO(), id));   // OPEN → IN_TRANSIT（在途，待签收）
    safe(() => insArap.run(nowISO(), 'AR', so.id, total, 'OPEN'));
    // 双域一致（P0-2）：事件化发运，经 MES 单一出口广播，WMS 实物同步扣减
    emitToMes({ type: 'shipment', so: so.id, product: so.product, qty: so.qty, customer: so.customer, invoice: invId, ts: Date.now() });
    log(`🚚 SO ${id} 发运 ${so.product} ×${so.qty} → 应收发票 ${invId} 含税 ${total.toFixed(0)}（在途 IN_TRANSIT）`);
    scheduleDelivery(so.id, invId);
    return { ok: true, invoice: invId, amount, tax, total };
  }

  // SO 交付状态机（P0-3）：IN_TRANSIT → DELIVERED(签收) → 自动收款 CLOSED，闭环 OTD 末端
  const DELIVERY_MS = +(process.env.ERP_DELIVERY_MS || 12000);
  const AR_MS = +(process.env.ERP_AR_MS || 8000);
  function scheduleDelivery(soId, invoiceId) {
    setTimeout(() => {
      try {
        const so = getSo.get(soId);
        if (!so || so.status !== 'IN_TRANSIT') return;
        safe(() => updSoDelivered.run('DELIVERED', nowISO(), soId));     // 客户签收
        emitToMes({ type: 'delivery', so: soId, product: so.product, qty: so.qty, customer: so.customer, invoice: invoiceId, ts: Date.now() }); // 蓝图态：delivery 事件当前无订阅者（挂枝/广播），签收→AR 闭环在本地完成
        log(`📦 SO ${soId} 已签收(DELIVERED) → 触发应收回款`);
        // 模拟 B2B 账期回款，闭环现金（P0-4）：签收后自动收款
        setTimeout(() => {
          try {
            const inv = getArInv.get(invoiceId);
            if (inv && inv.status !== 'PAID') { receiveAr(invoiceId); safe(() => db.prepare("UPDATE sales_orders SET status='CLOSED' WHERE id=? AND status='DELIVERED'").run(soId)); }
          } catch (e) { log('自动收款失败: ' + e.message); }
        }, AR_MS);
      } catch (e) { log('交付确认失败: ' + e.message); }
    }, DELIVERY_MS);
  }
  function receiveAr(invId) {
    const inv = getArInv.get(invId);
    if (!inv) return { ok: false, error: '应收发票不存在' };
    if (inv.status === 'PAID') return { ok: false, error: '已收款' };
    safe(() => updArInv.run('PAID', invId));
    postVoucher(`收回货款 ${invId}`, [
      { account: '1002', dr: inv.total, note: '银行存款' },
      { account: '1122', cr: inv.total, note: `收 ${inv.customer}` },
    ], 'ERP');
    log(`💰 收款 ${invId} 含税 ${inv.total.toFixed(0)}`);
    return { ok: true };
  }

  // ---------- MRP 物料需求计划 ----------
  // 标准再订货点逻辑：净需求 = 毛需求(开卡 WO×BOM) − 在库 − 在途(未收货 PO) + 安全库存
  // 解释：把库存补到「覆盖本批需求 + 安全库存」的水平；补够后重算即归零，形成闭环。
  async function runMrp() {
    let wos = [];
    try { const r = await fetch(`${MES_HTTP}/api/wos`); if (r.ok) { const d = await r.json(); wos = d.wos || []; } } catch (e) { log('MRP 拉取 WO 失败: ' + e.message); }
    const gross = {};
    for (const wo of wos) {
      const bom = cfg.getBomMap(wo.product);
      if (!bom) continue;
      for (const [mat, q] of Object.entries(bom)) gross[mat] = (gross[mat] || 0) + q * (wo.qty || 0);
    }
    const onHand = {}; qStock.all().forEach(s => onHand[s.code] = s.stock);
    const onOrder = {};
    db.prepare("SELECT material, SUM(qty) AS q FROM purchase_orders WHERE status NOT IN ('RECEIVED','CLOSED','REJECTED') GROUP BY material").all().forEach(r => onOrder[r.material] = r.q);
    const items = [];
    Object.keys(gross).forEach(mat => {
      const g = gross[mat] || 0, h = onHand[mat] || 0, o = onOrder[mat] || 0;
      const m = cfg.getMaterial(mat);
      const safety = m ? (m.safety_stock || 0) : 0;
      const net = Math.max(0, g - h - o + safety);
      items.push({ material: mat, name: m ? m.name : mat, gross: +g.toFixed(2), onHand: +h.toFixed(2), onOrder: +o.toFixed(2), safety: +safety.toFixed(2), net: +net.toFixed(2), need: net > 0, leadDays: m ? m.lead_days : 0 });
    });
    items.sort((a, b) => b.net - a.net);
    return { wos: wos.length, items };
  }
  async function applyMrp() {
    const { items } = await runMrp();
    const sup = cfg.getSuppliers()[0];
    let n = 0;
    const created = [];
    for (const it of items) {
      if (it.net > 0) {
        const id = `PO-${Date.now().toString(36).toUpperCase()}-${n}`;
        const m = cfg.getMaterial(it.material);
        safe(() => insPo.run(id, sup ? sup.id : 'SUP-001', it.material, Math.ceil(it.net), m ? m.price : 1000, 'DRAFT', nowISO(), null));
        created.push({ id, material: it.material, qty: Math.ceil(it.net) });
        n++;
      }
    }
    log(`📋 MRP 一键生成 ${n} 张 DRAFT 采购单`);
    return { ok: true, created: n, pos: created };
  }

  // ---------- HTTP ----------
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' };
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS }); res.end(JSON.stringify(obj)); };
  const readBody = req => new Promise((resolve) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } }); });

  // 主数据 CRUD 路由（配置库，经门户代理 /api/erp/config/*）
  function handleConfig(route, req, res) {
    if (route === '/api/erp/config/products') {
      if (req.method === 'GET') return json(res, 200, { products: cfg.getProducts() });
      if (req.method === 'POST') return readBody(req).then(b => { crud.upsertProduct(b); return json(res, 200, { ok: true }); });
    }
    if (route.startsWith('/api/erp/config/products/')) {
      const code = decodeURIComponent(route.slice('/api/erp/config/products/'.length));
      if (req.method === 'DELETE') return json(res, 200, (crud.deleteProduct(code), { ok: true }));
    }
    if (route === '/api/erp/config/materials') {
      if (req.method === 'GET') return json(res, 200, { materials: cfg.getMaterials() });
      if (req.method === 'POST') return readBody(req).then(b => { crud.upsertMaterial(b); return json(res, 200, { ok: true }); });
    }
    if (route.startsWith('/api/erp/config/materials/')) {
      const code = decodeURIComponent(route.slice('/api/erp/config/materials/'.length));
      if (req.method === 'DELETE') return json(res, 200, (crud.deleteMaterial(code), { ok: true }));
    }
    if (route === '/api/erp/config/bom') {
      if (req.method === 'GET') {
        const p = new URL(req.url, `http://${req.headers.host}`).searchParams.get('product');
        return json(res, 200, { product: p, bom: p ? cfg.getBom(p) : cfg.getAllBom() });
      }
      if (req.method === 'POST') return readBody(req).then(b => { crud.setBom(b.product, b.items); return json(res, 200, { ok: true }); });
    }
    if (route === '/api/erp/config/cost-rates') {
      if (req.method === 'GET') return json(res, 200, { costRates: cfg.getCostRates() });
      if (req.method === 'POST') return readBody(req).then(b => { crud.upsertCostRate(b); return json(res, 200, { ok: true }); });
    }
    if (route.startsWith('/api/erp/config/cost-rates/')) {
      const mod = decodeURIComponent(route.slice('/api/erp/config/cost-rates/'.length));
      if (req.method === 'DELETE') { db.prepare('DELETE FROM cost_rates WHERE module=?').run(mod); return json(res, 200, { ok: true }); }
    }
    if (route === '/api/erp/config/suppliers') {
      if (req.method === 'GET') return json(res, 200, { suppliers: cfg.getSuppliers() });
      if (req.method === 'POST') return readBody(req).then(b => { crud.upsertSupplier(b); return json(res, 200, { ok: true }); });
    }
    if (route.startsWith('/api/erp/config/suppliers/')) {
      const id = decodeURIComponent(route.slice('/api/erp/config/suppliers/'.length));
      if (req.method === 'DELETE') return json(res, 200, (crud.deleteSupplier(id), { ok: true }));
    }
    if (route === '/api/erp/config/customers') {
      if (req.method === 'GET') return json(res, 200, { customers: cfg.getCustomers() });
      if (req.method === 'POST') return readBody(req).then(b => { crud.upsertCustomer(b); return json(res, 200, { ok: true }); });
    }
    if (route.startsWith('/api/erp/config/customers/')) {
      const id = decodeURIComponent(route.slice('/api/erp/config/customers/'.length));
      if (req.method === 'DELETE') return json(res, 200, (crud.deleteCustomer(id), { ok: true }));
    }
    if (route === '/api/erp/config/auto-order') {
      if (req.method === 'GET') return json(res, 200, { paused: autoOrderPaused });
      if (req.method === 'POST') return readBody(req).then(b => { autoOrderPaused = !b.enabled; return json(res, 200, { ok: true, paused: autoOrderPaused }); });
    }
    return false;
  }

  function handler(req, res) {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const route = u.pathname;

    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    // ---- 主数据 CRUD ----
    if (route.startsWith('/api/erp/config/')) {
      const r = handleConfig(route, req, res);
      if (r !== false) return;
    }

    if (route === '/api/erp/health') return json(res, 200, { ok: true, service: 'fab-erp', mode: inProc ? 'in-proc' : 'standalone', mesConnected, version: 'ERP-3', vatRate: VAT_RATE, uptime: +process.uptime().toFixed(1) });

    // ---------- 总账 G/L ----------
    if (route === '/api/erp/gl/accounts') return json(res, 200, { accounts: qAccts.all() });
    if (route === '/api/erp/gl/trial') return json(res, 200, trialBalance());
    if (route === '/api/erp/gl/vouchers') {
      const vs = qV.all();
      const out = vs.map(v => ({ ...v, entries: qVe.all(v.id) }));
      return json(res, 200, { count: out.length, vouchers: out });
    }
    if (route === '/api/erp/gl/post' && req.method === 'POST') {
      return readBody(req).then(b => {
        const vid = postVoucher(b.summary || '手工凭证', b.entries || [], b.createdBy || 'MANUAL');
        return json(res, vid ? 200 : 500, vid ? { ok: true, id: vid } : { ok: false, error: '过账失败' });
      });
    }

    // ---------- 应付 / 应收发票 ----------
    if (route === '/api/erp/ap') {
      const st = u.searchParams.get('status') || 'ALL';
      return json(res, 200, { status: st, invoices: qApInv.all(st, st) });
    }
    if (route.startsWith('/api/erp/ap/') && route.endsWith('/pay')) {
      const id = decodeURIComponent(route.slice('/api/erp/ap/'.length, -'/pay'.length));
      return json(res, 200, payAp(id));
    }
    if (route === '/api/erp/ar') {
      const st = u.searchParams.get('status') || 'ALL';
      return json(res, 200, { status: st, invoices: qArInv.all(st, st) });
    }
    if (route.startsWith('/api/erp/ar/') && route.endsWith('/receive')) {
      const id = decodeURIComponent(route.slice('/api/erp/ar/'.length, -'/receive'.length));
      return json(res, 200, receiveAr(id));
    }

    // ---------- MRP ----------
    if (route === '/api/erp/mrp' && req.method === 'GET') {
      return runMrp().then(r => json(res, 200, r));
    }
    if (route === '/api/erp/mrp/apply' && req.method === 'POST') {
      return applyMrp().then(r => json(res, 200, r));
    }

    // ---------- 库存/物料 ----------
    if (route === '/api/erp/materials') {
      const masters = cfg.getMaterials();
      const stocks = {}; qStock.all().forEach(s => stocks[s.code] = s);
      const materials = masters.map(m => ({ ...m, stock: stocks[m.code] ? stocks[m.code].stock : 0 }));
      const low = materials.filter(m => m.cat === 'RAW' && m.stock < m.safety_stock);
      return json(res, 200, { count: materials.length, lowStock: low.length, materials, low });
    }
    if (route === '/api/erp/inventory') {
      const masters = cfg.getMaterials();
      const stocks = {}; qStock.all().forEach(s => stocks[s.code] = s);
      let value = 0;
      masters.forEach(m => { const s = stocks[m.code]; if (s) value += s.stock * (m.price || 0); });
      return json(res, 200, { value: +value.toFixed(0), materials: masters.map(m => ({ code: m.code, stock: stocks[m.code] ? stocks[m.code].stock : 0, price: m.price })) });
    }
    if (route === '/api/erp/tx') {
      const limit = Math.min(200, +(u.searchParams.get('limit') || 50));
      const rows = db.prepare('SELECT * FROM inv_tx ORDER BY id DESC LIMIT ?').all(limit);
      return json(res, 200, { count: rows.length, tx: rows });
    }
    if (route === '/api/erp/suppliers') return json(res, 200, { suppliers: cfg.getSuppliers() });
    if (route === '/api/erp/customers') return json(res, 200, { customers: cfg.getCustomers() });

    // ---------- 采购订单 PO ----------
    if (route === '/api/erp/po' && req.method === 'POST') {
      return readBody(req).then(b => {
        const mat = b.material || 'WAFER-300';
        const m = cfg.getMaterial(mat);
        const id = `PO-${Date.now().toString(36).toUpperCase()}`;
        const status = b.draft ? 'DRAFT' : 'OPEN';
        safe(() => insPo.run(id, b.supplier || 'SUP-001', mat, b.qty || 100, b.price || (m ? m.price : 1000), status, nowISO(), null));
        return json(res, 200, { ok: true, id, material: mat, qty: b.qty || 100, price: b.price || (m ? m.price : 1000), status });
      });
    }
    if (route === '/api/erp/po') return json(res, 200, { count: qPo.all().length, pos: qPo.all() });
    if (route.startsWith('/api/erp/po/') && route.endsWith('/approve')) {
      const id = decodeURIComponent(route.slice('/api/erp/po/'.length, -'/approve'.length));
      return readBody(req).then(b => json(res, 200, approvePo(id, b.approver)));
    }
    if (route.startsWith('/api/erp/po/') && route.endsWith('/receive')) {
      const id = decodeURIComponent(route.slice('/api/erp/po/'.length, -'/receive'.length));
      return json(res, 200, receivePo(id));
    }

    // ---------- 销售订单 SO（P0-1 订单驱动生产）----------
    if (route === '/api/erp/so' && req.method === 'POST') {
      return readBody(req).then(b => {
        const product = b.product || 'N2';
        const qty = Math.max(25, Math.round((b.qty || 25) / 25) * 25);           // 以 25 片(1 lot)为步长对齐
        const customer = b.customer || 'CUS-001';
        const fin = cfg.finCode(product);
        const price = b.price || (cfg.getMaterial(fin)?.price || 30000);
        const id = `SO-${Date.now().toString(36).toUpperCase()}`;
        safe(() => insSo.run(id, customer, product, qty, price, b.due || nowISO(), 'OPEN', nowISO()));
        log(`🛒 SO ${id} 创建：${customer} ${product} ×${qty} @ ${price}`);
        // 订单驱动生产：向 MES 下发工单（携带 soId，主轴贯通 SO→WO→投料→...→发运）
        const lots = Math.max(1, Math.round(qty / 25));
        fetch(`${MES_HTTP}/api/wos`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product, qty: lots, dueHours: b.dueHours || 72, soId: id, customer }),
        }).then(r => r.json()).then(d => log(`🏭 SO ${id} → WO ${(d.wo && d.wo.id) || '?'} 已投料`))
          .catch(e => log(`⚠ SO ${id} 下发 MES 失败: ${e.message}`));
        return json(res, 200, { ok: true, id, product, qty, price, lots, note: '已向 MES 投料，完工后自动发运' });
      });
    }
    if (route === '/api/erp/so') return json(res, 200, { count: qSo.all().length, sos: qSo.all() });
    if (route.startsWith('/api/erp/so/') && route.endsWith('/ship')) {
      const id = decodeURIComponent(route.slice('/api/erp/so/'.length, -'/ship'.length));
      return json(res, 200, shipOrder(id));
    }

    if (route === '/api/erp/costs') {
      const rows = qCost.all();
      const sum = rows.reduce((s, r) => s + r.total_cost, 0);
      const avg = rows.length ? sum / rows.length : 0;
      const byProduct = {};
      rows.forEach(r => { byProduct[r.product] = byProduct[r.product] || { n: 0, sum: 0 }; byProduct[r.product].n++; byProduct[r.product].sum += r.total_cost; });
      return json(res, 200, { count: rows.length, totalCost: +sum.toFixed(0), avgCost: +avg.toFixed(0), byProduct, batches: rows.slice(0, 50) });
    }
    if (route === '/api/erp/arap') {
      const rows = qArap.all();
      const ap = rows.filter(r => r.kind === 'AP').reduce((s, r) => s + r.amount, 0);
      const ar = rows.filter(r => r.kind === 'AR').reduce((s, r) => s + r.amount, 0);
      return json(res, 200, { count: rows.length, apTotal: +ap.toFixed(0), arTotal: +ar.toFixed(0), rows: rows.slice(0, 50) });
    }

    return json(res, 404, { error: 'not found' });
  }

  // 独立进程模式：自建 WS 订阅 MES（向后兼容）
  let ws = null;
  async function reconcileWithMES() {
    try {
      const r = await fetch(`${MES_HTTP}/api/wip`);
      if (r.ok) {
        const wip = await r.json();
        const lots = wip.lots || [];
        const issued = new Set(db.prepare("SELECT DISTINCT ref FROM inv_tx WHERE type='ISSUE'").all().map(x => x.ref));
        let n = 0;
        for (const l of lots) {
          if (!issued.has(l.id)) {
            const wo = woCache.get(l.wo);
            issueBom(wo ? wo.product : (l.product || 'N2'), l.id);
            n++;
          }
        }
        if (n) log(`🔄 WS 重连补偿：补领料 ${n} 批，ERP 库存已与 MES 对齐`);
      }
      try {
        const h = await fetch(`${MES_HTTP}/api/history/events?type=lotDone&limit=300`);
        if (h.ok) {
          const hj = await h.json();
          const evs = (hj.events || []).filter(e => e.lot && e.product);
          const costed = new Set(db.prepare('SELECT DISTINCT lot FROM cost_batches').all().map(x => x.lot));
          let m = 0;
          for (const e of evs) {
            if (!costed.has(e.lot)) {
              receiveFinish(e.product, e.lot);
              costLot(e.lot, e.product, e.cycleH || 0);
              autoShip(e.product);
              m++;
            }
          }
          if (m) log(`🔄 WS 重连补偿：补成本归集 ${m} 批`);
        }
      } catch (e2) { log('重连成本补算失败: ' + e2.message); }
    } catch (e) { log('重连对账失败: ' + e.message); }
  }
  // C4：断连空窗连续重放——基于 /api/events 的 seq 游标轮询，循环补偿错过的中间事件
  // （实时 WS 已消费 live 事件；此处专门闭合「断连期间」丢失的 lotRelease/lotHold 等中间事件）
  let lastSeq = 0;
  let replayStarted = false;
  async function pollReplay() {
    try {
      const r = await fetch(`${MES_HTTP}/api/events?after=${lastSeq}&limit=500`);
      if (!r.ok) return;
      const j = await r.json();
      const evs = (j.events || []).filter(e => e && e.type);
      evs.sort((a, b) => (a.seq || 0) - (b.seq || 0));
      for (const e of evs) { if ((e.seq || 0) > lastSeq) { lastSeq = e.seq; handleMesEvent(e); } }
    } catch (_) { /* 重放失败下次重试，不阻塞主流程 */ }
  }
  function connectMESStandalone(mesWsUrl) {
    const WebSocket = require('ws');
    ws = new WebSocket(mesWsUrl);
    ws.on('open', () => {
      mesConnected = true; log('已连接 MES 事件流(standalone)');
      reconcileWithMES();
      if (!replayStarted) { replayStarted = true; setInterval(pollReplay, 4000); }   // C4：启动连续重放，闭合断连空窗
    });
    ws.on('message', raw => {
      let ev; try { ev = JSON.parse(raw); } catch (e) { return; }
      if (ev && ev.seq) lastSeq = Math.max(lastSeq, ev.seq);   // 推进游标，避免重放重复处理 live 已消费事件
      handleMesEvent(ev);
    });
    ws.on('close', () => { mesConnected = false; log('MES 事件流断开，3s 重连'); setTimeout(() => connectMESStandalone(mesWsUrl), 3000); });
    ws.on('error', e => { log('WS 错误: ' + e.message); });
  }

  // ERP 自动接单器（P0-1 主轴驱动）：周期性生成真实 SO → 向 MES 投料(WO)，使整条 OTD 主轴自驱动、可持续验收
  let autoOrderPaused = false; // 复现/演示期间可暂停，避免拥堵单张样品 SO
  function startAutoOrders(ms) {
    const interval = Math.max(5000, ms || 20000);
    log(`🤖 ERP 自动接单器已启动（每 ${(interval / 1000)}s 一张 SO）`);
    setInterval(() => {
      if (autoOrderPaused) return;
      try {
        const product = Math.random() < 0.5 ? 'N2' : 'A16';
        const qty = (1 + Math.floor(Math.random() * 3)) * 25;   // 25/50/75 片
        const custs = cfg.getCustomers();
        const c = (custs && custs.length) ? custs[Math.floor(Math.random() * custs.length)] : null;
        const customer = (c && (c.id || c.code)) || 'CUS-001';
        const price = cfg.getMaterial(cfg.finCode(product))?.price || 30000;
        const id = `SO-${Date.now().toString(36).toUpperCase()}`;
        safe(() => insSo.run(id, customer, product, qty, price, nowISO(), 'OPEN', nowISO()));
        const lots = Math.max(1, Math.round(qty / 25));
        fetch(`${MES_HTTP}/api/wos`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product, qty: lots, dueHours: 96, soId: id, customer }),
        }).then(r => r.json()).then(d => log(`🤖 自动接单 ${id} ${product}×${qty} → WO ${(d.wo && d.wo.id) || '?'}`))
          .catch(e => log(`⚠ 自动接单下发失败: ${e.message}`));
      } catch (e) { log('自动接单异常: ' + e.message); }
    }, interval);
  }

  return {
    handler, handleMesEvent, db, refreshWoCaches, log, cfg,
    connectMESStandalone, startAutoOrders,
    listen(port) {
      const server = http.createServer(handler);
      refreshWoCaches();
      if (!inProc) connectMESStandalone(process.env.MES_WS || 'ws://127.0.0.1:8124');
      const autoMs = +(process.env.ERP_AUTO_SO_MS || 0);
      if (autoMs > 0) startAutoOrders(autoMs);
      else if (!inProc) startAutoOrders(20000);   // 独立进程默认开启接单器，驱动 OTD 主轴
      server.listen(port, () => {
        log(`fab-erp 原生 ERP 已启动 :${port}（${inProc ? 'in-proc 底座模式' : 'standalone 独立进程'}）`);
      });
      return server;
    },
  };
}

module.exports = { createErpService };
