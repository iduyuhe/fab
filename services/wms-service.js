// ============================================================
//  WMS 服务（仓储执行域，独立于 ERP 财务台账）
//  ------------------------------------------------------------
//  由 fab-wms.js（独立进程入口）与未来可能的 in-proc 共用同一份逻辑。
//
//  createWmsService({ dbPath, mesHttp, erpHttp, inProc })
//    → 返回 { handler, handleMesEvent, db, reconcileWithMES, connectMESStandalone,
//             goodsReceipt, putaway, shipOrder, kitStatus, traceBatch, checkReplenish,
//             createStocktake, countStocktake, createWave, pickWave, closeWave, log, listen }
//
//  领域定位（CONTRACT §1.2）：
//    ERP = 财务台账（materials 表 stock + 成本/应收应付）
//    WMS = 实物执行层（库位 / 批次库存 / 上架规则 / 拣货齐套 / 盘点 / 波次 / 补货 / 收发流水）
//    两者订阅同一 MES 真相源(lotRelease/lotDone)派生，自然对齐、互不回推。
//  留痕：WMS 拥有独立 wms_tx 收发流水（不可变仓储执行日志）。
//
//  Phase 2 新增（相对 Phase 0/1）：库位策略与上架规则引擎、库存盘点、波次拣货、
//    条码/批次级追溯、安全库存联动补货（与 ERP MRP/PO 审批流衔接）。
// ============================================================
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { openConfig, buildStore } = require('../storage/configdb');

