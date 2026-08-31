// ============================================================
//  SQLite 存储实现（阶段0 默认后端，保持 node:sqlite 现状）
//  把 server.js 原裸 db 实例化 + CREATE TABLE + prepared statement
//  平移至此，对外暴露 StorageAdapter 接口方法。
//  SQL 语义与原 server.js 完全等价，DB 结构向后兼容。
// ============================================================
const path = require('path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { StorageAdapter } = require('./interface');

const DB_PATH = path.join(__dirname, '..', 'fab-mes.db');

class SQLiteStorage extends StorageAdapter {
  constructor() {
    super();
    this.db = new DatabaseSync(DB_PATH);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.initSchema();        // 必须先建表，再 prepare 语句（否则全新 DB 报 no such table）
    this.initNpiSchema();     // NPI：设计主数据 / 光罩 / lot·wo 扩展列（幂等迁移）
    this._initStatements();
    this._initNpiStatements();
  }

  _initStatements() {
    const db = this.db;
    this.stmt = {
      insTool: db.prepare('INSERT OR REPLACE INTO tools(id,module,status,util,wafers,wph,updated_at) VALUES(?,?,?,?,?,?,?)'),
      updToolStatus: db.prepare('UPDATE tools SET status=?, updated_at=? WHERE id=?'),
      updToolMetric: db.prepare('UPDATE tools SET util=?, wafers=?, wph=?, updated_at=? WHERE id=?'),
      insEvt: db.prepare('INSERT INTO events(ts,type,payload) VALUES(?,?,?)'),
      qEvents: db.prepare('SELECT seq,ts,type,payload FROM events WHERE seq>? ORDER BY seq DESC LIMIT ?'),
      insWo: db.prepare('INSERT OR REPLACE INTO wos(id,product,productLabel,qty,dueHours,created,due,design_id,mask_id,product_type) VALUES(?,?,?,?,?,?,?,?,?,?)'),
      insLot: db.prepare('INSERT OR REPLACE INTO lots(id,wo,product,productLabel,step,rem,status,due,created,curTool,design_id,mask_id,product_type,so_id,customer) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
      updLot: db.prepare('UPDATE lots SET step=?, rem=?, status=?, curTool=?, design_id=?, mask_id=?, product_type=?, so_id=?, customer=? WHERE id=?'),
      insHist: db.prepare('INSERT INTO lot_hist(lot,step,mod,tool,start,end,durH) VALUES(?,?,?,?,?,?,?)'),
      insMetro: db.prepare('INSERT INTO metrology(ts,lot,product,tool,step,param,unit,value,target,usl,lsl,result) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'),
      insVmLog: db.prepare('INSERT INTO vm_log(ts,lot,product,tool,param,pred,actual,errPct,status) VALUES(?,?,?,?,?,?,?,?,?)'),
      insSpcAlarm: db.prepare('INSERT INTO spc_alarm(ts,product,param,tool,value,mean,ucl,lcl,rules) VALUES(?,?,?,?,?,?,?,?,?)'),
      insMetaMod: db.prepare('INSERT OR REPLACE INTO meta_modules(key,name,count) VALUES(?,?,?)'),
      insMetaProd: db.prepare('INSERT OR REPLACE INTO meta_products(key,label,passes) VALUES(?,?,?)'),
      delMetaRoutes: db.prepare('DELETE FROM meta_routes'),
      insMetaRoute: db.prepare('INSERT INTO meta_routes(product,step,module) VALUES(?,?,?)'),
      insTsdb: db.prepare('INSERT INTO tsdb(ts,t,domain,metric,tool,lot,product,value,unit,aux) VALUES(?,?,?,?,?,?,?,?,?,?)'),
      qTsdb: db.prepare('SELECT ts,t,domain,metric,tool,lot,product,value,unit,aux FROM tsdb WHERE domain=? AND metric=? ORDER BY t DESC LIMIT ?'),
      qTsdbStats: db.prepare('SELECT domain, metric, COUNT(*) n, MIN(value) mn, MAX(value) mx, AVG(value) mean FROM tsdb GROUP BY domain, metric ORDER BY domain, metric'),
      upsertLp: db.prepare('INSERT INTO learned_params(engine,param,scope,value,aux,learnedAt) VALUES(?,?,?,?,?,?) ON CONFLICT(engine,param,scope) DO UPDATE SET value=excluded.value, aux=excluded.aux, learnedAt=excluded.learnedAt'),
      getLp: db.prepare('SELECT * FROM learned_params WHERE engine=? AND param=? AND scope=?'),
      qLp: db.prepare('SELECT * FROM learned_params ORDER BY engine, param, scope'),
    };
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tools(
        id TEXT PRIMARY KEY, module TEXT, status TEXT, util INTEGER,
        wafers INTEGER, wph INTEGER, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, type TEXT, payload TEXT
      );
      CREATE TABLE IF NOT EXISTS wos(
        id TEXT PRIMARY KEY, product TEXT, productLabel TEXT, qty INTEGER,
        dueHours REAL, created TEXT, due TEXT
      );
      CREATE TABLE IF NOT EXISTS lots(
        id TEXT PRIMARY KEY, wo TEXT, product TEXT, productLabel TEXT,
        step INTEGER, rem INTEGER, status TEXT, due TEXT, created TEXT, curTool TEXT
      );
      CREATE TABLE IF NOT EXISTS lot_hist(
        id INTEGER PRIMARY KEY AUTOINCREMENT, lot TEXT, step INTEGER,
        mod TEXT, tool TEXT, start TEXT, end TEXT, durH REAL
      );
      CREATE TABLE IF NOT EXISTS metrology(
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, lot TEXT, product TEXT,
        tool TEXT, step INTEGER, param TEXT, unit TEXT, value REAL,
        target REAL, usl REAL, lsl REAL, result TEXT
      );
      CREATE TABLE IF NOT EXISTS vm_log(
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, lot TEXT, product TEXT,
        tool TEXT, param TEXT, pred REAL, actual REAL, errPct REAL, status TEXT
      );
      CREATE TABLE IF NOT EXISTS spc_alarm(
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, product TEXT, param TEXT,
        tool TEXT, value REAL, mean REAL, ucl REAL, lcl REAL, rules TEXT
      );
      CREATE TABLE IF NOT EXISTS meta_modules(key TEXT PRIMARY KEY, name TEXT, count INTEGER);
      CREATE TABLE IF NOT EXISTS meta_products(key TEXT PRIMARY KEY, label TEXT, passes INTEGER);
      CREATE TABLE IF NOT EXISTS meta_routes(id INTEGER PRIMARY KEY AUTOINCREMENT, product TEXT, step INTEGER, module TEXT);
      CREATE TABLE IF NOT EXISTS wafers(
        lot TEXT, slot INTEGER, wafer TEXT, status TEXT,
        step INTEGER, tool TEXT, hold_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS recipes(
        id INTEGER PRIMARY KEY AUTOINCREMENT, product TEXT, module TEXT, step INTEGER,
        name TEXT, params TEXT, version INTEGER
      );
      CREATE TABLE IF NOT EXISTS chamber_hist(
        ts TEXT, tool TEXT, chamber TEXT, temp REAL, rf REAL, gas REAL, press REAL
      );
      CREATE TABLE IF NOT EXISTS audit_log(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        tenant TEXT,
        actor TEXT,
        action TEXT,
        target TEXT,
        semi TEXT,
        payload TEXT,
        prev_hash TEXT,
        hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tsdb(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT, t INTEGER,
        domain TEXT, metric TEXT, tool TEXT, lot TEXT, product TEXT,
        value REAL, unit TEXT, aux TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tsdb_dm ON tsdb(domain, metric, t);
      CREATE TABLE IF NOT EXISTS learned_params(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engine TEXT, param TEXT, scope TEXT,
        value REAL, aux TEXT, learnedAt TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_lp ON learned_params(engine, param, scope);
    `);
  }

  // ---- NPI：设计到流片（Design-to-Tapeout）主数据 ----
  // designs：客户设计档案（GDSII / PDK / 关联产品 / 光罩 / 版次 / 阶段）
  // photomasks：光罩（reticle）主数据，关联设计
  // lots/wos：扩展 design_id / mask_id / product_type(engineering|tapeout|volume)
  initNpiSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS designs(
        id TEXT PRIMARY KEY, customer_id TEXT, name TEXT, gds_ref TEXT, pdk TEXT,
        product TEXT, mask_id TEXT, mask_rev TEXT, rev TEXT, status TEXT, created TEXT
      );
      CREATE TABLE IF NOT EXISTS photomasks(
        id TEXT PRIMARY KEY, design_id TEXT, layers INTEGER, reticle TEXT, rev TEXT, status TEXT, created TEXT
      );
      CREATE TABLE IF NOT EXISTS lda_sync(
        id TEXT PRIMARY KEY, domain TEXT, imported_at TEXT, wo_id TEXT, lot_id TEXT, status TEXT
      );
    `);
    // 既有 lots/wos 表增量加列（SQLite 不支持 ADD COLUMN IF NOT EXISTS，逐列 try/catch 幂等）
    ['lots:design_id:TEXT', 'lots:mask_id:TEXT', 'lots:product_type:TEXT', 'lots:so_id:TEXT', 'lots:customer:TEXT',
     'wos:design_id:TEXT', 'wos:mask_id:TEXT', 'wos:product_type:TEXT'].forEach(s => {
      const [t, c, ty] = s.split(':');
      try { this.db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ty}`); } catch (_) { /* 列已存在 */ }
    });
  }

  _initNpiStatements() {
    const db = this.db;
    this.stmt.npi = {
      insDesign: db.prepare('INSERT INTO designs(id,customer_id,name,gds_ref,pdk,product,mask_id,mask_rev,rev,status,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)'),
      getDesign: db.prepare('SELECT * FROM designs WHERE id=?'),
      updDesign: db.prepare('UPDATE designs SET customer_id=?,name=?,gds_ref=?,pdk=?,product=?,mask_id=?,mask_rev=?,rev=?,status=? WHERE id=?'),
      insMask: db.prepare('INSERT INTO photomasks(id,design_id,layers,reticle,rev,status,created) VALUES(?,?,?,?,?,?,?)'),
      getMask: db.prepare('SELECT * FROM photomasks WHERE id=?'),
      listMasksByDesign: db.prepare('SELECT * FROM photomasks WHERE design_id=? ORDER BY id'),
      insLdaSync: db.prepare('INSERT OR REPLACE INTO lda_sync(id,domain,imported_at,wo_id,lot_id,status) VALUES(?,?,?,?,?,?)'),
      getLdaSync: db.prepare('SELECT * FROM lda_sync WHERE id=?'),
      listLdaSync: db.prepare('SELECT * FROM lda_sync ORDER BY imported_at DESC'),
    };
  }

  // ---- NPI 设计主数据 CRUD ----
  insertDesign(d) {
    const id = d.id || ('DES-' + Date.now().toString(36).toUpperCase());
    this.stmt.npi.insDesign.run(id, d.customer_id || null, d.name || '', d.gds_ref || null, d.pdk || null,
      d.product || null, d.mask_id || null, d.mask_rev || null, d.rev || 'r1', d.status || 'DESIGN', new Date().toISOString());
    return this.stmt.npi.getDesign.get(id);
  }
  getDesign(id) { return this.stmt.npi.getDesign.get(id); }
  updateDesign(id, p) {
    const cur = this.getDesign(id); if (!cur) return null;
    this.stmt.npi.updDesign.run(p.customer_id ?? cur.customer_id, p.name ?? cur.name, p.gds_ref ?? cur.gds_ref,
      p.pdk ?? cur.pdk, p.product ?? cur.product, p.mask_id ?? cur.mask_id, p.mask_rev ?? cur.mask_rev,
      p.rev ?? cur.rev, p.status ?? cur.status, id);
    return this.getDesign(id);
  }
  listDesigns() { return this.db.prepare('SELECT * FROM designs ORDER BY created DESC').all(); }
  insertMask(m) {
    const id = m.id || ('MSK-' + Date.now().toString(36).toUpperCase());
    this.stmt.npi.insMask.run(id, m.design_id || null, +m.layers || 0, m.reticle || null, m.rev || 'A', m.status || 'READY', new Date().toISOString());
    return this.stmt.npi.getMask.get(id);
  }
  listMasks(designId) { return designId ? this.stmt.npi.listMasksByDesign.all(designId) : this.db.prepare('SELECT * FROM photomasks ORDER BY created DESC').all(); }

  // ---- LDA 有机衔接：导入去重（幂等，跨重启保留） ----
  markLdaImported(rec) {
    this.stmt.npi.insLdaSync.run(rec.id, rec.domain || null, rec.imported_at || new Date().toISOString(),
      rec.wo_id || null, rec.lot_id || null, rec.status || 'IMPORTED');
  }
  isLdaImported(id) { return !!this.stmt.npi.getLdaSync.get(id); }
  listLdaImported() { return this.stmt.npi.listLdaSync.all(); }

  // NPI 批次查询：工程批 / 流片批（product_type != volume）
  listNpiLots() {
    return this.db.prepare(`SELECT id,wo,product,productLabel,status,step,rem,design_id,mask_id,product_type,created
      FROM lots WHERE product_type IS NOT NULL AND product_type <> 'volume' ORDER BY created DESC LIMIT 200`).all()
      .map(r => ({ ...r, routeLen: (r.step || 0) + (r.rem || 0) }));
  }

  // 种子：NPI 设计主数据（客户设计档案 + 光罩），幂等（已有时跳过）
  seedNpi() {
    const n = this.db.prepare('SELECT COUNT(*) n FROM designs').get().n;
    if (n > 0) return;
    const insD = this.stmt.npi.insDesign;
    const ts = new Date().toISOString();
    insD.run('DES-001', 'CUS-001', 'NVDA Hopper-Next GPU', 'gds/nvda_hopper_next.gds', 'N2-PDK', 'N2', 'MSK-001', 'A', 'r1', 'QUAL', ts);
    insD.run('DES-002', 'CUS-002', 'Apple M3 图像传感器', 'gds/apple_m3_cis.gds', 'CIS-PDK', 'CIS', 'MSK-002', 'A', 'r1', 'TAPEOUT', ts);
    insD.run('DES-003', 'CUS-003', 'HiSilicon 5G 基带', 'gds/hisilicon_5g.gds', 'A16-PDK', 'A16', 'MSK-003', 'A', 'r1', 'DESIGN', ts);
    const insM = this.stmt.npi.insMask;
    insM.run('MSK-001', 'DES-001', 28, 'RET-LITHO-01', 'A', 'READY', ts);
    insM.run('MSK-002', 'DES-002', 21, 'RET-LITHO-02', 'A', 'READY', ts);
    insM.run('MSK-003', 'DES-003', 24, 'RET-LITHO-03', 'A', 'READY', ts);
    console.log('[NPI] 已种子 3 个设计档案 + 3 套光罩');
  }

  // ---- 合规审计层（L4，追加式不可篡改链式日志） ----
  // 建 audit_log 表（幂等；不影响现有表）。链式 hash 由 appendAudit 维护。
  initAuditSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        tenant TEXT,
        actor TEXT,
        action TEXT,
        target TEXT,
        semi TEXT,
        payload TEXT,
        prev_hash TEXT,
        hash TEXT NOT NULL
      );
    `);
    if (!this._stmtAudit) this._initAuditStatements();
  }

  _initAuditStatements() {
    const db = this.db;
    this._stmtAudit = {
      ins: db.prepare('INSERT INTO audit_log(ts,tenant,actor,action,target,semi,payload,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?)'),
      last: db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1'),
      qByLimit: db.prepare('SELECT id,ts,tenant,actor,action,target,semi,payload,prev_hash,hash FROM audit_log ORDER BY id DESC LIMIT ?'),
      qByAfter: db.prepare('SELECT id,ts,tenant,actor,action,target,semi,payload,prev_hash,hash FROM audit_log WHERE id>? ORDER BY id DESC LIMIT ?'),
      qByActor: db.prepare('SELECT id,ts,tenant,actor,action,target,semi,payload,prev_hash,hash FROM audit_log WHERE actor=? ORDER BY id DESC LIMIT ?'),
      qByAction: db.prepare('SELECT id,ts,tenant,actor,action,target,semi,payload,prev_hash,hash FROM audit_log WHERE action=? ORDER BY id DESC LIMIT ?'),
    };
  }

  // 追加一条审计记录，链式 hash = sha256(prev_hash + ts + actor + action + target + payload)
  // 首条 prev_hash = '0'（创世链头）。任何对历史记录的篡改都会破坏后续 hash 链，可校验。
  appendAudit(rec) {
    if (!this._stmtAudit) this._initAuditStatements();
    const ts = rec.ts || new Date().toISOString();
    const tenant = rec.tenant || 'default';
    const actor = rec.actor || 'system';
    const action = rec.action || 'unknown';
    const target = rec.target != null ? String(rec.target) : null;
    const semi = Array.isArray(rec.semi) ? JSON.stringify(rec.semi) : (rec.semi ? JSON.stringify([rec.semi]) : '[]');
    const payload = typeof rec.payload === 'string' ? rec.payload : JSON.stringify(rec.payload || {});
    const prevHashRow = this._stmtAudit.last.get();
    const prevHash = prevHashRow ? prevHashRow.hash : '0';
    const hashInput = prevHash + '|' + ts + '|' + actor + '|' + action + '|' + (target || '') + '|' + payload;
    const hash = crypto.createHash('sha256').update(hashInput).digest('hex');
    const info = this._stmtAudit.ins.run(ts, tenant, actor, action, target, semi, payload, prevHash, hash);
    return { id: info.lastInsertRowid, hash, prevHash };
  }

  queryAudit({ after, limit = 100, actor, action } = {}) {
    if (!this._stmtAudit) this._initAuditStatements();
    const lim = Math.min(1000, Math.max(1, +(limit || 100)));
    let rows;
    if (actor) rows = this._stmtAudit.qByActor.all(actor, lim);
    else if (action) rows = this._stmtAudit.qByAction.all(action, lim);
    else if (after != null) rows = this._stmtAudit.qByAfter.all(+after, lim);
    else rows = this._stmtAudit.qByLimit.all(lim);
    return rows.map(r => ({
      id: r.id, ts: r.ts, tenant: r.tenant, actor: r.actor, action: r.action, target: r.target,
      semi: JSON.parse(r.semi || '[]'),
      payload: (() => { try { return JSON.parse(r.payload); } catch (_) { return r.payload; } })(),
      prevHash: r.prev_hash, hash: r.hash,
    }));
  }

  seedMeta({ modules, products, routes }) {
    const db = this.db;
    db.exec('DELETE FROM meta_modules; DELETE FROM meta_products;');
    modules.forEach(m => this.stmt.insMetaMod.run(m.key, m.name, m.count));
    Object.entries(products).forEach(([k, v]) => this.stmt.insMetaProd.run(k, v.label, v.passes));
    this.stmt.delMetaRoutes.run();
    routes.forEach(r => this.stmt.insMetaRoute.run(r.product, r.step, r.module));
  }

  // ---- 事件落库（队列 + 批写，与原 server.js flushEvts 等价） ----
  enqueueEvent(ts, type, payloadStr) {
    if (!this._evtQueue) this._evtQueue = [];
    this._evtQueue.push([ts, type, payloadStr]);
  }
  flushEvents() {
    if (!this._evtQueue || !this._evtQueue.length) return;
    const batch = this._evtQueue;
    this._evtQueue = [];
    try {
      for (const r of batch) this.stmt.insEvt.run(r[0], r[1], r[2]);
    } catch (e) { /* WAL+busy_timeout 下极少失败；丢弃不重试，防队列膨胀卡死 */ }
  }

  queryEvents({ after = 0, limit = 100, from, to, type } = {}) {
    if (from || to || type) {
      let sql = 'SELECT seq,ts,type,payload FROM events WHERE 1=1', args = [];
      if (from) { sql += ' AND ts>=?'; args.push(new Date(+from).toISOString()); }
      if (to) { sql += ' AND ts<=?'; args.push(new Date(+to).toISOString()); }
      if (type) { sql += ' AND type=?'; args.push(type); }
      sql += ' ORDER BY seq DESC LIMIT ?'; args.push(limit);
      return this.db.prepare(sql).all(...args);
    }
    return this.stmt.qEvents.all(after, limit);
  }

  // ---- 设备 ----
  upsertTool(t) {
    this.stmt.insTool.run(t.id, t.module, t.status, t.util, t.wafers, t.wph, new Date().toISOString());
  }
  updateToolStatus(id, status, ts) { this.stmt.updToolStatus.run(status, ts, id); }
  updateToolMetric(id, util, wafers, wph, ts) { this.stmt.updToolMetric.run(util, wafers, wph, ts, id); }

  // ---- 工单 / 批次 / 历史 ----
  insertWO(w) {
    this.stmt.insWo.run(w.id, w.product, w.productLabel, w.qty, w.dueHours,
      new Date(w.created).toISOString(), new Date(w.due).toISOString(),
      w.designId || null, w.maskId || null, w.productType || 'volume');
  }
  insertLot(l) {
    this.stmt.insLot.run(l.id, l.wo, l.product, l.productLabel, l.step, l.rem, l.status,
      new Date(l.due).toISOString(), new Date(l.created).toISOString(), l.curTool || null,
      l.designId || null, l.maskId || null, l.productType || 'volume', l.soId || null, l.customer || null);
  }
  updateLot(l) {
    this.stmt.updLot.run(l.step, l.rem, l.status, l.curTool || null,
      l.designId || null, l.maskId || null, l.productType || 'volume', l.soId || null, l.customer || null, l.id);
  }
  insertLotHist(lotId, h) {
    this.stmt.insHist.run(lotId, h.step, h.mod, h.tool,
      new Date(h.start).toISOString(), new Date(h.end).toISOString(), h.durH);
  }

  // ---- 量测 / VM / SPC ----
  insertMetrology(ts, m) {
    this.stmt.insMetro.run(ts, m.lot, m.product, m.tool, m.step, m.param, m.unit, m.value, m.target, m.usl, m.lsl, m.result);
  }
  insertVmLog(ts, v) {
    this.stmt.insVmLog.run(ts, v.lot, v.product, v.tool, v.param, v.pred, v.actual, v.errPct, v.status);
  }
  insertSpcAlarm(ts, a) {
    this.stmt.insSpcAlarm.run(ts, a.product, a.param, a.tool, a.value, a.mean, a.ucl, a.lcl, JSON.stringify(a.rules));
  }
  queryMetrology({ param, lot, product, limit = 100 } = {}) {
    let sql = 'SELECT * FROM metrology WHERE 1=1', args = [];
    if (param) { sql += ' AND param=?'; args.push(param); }
    if (lot) { sql += ' AND lot=?'; args.push(lot); }
    if (product) { sql += ' AND product=?'; args.push(product); }
    return this.db.prepare(sql + ' ORDER BY id DESC LIMIT ?').all(...args, limit);
  }
  queryMetrologyStats() {
    return this.db.prepare('SELECT param, product, unit, target, usl, lsl, COUNT(*) n, AVG(value) mean, MIN(value) mn, MAX(value) mx FROM metrology GROUP BY param, product').all();
  }
  queryMetrologyValues(param, product) {
    return this.db.prepare('SELECT value FROM metrology WHERE param=? AND product=?').all(param, product).map(r => r.value);
  }
  queryVmLog(limit = 50) {
    return this.db.prepare('SELECT * FROM vm_log ORDER BY id DESC LIMIT ?').all(limit);
  }
  querySpcAlarms(limit = 30) {
    return this.db.prepare('SELECT * FROM spc_alarm ORDER BY id DESC LIMIT ?').all(limit)
      .map(r => ({ ...r, rules: JSON.parse(r.rules) }));
  }

  // ---- 晶圆级追踪（L4 实战颗粒度：25 片/lot 逐片状态） ----
  insertWafers(lotId, wafers) {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO wafers(lot,slot,wafer,status,step,tool,hold_reason) VALUES(?,?,?,?,?,?,?)');
    for (const w of wafers) stmt.run(lotId, w.slot, w.wafer, w.status, w.step || 0, w.tool || null, w.holdReason || null);
  }
  updateWafersByLot(lotId, wafers) { this.insertWafers(lotId, wafers); }
  queryWafers(lot) {
    return this.db.prepare('SELECT slot,wafer,status,step,tool,hold_reason FROM wafers WHERE lot=? ORDER BY slot').all(lot);
  }

  // WIP 重启恢复：取在制/暂停批次（状态机未终态），用于重建内存引擎（C1 主轴对账基础）
  queryActiveLots() {
    return this.db.prepare(`SELECT id,wo,product,productLabel,step,rem,status,due,created,curTool,design_id,mask_id,product_type,so_id,customer
      FROM lots WHERE status IN ('WIP','HOLD') ORDER BY created`).all()
      .map(r => ({
        id: r.id, wo: r.wo, product: r.product, productLabel: r.productLabel,
        step: r.step || 0, rem: r.rem != null ? r.rem : 0, status: r.status || 'WIP',
        due: r.due, created: r.created, curTool: r.curTool || null,
        designId: r.design_id || null, maskId: r.mask_id || null, productType: r.product_type || 'volume',
        soId: r.so_id || null, customer: r.customer || null,
      }));
  }

  // ---- 配方管理（产品×工序真实配方 + 版本） ----
  seedRecipes(recipes) {
    this.db.exec('DELETE FROM recipes');
    const stmt = this.db.prepare('INSERT INTO recipes(product,module,step,name,params,version) VALUES(?,?,?,?,?,?)');
    for (const r of recipes) stmt.run(r.product, r.module, r.step || 0, r.name, JSON.stringify(r.params || {}), r.version || 1);
  }
  queryRecipes({ product, module } = {}) {
    let sql = 'SELECT product,module,step,name,params,version FROM recipes WHERE 1=1', args = [];
    if (product) { sql += ' AND product=?'; args.push(product); }
    if (module) { sql += ' AND module=?'; args.push(module); }
    return this.db.prepare(sql).all(...args).map(r => ({ ...r, params: (() => { try { return JSON.parse(r.params); } catch (_) { return {}; } })() }));
  }

  // ---- 腔室数据历史库（trace historian 时序归档 + 回放） ----
  insertChamberHist(rows) {
    if (!rows || !rows.length) return;
    const stmt = this.db.prepare('INSERT INTO chamber_hist(ts,tool,chamber,temp,rf,gas,press) VALUES(?,?,?,?,?,?,?)');
    for (const r of rows) stmt.run(r.ts, r.tool, r.chamber, r.temp, r.rf, r.gas, r.press);
  }
  queryChamberHist({ tool, chamber, limit = 120 } = {}) {
    if (!tool || !chamber) return [];
    return this.db.prepare('SELECT ts,tool,chamber,temp,rf,gas,press FROM chamber_hist WHERE tool=? AND chamber=? ORDER BY ts DESC LIMIT ?')
      .all(tool, chamber, limit).reverse();   // 时间正序返回
  }

  // ---- 时序库（TSDB）：统一按 域(domain)/指标(metric) 沉淀 生产·设备·质量·引擎 历史 ----
  // 单条失败不影响主轴（与主事件落库策略一致：丢弃不重试，防队列膨胀）
  insertTsdb(rec) {
    try {
      this.stmt.insTsdb.run(
        rec.ts || new Date().toISOString(), rec.t || Date.now(),
        rec.domain, rec.metric, rec.tool || null, rec.lot || null, rec.product || null,
        rec.value == null ? null : +rec.value, rec.unit || null,
        rec.aux != null ? JSON.stringify(rec.aux) : null);
    } catch (_) {}
  }
  queryTsdb({ domain, metric, tool, lot, product, from, to, limit = 200 } = {}) {
    let sql = 'SELECT ts,t,domain,metric,tool,lot,product,value,unit,aux FROM tsdb WHERE 1=1', args = [];
    if (domain) { sql += ' AND domain=?'; args.push(domain); }
    if (metric) { sql += ' AND metric=?'; args.push(metric); }
    if (tool)   { sql += ' AND tool=?';   args.push(tool); }
    if (lot)    { sql += ' AND lot=?';    args.push(lot); }
    if (product){ sql += ' AND product=?';args.push(product); }
    if (from)   { sql += ' AND t>=?';     args.push(+from); }
    if (to)     { sql += ' AND t<=?';     args.push(+to); }
    sql += ' ORDER BY t DESC LIMIT ?'; args.push(Math.min(2000, limit));
    return this.db.prepare(sql).all(...args).reverse()
      .map(r => ({ ...r, aux: r.aux ? JSON.parse(r.aux) : null }));
  }
  queryTsdbStats() { return this.stmt.qTsdbStats.all(); }

  // 历史回填：把已有 metrology/vm_log/spc_alarm/events(toolMetric/apcSetpoint) 一次性灌入 TSDB。
  // 仅在 TSDB 为空时执行（幂等），使"数据资产"首屏即有真实历史；之后由事件订阅持续沉淀。
  backfillTsdb() {
    try {
      const cnt = this.db.prepare('SELECT COUNT(*) n FROM tsdb').get().n;
      if (cnt > 0) return { skipped: true, existing: cnt };
      const ins = this.stmt.insTsdb;
      let n = 0;
      const stamp = ts => { try { return new Date(ts).getTime(); } catch (_) { return Date.now(); } };
      // 质量：metrology 表（OVL/CD/THK 全量历史）
      const m = this.db.prepare('SELECT ts,lot,product,tool,param,unit,value,target,usl,lsl FROM metrology ORDER BY id DESC LIMIT 20000').all();
      for (const r of m) { ins.run(r.ts, stamp(r.ts), 'quality', r.param, r.tool, r.lot, r.product, r.value, r.unit, JSON.stringify({ target: r.target, usl: r.usl, lsl: r.lsl })); n++; }
      // 引擎：vm_log 误差
      const v = this.db.prepare('SELECT ts,lot,product,tool,param,errPct FROM vm_log WHERE errPct IS NOT NULL ORDER BY id DESC LIMIT 20000').all();
      for (const r of v) { ins.run(r.ts, stamp(r.ts), 'engine', 'vm_err', r.tool, r.lot, r.product, r.errPct, '%', null); n++; }
      // 引擎：spc_alarm 量测值
      const s = this.db.prepare('SELECT ts,product,param,tool,value FROM spc_alarm ORDER BY id DESC LIMIT 20000').all();
      for (const r of s) { ins.run(r.ts, stamp(r.ts), 'engine', 'spc_' + r.param, r.tool, null, r.product, r.value, null, null); n++; }
      // 设备：events 中的 toolMetric（解析 JSON payload）
      // 注意：events 表无 type 索引且体量大，必须用 seq 窗口限定扫描范围（最近 5 万条），否则全表扫描会卡死启动
      const seqCut = Math.max(0, (this.db.prepare('SELECT MAX(seq) mx FROM events').get().mx || 0) - 50000);
      const e = this.db.prepare("SELECT ts,payload FROM events WHERE seq>? AND type='toolMetric' ORDER BY seq DESC LIMIT 20000").all(seqCut);
      for (const r of e) { try { const p = JSON.parse(r.payload); const t = stamp(r.ts);
        if (p && p.id && p.wph != null)   { ins.run(r.ts, t, 'equipment', 'wph',   p.id, null, null, p.wph,   'wph', null); n++; }
        if (p && p.id && p.util != null)  { ins.run(r.ts, t, 'equipment', 'util',  p.id, null, null, p.util,  '%',   null); n++; }
      } catch (_) {} }
      // 引擎：events 中的 apcSetpoint（APC 闭环微调历史，供自学习增益估计）
      const a = this.db.prepare("SELECT ts,payload FROM events WHERE seq>? AND type='apcSetpoint' ORDER BY seq DESC LIMIT 20000").all(seqCut);
      for (const r of a) { try { const p = JSON.parse(r.payload); const t = stamp(r.ts);
        if (p && p.param && p.setpoint != null) { ins.run(r.ts, t, 'engine', 'apc_' + p.param, p.tool, p.lot, p.product, p.setpoint, p.param, JSON.stringify({ target: p.target, predicted: p.predicted, adjust: p.adjust })); n++; }
      } catch (_) {} }
      console.log(`[TSDB] 历史回填完成：${n} 条（质量/设备/引擎/APC）`);
      return { skipped: false, inserted: n };
    } catch (e) { console.log('[TSDB] 回填异常(已忽略): ' + e.message); return { error: e.message }; }
  }

  // ---- 自学习参数持久化（跨重启保留，引擎启动时加载） ----
  upsertLearnedParam(engine, param, scope, value, aux) {
    this.stmt.upsertLp.run(engine, param, scope, value, aux != null ? JSON.stringify(aux) : null, new Date().toISOString());
  }
  getLearnedParam(engine, param, scope) {
    const r = this.stmt.getLp.get(engine, param, scope);
    return r ? { ...r, aux: r.aux ? JSON.parse(r.aux) : null } : null;
  }
  listLearnedParams() { return this.stmt.qLp.all().map(r => ({ ...r, aux: r.aux ? JSON.parse(r.aux) : null })); }

  // ---- 主数据读取 ----
  queryMetaModules() { return this.db.prepare('SELECT key,name,count FROM meta_modules ORDER BY key').all(); }
  queryMetaProducts() { return this.db.prepare('SELECT key,label,passes FROM meta_products ORDER BY key').all(); }
  queryMetaRoutes() { return this.db.prepare('SELECT product,step,module FROM meta_routes ORDER BY product,step').all(); }
  queryRouteForProduct(product) {
    const rs = this.db.prepare('SELECT module FROM meta_routes WHERE product=? ORDER BY step').all(product);
    return rs.length ? rs.map(r => r.module) : ['LITHO', 'DEP', 'ETCH', 'CMP', 'METRO'];
  }
}

module.exports = { SQLiteStorage };