function createWmsService({ dbPath, mesHttp, erpHttp, inProc = false } = {}) {
  const DB_PATH = dbPath || path.join(__dirname, '..', 'fab-wms.db');
  const MES_HTTP = mesHttp || process.env.MES_HTTP || 'http://127.0.0.1:8124';
  const ERP_HTTP = erpHttp || process.env.ERP_HTTP || 'http://127.0.0.1:8126';
  // MES 连接状态：in-proc 模式经 eventbus 订阅即视为已连；standalone 由 WS open/close 维护
  let mesConnected = !!inProc;

  // 共享配置库（主数据只读消费，ERP 持有写权）；WMS 只读打开（readOnly=true），
  // 避免与 ERP 抢写锁导致 database is locked 崩溃（2026-09-01 真机实测）。
  const cfgDb = openConfig(path.join(__dirname, '..', 'fab-config.db'), true);
  const cfg = buildStore(cfgDb);

  // ---------- SQLite ----------
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS locations(
      code TEXT PRIMARY KEY, zone TEXT, kind TEXT, capacity REAL, occupied REAL
    );
    CREATE TABLE IF NOT EXISTS inventory(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, material TEXT, batch TEXT,
      qty REAL, loc_code TEXT, status TEXT, note TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, type TEXT, ref TEXT,
      material TEXT, qty REAL, loc_code TEXT, status TEXT, note TEXT, wave_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS wms_tx(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, type TEXT, material TEXT,
      batch TEXT, qty REAL, loc_from TEXT, loc_to TEXT, ref TEXT, note TEXT
    );
    CREATE TABLE IF NOT EXISTS putaway_rules(
      id INTEGER PRIMARY KEY AUTOINCREMENT, mat_cat TEXT UNIQUE, strategy TEXT,
      target_zone TEXT, note TEXT
    );
    CREATE TABLE IF NOT EXISTS stocktaking(
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, zone TEXT, status TEXT,
      created TEXT, counted TEXT, note TEXT
    );
    CREATE TABLE IF NOT EXISTS stocktake_items(
      id INTEGER PRIMARY KEY AUTOINCREMENT, st_id INTEGER, material TEXT, loc_code TEXT,
      book_qty REAL, count_qty REAL, diff REAL, adjusted INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS waves(
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, status TEXT,
      created TEXT, note TEXT
    );
    CREATE TABLE IF NOT EXISTS wave_tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, wave_id INTEGER, task_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS replenish(
      id INTEGER PRIMARY KEY AUTOINCREMENT, material TEXT, on_hand REAL, safety REAL,
      suggested REAL, status TEXT, created TEXT, po_id TEXT
    );
  `);
  // 兼容旧库：补列（失败忽略）
  try { db.exec('ALTER TABLE inventory ADD COLUMN lot_no TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE wms_tx ADD COLUMN lot_no TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE tasks ADD COLUMN wave_id INTEGER'); } catch (e) {}

  const nowISO = () => new Date().toISOString();
  const safe = fn => { try { fn(); } catch (e) { log('DB 异常: ' + e.message); } };
  const log = (msg) => console.log(`[WMS ${new Date().toTimeString().slice(0, 8)}] ${msg}`);

  // 预置语句
  const insLoc = db.prepare('INSERT OR IGNORE INTO locations(code,zone,kind,capacity,occupied) VALUES(?,?,?,?,?)');
  const qLoc = db.prepare('SELECT * FROM locations ORDER BY kind, code');
  const updLocOcc = db.prepare('UPDATE locations SET occupied=MAX(0,occupied+?) WHERE code=?');
  const qLocByKind = db.prepare('SELECT * FROM locations WHERE kind=? ORDER BY code');
  const insInv = db.prepare('INSERT INTO inventory(ts,material,batch,lot_no,qty,loc_code,status,note) VALUES(?,?,?,?,?,?,?,?)');
  const qInv = db.prepare('SELECT * FROM inventory ORDER BY id DESC LIMIT 500');
  const findInv = db.prepare('SELECT * FROM inventory WHERE material=? AND batch=? AND loc_code=?');
  const adjInv = db.prepare('UPDATE inventory SET qty=qty+? WHERE material=? AND batch=? AND loc_code=?');
  const qInvMat = db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM inventory WHERE material=?');
  const qFinMat = db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM inventory WHERE material=? AND loc_code=?');
  const insTask = db.prepare('INSERT INTO tasks(ts,type,ref,material,qty,loc_code,status,note,wave_id) VALUES(?,?,?,?,?,?,?,?,?)');
  const qTasksOpen = db.prepare("SELECT * FROM tasks WHERE status<>'DONE' ORDER BY id DESC LIMIT 200");
  const qTasksAll = db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT 200');
  const qTasksByType = db.prepare("SELECT * FROM tasks WHERE type=? AND status='OPEN' ORDER BY id");
  const updTask = db.prepare("UPDATE tasks SET status=?, note=?, wave_id=? WHERE id=?");
  const insTx = db.prepare('INSERT INTO wms_tx(ts,type,material,batch,lot_no,qty,loc_from,loc_to,ref,note) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const qTx = db.prepare('SELECT * FROM wms_tx ORDER BY id DESC LIMIT ?');
  const qTxByBatch = db.prepare('SELECT * FROM wms_tx WHERE batch=? ORDER BY id');

  // 主数据：BOM / 成品映射 现由共享配置库 cfg 提供（Phase 0 外置）

  // 预置库位（收货暂存 / 原料立库(分区) / 成品库(分区) / 产线暂存 / 隔离区）
  const SEED_LOCATIONS = [
    ['RCV-01', '收货暂存区', 'STAGE', 0, 0],
    ['STAGE-A', '产线暂存A', 'STAGE', 0, 0],
    ['STAGE-B', '产线暂存B', 'STAGE', 0, 0],
    ['WH-RAW-01', '原料立库-A区', 'RAW', 2000000, 0],
    ['WH-RAW-02', '原料立库-B区', 'RAW', 2000000, 0],
    ['WH-FIN-01', '成品库-A区', 'FIN', 9999999, 0],
    ['WH-FIN-02', '成品库-B区', 'FIN', 9999999, 0],
    ['QA-HOLD', '质检隔离区', 'QUAR', 0, 0],
  ];
  SEED_LOCATIONS.forEach(l => safe(() => insLoc.run(l[0], l[1], l[2], l[3], l[4])));

  // 上架规则（Phase 2-1）：按物料类别匹配目标库位区 + 策略
  const SEED_RULES = [
    { mat_cat: 'RAW', strategy: 'LEAST', target_zone: 'WH-RAW', note: '原料→原料立库（最少占用分区）' },
    { mat_cat: 'FIN', strategy: 'LEAST', target_zone: 'WH-FIN', note: '成品→成品库（最少占用分区）' },
    { mat_cat: 'QUAR', strategy: 'FIXED', target_zone: 'QA-HOLD', note: '异常品→质检隔离区' },
  ];
  const insRule = db.prepare('INSERT OR IGNORE INTO putaway_rules(mat_cat,strategy,target_zone,note) VALUES(?,?,?,?)');
  SEED_RULES.forEach(r => safe(() => insRule.run(r.mat_cat, r.strategy, r.target_zone, r.note)));
  const qRules = db.prepare('SELECT * FROM putaway_rules ORDER BY mat_cat');
  const updRule = db.prepare('UPDATE putaway_rules SET strategy=?, target_zone=?, note=? WHERE mat_cat=?');
  const insRuleNew = db.prepare('INSERT INTO putaway_rules(mat_cat,strategy,target_zone,note) VALUES(?,?,?,?) ON CONFLICT(mat_cat) DO UPDATE SET strategy=excluded.strategy,target_zone=excluded.target_zone,note=excluded.note');

  // 预置原材料备料（仅当库存表为空时；从配置库主数据取 RAW 料，供 lotRelease 齐套拣货）
  const invCount = db.prepare('SELECT COUNT(*) AS n FROM inventory').get().n;
  if (invCount === 0) {
    cfg.getMaterials().filter(m => m.cat === 'RAW').forEach(m => safe(() => insInv.run(nowISO(), m.code, 'LOT-SEED', null, 50000, 'WH-RAW-01', 'STORED', '初始备料')));
    log('已预置原材料备料（WH-RAW-01 ×50000/料，源自配置库主数据）');
  }

  // 工单缓存：lotRelease/lotDone 需从 MES 取 product
  const woCache = new Map();
  async function refreshWoCaches() {
    try {
      const r = await fetch(`${MES_HTTP}/api/wos`);
      if (r.ok) { const d = await r.json(); (d.wos || []).forEach(w => woCache.set(w.id, w)); }
    } catch (e) { /* MES 未起，跳过 */ }
  }

  // ---------- 库存动作 ----------
  function adjust(material, batch, loc, delta, status, lotNo) {
    const ex = findInv.get(material, batch, loc);
    if (ex) safe(() => adjInv.run(delta, material, batch, loc));
    else safe(() => insInv.run(nowISO(), material, batch, lotNo || null, delta, loc, status || 'STORED', ''));
    safe(() => updLocOcc.run(delta, loc));
  }
  function wmsTx(type, material, batch, qty, from, to, ref, note, lotNo) {
    safe(() => insTx.run(nowISO(), type, material, batch, lotNo || null, qty, from, to, ref, note));
  }
  function productOf(ev) {
    const wo = ev.wo && woCache.get(ev.wo);
    if (wo && wo.product) return wo.product;
    if (ev.product) return ev.product;
    return 'N2';
  }

  // ---------- Phase 2-1 上架规则引擎 ----------
  // 按物料类别匹配规则，返回推荐库位（LEAST：候选分区中库存最少者；FIXED：固定库位）
  function recommendLoc(material) {
    // 成品码(FIN-*)未必登记在 materials 主数据，按前缀兜底归类为 FIN → 成品库
    let cat = (material && String(material).startsWith('FIN-')) ? 'FIN' : null;
    const m = cfg.getMaterial(material);
    cat = cat || (m && m.cat) || 'RAW';
    const rule = db.prepare('SELECT * FROM putaway_rules WHERE mat_cat=?').get(cat) ||
                 db.prepare('SELECT * FROM putaway_rules WHERE mat_cat=?').get('RAW');
    if (!rule) return 'WH-RAW-01';
    if (rule.strategy === 'FIXED') return rule.target_zone;
    // LEAST：候选分区（target_zone 前缀匹配 kind）
    const cands = qLocByKind.all(cat);
    if (!cands.length) return rule.target_zone || 'WH-RAW-01';
    let best = cands[0];
    let bestQty = Infinity;
    for (const c of cands) {
      const q = db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM inventory WHERE loc_code=?').get(c.code).q;
      if (q < bestQty) { bestQty = q; best = c; }
    }
    return best.code;
  }

  // 齐套检查（实物层）：BOM 各料在库是否充足
  function kitCheckRaw(product) {
    const bom = cfg.getBomMap(product);
    const missing = [];
    for (const [mat, q] of Object.entries(bom)) {
      const r = qInvMat.get(mat);
      const have = r ? r.q : 0;
      if (have < q) missing.push({ material: mat, need: q, have });
    }
    return { ok: missing.length === 0, missing };
  }

  // ---------- 事件联动（经 MES 事件总线 onEmit / WS 触发）----------
  function handleMesEvent(ev) {
    try {
      if (ev.type === 'lotRelease') {
        const product = productOf(ev);
        const bom = cfg.getBomMap(product);
        const kit = kitCheckRaw(product);
        // 实物拣货：从原料立库扣减，入 STAGE-A，写收发流水 + 拣货任务
        for (const [mat, q] of Object.entries(bom)) {
          adjust(mat, `PK-${ev.lot}`, 'WH-RAW-01', -q, 'PICKED');   // 原料出库
          adjust(mat, `PK-${ev.lot}`, 'STAGE-A', q, 'PICKED');    // 转入产线暂存
          wmsTx('PICK', mat, `PK-${ev.lot}`, -q, 'WH-RAW-01', 'STAGE-A', ev.lot, `lotRelease 拣货 ${ev.lot}`);
        }
        const sum = Object.values(bom).reduce((s, q) => s + q, 0);
        safe(() => insTask.run(nowISO(), 'PICK', ev.lot, product, sum, 'STAGE-A', 'DONE', `齐套${kit.ok ? '通过' : '告警'}`, null));
        log(`📦 拣货 ${ev.lot} (${product}) 齐套${kit.ok ? '✓' : '✗ 缺料'}`);
      } else if (ev.type === 'lotDone') {
        if (ev.lot && ev.product) {
          const fin = cfg.finCode ? cfg.finCode(ev.product) : ('FIN-' + String(ev.product).toUpperCase());
          if (fin) {
            const loc = recommendLoc(fin);   // Phase 2-1：按规则选成品库分区
            adjust(fin, `FG-${ev.lot}`, loc, 25, 'STORED', ev.lot);   // 成品入库（规则推荐位）
            wmsTx('PUTAWAY', fin, `FG-${ev.lot}`, 25, 'STAGE-A', loc, ev.lot, `完工上架 ${ev.lot} → ${loc}`, ev.lot);
            safe(() => insTask.run(nowISO(), 'PUTAWAY', ev.lot, fin, 25, loc, 'DONE', '完工上架', null));
            // 消耗产线暂存区的原料（与 PICK 转入对应，保持账实一致）
            const bom = cfg.getBomMap(ev.product);
            for (const [mat, q] of Object.entries(bom)) adjust(mat, `PK-${ev.lot}`, 'STAGE-A', -q, 'CONSUMED');
            log(`🏬 上架 ${ev.lot} → ${fin} ×25 → ${loc}`);
          }
        }
      } else if (ev.type === 'shipment') {
        // P0-2 双域一致：财务发运(shipment 事件) → 实物同步从成品库扣减发运，账实一致
        if (ev.so && ev.product) {
          const fin = cfg.finCode ? cfg.finCode(ev.product) : ('FIN-' + String(ev.product).toUpperCase());
          const r = shipOrder({ order: ev.so, material: fin, qty: ev.qty });
          log(`🚚 收 MES 发运事件 → 实物发运 ${ev.so} ${fin} ×${ev.qty} → ${r.ok ? 'OK' : (r.reason || 'FAIL')}`);
        }
      }
    } catch (e) { log('WMS 事件处理异常: ' + e.message); }
  }

  // ---------- 独立仓储操作 ----------
  function goodsReceipt({ po, material, qty } = {}) {
    const mat = material || 'WAFER-300';
    const q = Math.max(1, +(qty || 100));
    const grId = `GR-${Date.now().toString(36).toUpperCase()}`;
    adjust(mat, `GR-${grId}`, 'RCV-01', q, 'RECEIVED');
    wmsTx('GR', mat, `GR-${grId}`, q, '', 'RCV-01', po || '', `采购收货 ${po || ''}`, `GR-${grId}`);
    safe(() => insTask.run(nowISO(), 'PUTAWAY', grId, mat, q, 'RCV-01', 'OPEN', '待上架', null));
    log(`📥 收货 GR ${grId} ${mat} ×${q} → RCV-01`);
    return { ok: true, grId, material: mat, qty: q };
  }
  function putaway({ taskId, locCode } = {}) {
    const t = db.prepare("SELECT * FROM tasks WHERE id=? AND type='PUTAWAY' AND status IN ('OPEN','WAVE')").get(taskId);
    if (!t) return { ok: false, error: '上架任务不存在或非待上架' };
    const loc = locCode || recommendLoc(t.material);  // Phase 2-1：未指定则按规则推荐
    adjust(t.material, `GR-${t.ref}`, 'RCV-01', -t.qty, 'STORED');  // 从暂存扣减
    adjust(t.material, `GR-${t.ref}`, loc, t.qty, 'STORED');         // 上架到目标库位
    wmsTx('PUTAWAY', t.material, `GR-${t.ref}`, t.qty, 'RCV-01', loc, t.ref, `上架 ${loc}`, `GR-${t.ref}`);
    safe(() => updTask.run('DONE', `已上架 ${loc}`, t.wave_id || null, taskId));
    log(`🏬 上架 ${t.material} ×${t.qty} → ${loc}`);
    // 若属波次，检查波次是否全部完成
    if (t.wave_id) safe(() => closeWaveIfDone(t.wave_id));
    return { ok: true, taskId, material: t.material, locCode: loc };
  }
  function shipOrder({ order, material, qty } = {}) {
    const mat = material || 'FIN-N2';
    const want = Math.max(1, +(qty || 25));
    const have = (qFinMat.get(mat, 'WH-FIN-01') || { q: 0 }).q + (qFinMat.get(mat, 'WH-FIN-02') || { q: 0 }).q;
    const q = Math.min(want, Math.max(0, +have));
    const soId = order || `SO-${Date.now().toString(36).toUpperCase()}`;
    if (q <= 0) {
      log(`⚠ 发运 ${mat} 在库为 0，拒绝超发 ${soId}（账实一致保护）`);
      return { ok: false, order: soId, material: mat, qty: 0, want, reason: 'on-hand-insufficient' };
    }
    // 从两个成品分区各发一部分（优先 A 区）
    let remain = q;
    for (const loc of ['WH-FIN-01', 'WH-FIN-02']) {
      if (remain <= 0) break;
      const h = (qFinMat.get(mat, loc) || { q: 0 }).q;
      const take = Math.min(remain, Math.max(0, +h));
      if (take > 0) { adjust(mat, `SHIP-${soId}`, loc, -take, 'SHIPPED'); remain -= take; }
    }
    wmsTx('SHIP', mat, `SHIP-${soId}`, -q, 'WH-FIN-01', '', soId, `销售发运 ${soId}${q < want ? ' (部分发运)' : ''}`, `SHIP-${soId}`);
    log(`🚚 发运 ${mat} ×${q} → ${soId}${q < want ? ' 部分(在库不足)' : ''}`);
    return { ok: true, order: soId, material: mat, qty: q, partial: q < want, want };
  }

  // 齐套状态：拉在制批次（MES /api/lots 含 product），逐个判定
  async function kitStatus(lot) {
    const out = [];
    let lots = [];
    try {
      const r = await fetch(`${MES_HTTP}/api/lots`);
      if (r.ok) { const d = await r.json(); lots = d.lots || []; }
    } catch (e) { /* MES 未起 */ }
    const list = lot ? lots.filter(l => l.id === lot) : lots;
    for (const l of list) {
      const product = productOf(l);
      const kit = kitCheckRaw(product);
      out.push({ lot: l.id, product, ok: kit.ok, missing: kit.missing });
    }
    return { count: out.length, kits: out };
  }

  // ---------- Phase 2-4 批次/条码级追溯 ----------
  async function traceBatch(batch) {
    const tx = qTxByBatch.all(batch);
    const inv = db.prepare("SELECT loc_code, qty, status, ts, note FROM inventory WHERE batch=? OR lot_no=? ORDER BY id DESC").all(batch, batch);
    const events = tx.map(r => ({ ts: r.ts, type: r.type, material: r.material, qty: r.qty, from: r.loc_from, to: r.loc_to, ref: r.ref, note: r.note }));
    return { batch, lifecycle: events, currentInventory: inv, steps: events.length };
  }

  // ---------- Phase 2-2 库存盘点 ----------
  function createStocktake({ zone } = {}) {
    const code = `STK-${Date.now().toString(36).toUpperCase()}`;
    safe(() => db.prepare('INSERT INTO stocktaking(code,zone,status,created,note) VALUES(?,?,?,?,?)').run(code, zone || 'ALL', 'DRAFT', nowISO(), ''));
    // 生成盘点明细：当前在库各 (material, loc) 的账面数
    const rows = db.prepare('SELECT material, loc_code, SUM(qty) AS q FROM inventory GROUP BY material, loc_code HAVING q<>0').all();
    const stId = db.prepare('SELECT id FROM stocktaking WHERE code=?').get(code).id;
    const ins = db.prepare('INSERT INTO stocktake_items(st_id,material,loc_code,book_qty,count_qty,diff,adjusted) VALUES(?,?,?,?,?,?,0)');
    rows.forEach(r => safe(() => ins.run(stId, r.material, r.loc_code, r.q, null, null)));
    log(`📋 生成盘点单 ${code}（${rows.length} 行，区域 ${zone || 'ALL'}）`);
    return { ok: true, code, id: stId, items: rows.length };
  }
  function countStocktake(id, counts) {
    // 特殊模式：'all' 或空数组 → 实盘=账面（无差异）；'random' → 部分行注入随机差异
    if (counts === 'all' || (Array.isArray(counts) && counts.length === 0)) {
      db.prepare('UPDATE stocktake_items SET count_qty=book_qty, diff=0, adjusted=0 WHERE st_id=?').run(id);
    } else if (counts === 'random') {
      const items = db.prepare('SELECT * FROM stocktake_items WHERE st_id=?').all(id);
      const upd = db.prepare('UPDATE stocktake_items SET count_qty=?, diff=COALESCE(count_qty,0)-book_qty, adjusted=0 WHERE id=?');
      items.forEach(it => {
        if (Math.random() < 0.5) { // 约半数行产生 ±0~20% 随机差异
          const delta = +(it.book_qty * (Math.random() * 0.4 - 0.2)).toFixed(2);
          const cnt = Math.max(0, +(it.book_qty + delta).toFixed(2));
          upd.run(cnt, it.id);
        } else {
          upd.run(it.book_qty, it.id);
        }
      });
    } else {
      // 显式录入：[{material, loc_code, count_qty}]
      const arr = Array.isArray(counts) ? counts : [counts];
      arr.forEach(c => {
        db.prepare('UPDATE stocktake_items SET count_qty=?, diff=COALESCE(count_qty,0)-book_qty, adjusted=0 WHERE st_id=? AND material=? AND loc_code=?')
          .run(c.count_qty, id, c.material, c.loc_code);
      });
    }
    const items = db.prepare('SELECT * FROM stocktake_items WHERE st_id=?').all(id);
    const diffCount = items.filter(i => i.diff && Math.abs(i.diff) > 1e-6).length;
    safe(() => db.prepare("UPDATE stocktaking SET status='COUNTING', counted=? WHERE id=?").run(nowISO(), id));
    log(`📋 盘点单 #${id} 录入完成，差异行 ${diffCount}`);
    return { ok: true, id, items: items.length, diffLines: diffCount };
  }
  function adjustStocktake(id) {
    const items = db.prepare('SELECT * FROM stocktake_items WHERE st_id=? AND adjusted=0 AND diff IS NOT NULL AND abs(diff)>1e-6').all(id);
    let n = 0;
    items.forEach(it => {
      // 用调整差额更新库存（盘盈加、盘亏减），批次记 STK-<code>
      const st = db.prepare('SELECT code FROM stocktaking WHERE id=?').get(id);
      const batch = `STK-${st.code}`;
      adjust(it.material, batch, it.loc_code, it.diff, 'STORED');
      wmsTx('ADJ', it.material, batch, it.diff, it.loc_code, it.loc_code, st.code, `盘点调整 ${it.material}@${it.loc_code} 差异 ${it.diff}`, batch);
      db.prepare('UPDATE stocktake_items SET adjusted=1 WHERE id=?').run(it.id);
      n++;
    });
    const st = db.prepare('SELECT * FROM stocktaking WHERE id=?').get(id);
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM stocktake_items WHERE st_id=? AND adjusted=0 AND diff IS NOT NULL AND abs(diff)>1e-6').get(id).n;
    const newStatus = remaining === 0 ? 'ADJUSTED' : 'DIFFERENT';
    safe(() => db.prepare("UPDATE stocktaking SET status=? WHERE id=?").run(newStatus, id));
    log(`📋 盘点单 #${id} 过账调整 ${n} 行 → ${newStatus}`);
    return { ok: true, id, adjusted: n, status: newStatus };
  }

  // ---------- Phase 2-3 波次拣货（入向上架波次）----------
  function createWave({ taskIds, note } = {}) {
    const ids = (taskIds && taskIds.length) ? taskIds : qTasksByType.all('PUTAWAY').slice(0, 10).map(t => t.id);
    if (!ids.length) return { ok: false, error: '无待上架任务可组波次' };
    const code = `WAVE-${Date.now().toString(36).toUpperCase()}`;
    safe(() => db.prepare('INSERT INTO waves(code,status,created,note) VALUES(?,?,?,?)').run(code, 'OPEN', nowISO(), note || ''));
    const waveId = db.prepare('SELECT id FROM waves WHERE code=?').get(code).id;
    const link = db.prepare('INSERT INTO wave_tasks(wave_id,task_id) VALUES(?,?)');
    const setWave = db.prepare("UPDATE tasks SET status='WAVE', wave_id=? WHERE id=? AND status='OPEN'");
    ids.forEach(tid => { safe(() => link.run(waveId, tid)); safe(() => setWave.run(waveId, tid)); });
    log(`🌊 生成波次 ${code}（${ids.length} 个上架任务）`);
    return { ok: true, code, id: waveId, tasks: ids.length };
  }
  function pickWave(id) {
    const w = db.prepare('SELECT * FROM waves WHERE id=?').get(id);
    if (!w) return { ok: false, error: '波次不存在' };
    if (w.status !== 'OPEN') return { ok: false, error: '当前状态(' + w.status + ') 不可开始拣选' };
    safe(() => db.prepare("UPDATE waves SET status='PICKING' WHERE id=?").run(id));
    safe(() => db.prepare("UPDATE tasks SET status='WAVE' WHERE id IN (SELECT task_id FROM wave_tasks WHERE wave_id=?)").run(id));
    log(`🌊 波次 #${id} 开始拣选`);
    return { ok: true, id, status: 'PICKING' };
  }
  function closeWaveIfDone(waveId) {
    const total = db.prepare('SELECT COUNT(*) AS n FROM wave_tasks WHERE wave_id=?').get(waveId).n;
    const done = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id IN (SELECT task_id FROM wave_tasks WHERE wave_id=?) AND status='DONE'").get(waveId).n;
    if (total > 0 && done === total) {
      safe(() => db.prepare("UPDATE waves SET status='CLOSED' WHERE id=?").run(waveId));
      log(`🌊 波次 #${waveId} 全部上架完成 → CLOSED`);
    }
  }
  function closeWave(id) {
    const w = db.prepare('SELECT * FROM waves WHERE id=?').get(id);
    if (!w) return { ok: false, error: '波次不存在' };
    safe(() => db.prepare("UPDATE waves SET status='CLOSED' WHERE id=?").run(id));
    const tasks = db.prepare('SELECT task_id FROM wave_tasks WHERE wave_id=?').all(id);
    tasks.forEach(t => safe(() => db.prepare("UPDATE tasks SET status='DONE' WHERE id=? AND status<>'DONE'").run(t.task_id)));
    log(`🌊 波次 #${id} 强制关闭`);
    return { ok: true, id, status: 'CLOSED' };
  }

  // ---------- Phase 2-5 安全库存联动补货 ----------
  function checkReplenish() {
    const masters = cfg.getMaterials().filter(m => m.cat === 'RAW');
    let created = 0;
    masters.forEach(m => {
      const onHand = (qInvMat.get(m.code) || { q: 0 }).q;
      const safety = m.safety_stock || 0;
      if (onHand < safety) {
        const exist = db.prepare("SELECT id FROM replenish WHERE material=? AND status='OPEN'").get(m.code);
        if (!exist) {
          const suggested = Math.max(safety - onHand, 0) + Math.round(safety * 0.2); // 补到安全库存 + 20% 缓冲
          safe(() => db.prepare('INSERT INTO replenish(material,on_hand,safety,suggested,status,created,po_id) VALUES(?,?,?,?,?,?,?)')
            .run(m.code, onHand, safety, suggested, 'OPEN', nowISO(), null));
          created++;
        }
      }
    });
    log(`🔔 安全库存检查：新增补货建议 ${created} 条`);
    return { ok: true, created };
  }
  async function orderReplenish(id) {
    const r = db.prepare('SELECT * FROM replenish WHERE id=?').get(id);
    if (!r) return { ok: false, error: '补货建议不存在' };
    if (r.status !== 'OPEN') return { ok: false, error: '当前状态(' + r.status + ') 不可下单' };
    // 联动 ERP：生成 DRAFT 采购单（进审批流）
    try {
      const resp = await fetch(`${ERP_HTTP}/api/erp/po`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ material: r.material, qty: r.suggested, draft: true, supplier: 'SUP-001' }),
      });
      const d = await resp.json();
      if (d.ok) {
        safe(() => db.prepare("UPDATE replenish SET status='ORDERED', po_id=? WHERE id=?").run(d.id, id));
        log(`🔔 补货建议 #${id} → ERP 采购单 ${d.id}（DRAFT）`);
        return { ok: true, id, poId: d.id, status: 'ORDERED' };
      }
      return { ok: false, error: 'ERP 下单失败', detail: d };
    } catch (e) {
      return { ok: false, error: 'ERP 不可达: ' + e.message };
    }
  }

  // ---------- HTTP ----------
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS }); res.end(JSON.stringify(obj)); };
  const readBody = req => new Promise((resolve) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } }); });

  function handler(req, res) {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const route = u.pathname;

    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    if (route === '/api/wms/health') return json(res, 200, { ok: true, service: 'fab-wms', mode: inProc ? 'in-proc' : 'standalone', mesConnected, version: 'WMS-2', uptime: +process.uptime().toFixed(1) });
    if (route === '/api/wms/locations') {
      const locs = qLoc.all();
      return json(res, 200, { count: locs.length, locations: locs });
    }
    if (route === '/api/wms/inventory') {
      const cat = u.searchParams.get('cat');
      let rows;
      if (cat === 'FIN') rows = db.prepare("SELECT * FROM inventory WHERE material LIKE 'FIN-%' ORDER BY id DESC LIMIT 500").all();
      else if (cat === 'RAW') rows = db.prepare("SELECT * FROM inventory WHERE (material LIKE 'RAW-%' OR material LIKE 'WAFER%') ORDER BY id DESC LIMIT 500").all();
      else rows = qInv.all();
      const byLoc = {};
      rows.forEach(r => { byLoc[r.loc_code] = byLoc[r.loc_code] || { loc: r.loc_code, skus: 0, qty: 0 }; byLoc[r.loc_code].skus++; byLoc[r.loc_code].qty += r.qty; });
      // 成品行始终可见：高频 PICK/STAGE 流水会把 LOT 完工成品挤出分页窗口，故单独回传
      const finRows = db.prepare("SELECT * FROM inventory WHERE material LIKE 'FIN-%' ORDER BY id DESC LIMIT 500").all();
      const finQty = db.prepare("SELECT COALESCE(SUM(qty),0) q FROM inventory WHERE material LIKE 'FIN-%'").get().q;
      return json(res, 200, { count: rows.length, finTotalQty: finQty, fin: finRows, byLocation: Object.values(byLoc), inventory: rows.slice(0, 300) });
    }
    if (route === '/api/wms/tasks') return json(res, 200, { open: qTasksOpen.all().length, all: qTasksAll.all().length, tasks: qTasksAll.all() });
    if (route === '/api/wms/tx') {
      const limit = Math.min(200, +(u.searchParams.get('limit') || 50));
      return json(res, 200, { count: qTx.all(limit).length, tx: qTx.all(limit) });
    }
    if (route === '/api/wms/kit') {
      const lot = u.searchParams.get('lot');
      return kitStatus(lot).then(r => json(res, 200, r));
    }
    if (route === '/api/wms/trace') {
      const batch = u.searchParams.get('batch');
      if (!batch) return json(res, 400, { error: 'batch required' });
      return traceBatch(batch).then(r => json(res, 200, r));
    }

    // 上架规则
    if (route === '/api/wms/putaway-rules') {
      const rules = qRules.all();
      return json(res, 200, { count: rules.length, rules });
    }
    if (route === '/api/wms/putaway-rules' && req.method === 'POST') {
      return readBody(req).then(b => { insRuleNew.run(b.mat_cat, b.strategy, b.target_zone, b.note || ''); return json(res, 200, { ok: true }); });
    }

    // 盘点
    if (route === '/api/wms/stocktaking' && req.method === 'POST') {
      return readBody(req).then(b => json(res, 200, createStocktake(b)));
    }
    if (route === '/api/wms/stocktaking') {
      const list = db.prepare('SELECT * FROM stocktaking ORDER BY id DESC LIMIT 50').all();
      return json(res, 200, { count: list.length, stocktakings: list });
    }
    if (route.startsWith('/api/wms/stocktaking/') && route.endsWith('/count') && req.method === 'POST') {
      const id = +route.slice('/api/wms/stocktaking/'.length, -'/count'.length);
      return readBody(req).then(b => json(res, 200, countStocktake(id, b.counts || b)));
    }
    if (route.startsWith('/api/wms/stocktaking/') && route.endsWith('/adjust') && req.method === 'POST') {
      const id = +route.slice('/api/wms/stocktaking/'.length, -'/adjust'.length);
      return json(res, 200, adjustStocktake(id));
    }

    // 波次
    if (route === '/api/wms/waves' && req.method === 'POST') {
      return readBody(req).then(b => json(res, 200, createWave(b)));
    }
    if (route === '/api/wms/waves') {
      const list = db.prepare('SELECT * FROM waves ORDER BY id DESC LIMIT 50').all();
      return json(res, 200, { count: list.length, waves: list });
    }
    if (route.startsWith('/api/wms/waves/') && route.endsWith('/pick') && req.method === 'POST') {
      const id = +route.slice('/api/wms/waves/'.length, -'/pick'.length);
      return json(res, 200, pickWave(id));
    }
    if (route.startsWith('/api/wms/waves/') && route.endsWith('/close') && req.method === 'POST') {
      const id = +route.slice('/api/wms/waves/'.length, -'/close'.length);
      return json(res, 200, closeWave(id));
    }

    // 补货建议
    if (route === '/api/wms/replenish' && req.method === 'POST') {
      return readBody(req).then(b => {
        const r = checkReplenish();
        const list = db.prepare('SELECT * FROM replenish ORDER BY id DESC LIMIT 50').all();
        return json(res, 200, { ok: true, created: r.created, suggestions: list });
      });
    }
    if (route.startsWith('/api/wms/replenish/') && route.endsWith('/order') && req.method === 'POST') {
      const id = +route.slice('/api/wms/replenish/'.length, -'/order'.length);
      return orderReplenish(id).then(r => json(res, 200, r));
    }
    if (route === '/api/wms/replenish') {
      const list = db.prepare('SELECT * FROM replenish ORDER BY id DESC LIMIT 50').all();
      return json(res, 200, { count: list.length, suggestions: list });
    }

    // 基础操作
    if (route === '/api/wms/goods-receipt' && req.method === 'POST') {
      return readBody(req).then(b => json(res, 200, goodsReceipt(b)));
    }
    if (route === '/api/wms/putaway' && req.method === 'POST') {
      return readBody(req).then(b => json(res, 200, putaway(b)));
    }
    if (route === '/api/wms/ship' && req.method === 'POST') {
      return readBody(req).then(b => json(res, 200, shipOrder(b)));
    }

    return json(res, 404, { error: 'not found' });
  }

  // 独立进程模式：自建 WS 订阅 MES（向后兼容）
  let ws = null;
  // WS 重连补偿：拉 MES 当前在制批次，对 WMS 未拣货的补实物拣货，消除断连期间事件丢失导致的实物/财务偏离
  async function reconcileWithMES() {
    try {
      const r = await fetch(`${MES_HTTP}/api/wip`);
      if (r.ok) {
        const wip = await r.json();
        const lots = wip.lots || [];
        const picked = new Set(db.prepare("SELECT DISTINCT ref FROM wms_tx WHERE type='PICK'").all().map(x => x.ref));
        let n = 0;
        for (const l of lots) {
          if (!picked.has(l.id)) {
            const product = productOf(l);
            const bom = cfg.getBomMap(product);
            for (const [mat, q] of Object.entries(bom)) {
              adjust(mat, `PK-${l.id}`, 'WH-RAW-01', -q, 'PICKED');
              adjust(mat, `PK-${l.id}`, 'STAGE-A', q, 'PICKED');
              wmsTx('PICK', mat, `PK-${l.id}`, -q, 'WH-RAW-01', 'STAGE-A', l.id, `重连补偿拣货 ${l.id}`);
            }
            n++;
          }
        }
        if (n) log(`🔄 WS 重连补偿：补拣货 ${n} 批，WMS 实物库存已与 MES 对齐`);
      }
    } catch (e) { log('WMS 重连对账失败: ' + e.message); }
  }
  // C4：断连空窗连续重放——基于 /api/events 的 seq 游标轮询，循环补偿错过的中间事件
  // （与现实 WS 订阅并存；handleMesEvent 内部以 wms_tx PICK 去重，重放不产生重复实物动作）
  let lastSeq = 0;
  let replayStarted = false;
  // 演示系统"自动化总开关"：默认关，需人为干预开启；关时本模块不做任何自动动作（手工接口不受限）
  const { isAutomationEnabled } = require('../automation-flag');
  async function pollReplay() {
    if (!isAutomationEnabled()) return;   // 总开关关：不自动重放事件（省资源、不造数据）
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
      if (!replayStarted) { replayStarted = true; setInterval(pollReplay, +(process.env.WMS_REPLAY_MS || 4000)); }   // C4：启动连续重放，闭合断连空窗（间隔可配）
    });
    ws.on('message', raw => {
      let ev; try { ev = JSON.parse(raw); } catch (e) { return; }
      if (ev && ev.seq) lastSeq = Math.max(lastSeq, ev.seq);
      handleMesEvent(ev);
    });
    ws.on('close', () => { mesConnected = false; log('MES 事件流断开，3s 重连'); setTimeout(() => connectMESStandalone(mesWsUrl), 3000); });
    ws.on('error', e => { log('WS 错误: ' + e.message); });
  }

  return {
    handler, handleMesEvent, db, refreshWoCaches, reconcileWithMES,
    goodsReceipt, putaway, shipOrder, kitStatus, traceBatch, checkReplenish, orderReplenish,
    createStocktake, countStocktake, adjustStocktake, createWave, pickWave, closeWave,
    log,
    connectMESStandalone,
    listen(port) {
      const server = http.createServer(handler);
      refreshWoCaches();
      if (!inProc) connectMESStandalone(process.env.MES_WS || 'ws://127.0.0.1:8124');
      server.listen(port, () => {
        log(`fab-wms 仓储执行域已启动 :${port}（${inProc ? 'in-proc 底座模式' : 'standalone 独立进程'}）`);
      });
      // 安全库存联动补货：周期性自动检查（每 30s），低于安全库存自动生成补货建议
      // 受自动化总开关管制：关时跳过（定时器保活，人工开启后自动恢复巡检）
      const autoTimer = setInterval(() => {
        if (!isAutomationEnabled()) return;
        try { checkReplenish(); } catch (e) { /* 忽略瞬时错误 */ }
      }, +(process.env.WMS_REPLENISH_MS || 30000));
      if (autoTimer.unref) autoTimer.unref();
      return server;
    },
  };
}

module.exports = { createWmsService };
