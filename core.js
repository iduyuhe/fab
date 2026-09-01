// ============================================================
//  M2 — MES 核心：工单/批次模型 + 派工引擎 + lot 追踪
//  派工规则与 DES(Phase 6/6.5/8) 已验证逻辑一致：
//  FIFO / SPT / CR / EDD / BN / HYBRID(瓶颈BN·其余FIFO)
//  设备状态联动：派工→RUN，加工完→IDLE；lot 沿重入路线流转
// ============================================================
const ROUTE = ['LITHO', 'ETCH', 'DEP', 'CMP', 'IMPL', 'METRO'];
// 多产品：光刻层数 → 重入次数（N2=2nm 28 层 / A16 21 层，约每 7 层一次重入）
const PRODUCTS = {
  N2:  { passes: 4, label: 'N2 2nm' },
  A16: { passes: 3, label: 'A16' },
};
const buildRoute = passes => { const r = []; for (let p = 0; p < passes; p++) ROUTE.forEach(m => r.push(m)); return r; };
const BN_DEFAULT = ['LITHO'];

// 派工规则：返回队列中选中 lot 的下标（0 = FIFO 队首）——与 DES pickBy 语义一致
function pickBy(queue, rule, modKey, eng) {
  const now = Date.now();
  if (rule === 'FIFO') return 0;
  if (rule === 'SPT') { let bi = 0; for (let i = 1; i < queue.length; i++) if ((queue[i]._pt || 1e18) < (queue[bi]._pt || 1e18)) bi = i; return bi; }
  if (rule === 'EDD') { let bi = 0; for (let i = 1; i < queue.length; i++) if ((queue[i].due || 1e18) < (queue[bi].due || 1e18)) bi = i; return bi; }
  if (rule === 'CR') {
    const cr = l => { const rt = Math.max(0.001, (l.rem || 1) * (eng.modAvgH[modKey] || 1)); return ((l.due || 1e18) - now) / rt; };
    let bi = 0; for (let i = 1; i < queue.length; i++) if (cr(queue[i]) < cr(queue[bi])) bi = i; return bi;
  }
  if (rule === 'BN') { let bi = 0; for (let i = 1; i < queue.length; i++) if ((queue[i].rem || 1e9) < (queue[bi].rem || 1e9)) bi = i; return bi; }
  return 0;
}

class WIPEngine {
  constructor(byId, tools, emit, opts = {}) {
    this.byId = byId; this.tools = tools; this.emit = emit;
    this.rule = opts.rule || 'HYBRID';
    this.hybridBn = opts.hybridBn || BN_DEFAULT;
    this.hybridBnRule = 'BN'; this.hybridOtherRule = 'FIFO';
    this.speed = opts.speed || 180;                    // 加速系数：真实 1h → 3600/speed 秒
    this.persist = opts.persist || null;               // S1 持久化钩子：{woCreate, lotCreate, lotUpdate, lotStepDone}
    this.modAvgH = {};                                  // 模块平均单步加工时长(hr)
    ROUTE.forEach(m => { const ts = tools.filter(t => t.module === m); this.modAvgH[m] = ts.length ? 25 / (ts.reduce((s, t) => s + t.wph, 0) / ts.length) : 1; });
    this.queues = {}; ROUTE.forEach(m => { this.queues[m] = []; });
    this.lots = []; this.byLot = new Map();
    this.wos = [];
    this.maxLots = +(opts.maxLots || 2000);   // 在制/历史 lot 上限：超则回收最旧已完成者，防内存无限增长
    this.maxWos = +(opts.maxWos || 500);      // 工单上限：超则回收最旧已完成者
    this.woSeq = 0; this.lotSeq = 0;
    this.stats = { wip: 0, done: 0, cycSumH: 0, moves: 0, releases: 0 };
    this._processing = new Map();                       // toolId -> lot（引擎占用设备）
    // 演示系统"自动化总开关"闸：shouldRun() 返回 false 时，引擎完成当前步后停在原地，
    // 不再自动进入下一站（产线冻结）；开闸后 resume() 把停驻批次重新入队续跑。
    this.shouldRun = typeof opts.shouldRun === 'function' ? opts.shouldRun : () => true;
    this._parked = [];                                  // 关闸期间完成当前步、等待续跑的在制批次
    // P1-4 APS→dispatch 指令：由 APS 计划回填，驱动派工（而非硬编码 LITHO）。
    // bottleneckMods：APS 实时识别的瓶颈模块（HYBRID 在这些模块上用 BN 优先清瓶颈）；
    // criticalLots：APS 排程判为 LATE/吃紧的工单关键 lot，派工时绝对优先。
    this.apsDirective = { bottleneckMods: [...(opts.hybridBn || BN_DEFAULT)], criticalLots: new Set(), criticalCount: 0, updatedAt: 0 };
  }

  // P1-4：由 APS 计划回填派工指令（server.js 定时 recompute 调用）
  setApsDirective(d = {}) {
    const cl = d.criticalLots instanceof Set ? d.criticalLots : new Set(Array.isArray(d.criticalLots) ? d.criticalLots : []);
    this.apsDirective = {
      bottleneckMods: Array.isArray(d.bottleneckMods) && d.bottleneckMods.length ? d.bottleneckMods : [...this.hybridBn],
      criticalLots: cl,
      criticalCount: d.criticalCount != null ? d.criticalCount : cl.size,
      updatedAt: d.updatedAt || Date.now(),
    };
  }

  // ---- 工单/批次 ----
  // soId/customer：订单驱动生产（P0-1）—— 工单与批次归属某销售订单(SO)，事件贯通主轴
  // NPI：designId/maskId/productType(engineering|tapeout|volume) + passes(设计工艺层数→重入次数) + qualification(流片资格验证增一趟重入)
  createWO({ product = 'N2', qty = 3, dueHours = 48, soId = null, customer = null,
             designId = null, maskId = null, productType = 'volume', passes = null, qualification = false } = {}) {
    const def = PRODUCTS[product] || PRODUCTS.N2;
    const usePasses = passes != null ? passes : def.passes;
    // NPI-4 design→route：工程批/流片批按设计工艺层数派生重入路线；qualification 增一趟重入代表资格验证(qual)轮
    const route = buildRoute(qualification ? usePasses + 1 : usePasses);
    const wo = { id: `WO-${String(++this.woSeq).padStart(4, '0')}`, product, productLabel: def.label,
      qty, dueHours, created: Date.now(), due: Date.now() + dueHours * 3600e3, lots: [],
      soId: soId || null, customer: customer || null,
      designId: designId || null, maskId: maskId || null, productType: productType || 'volume' };
    for (let i = 0; i < qty; i++) {
      const lot = { id: `LOT-${String(++this.lotSeq).padStart(4, '0')}`, wo: wo.id, product, productLabel: def.label,
        route, step: 0, rem: route.length, status: 'WIP', due: wo.due, created: Date.now(),
        hist: [], curTool: null, curStart: null, _pt: 0, wafers: null,
        soId: soId || null, customer: customer || null,
        designId: designId || null, maskId: maskId || null, productType: productType || 'volume' };
      // 晶圆级追踪：每 lot 25 片（slot 1..25），逐片状态随加工推进
      const wafers = [];
      for (let s = 1; s <= 25; s++) wafers.push({ slot: s, wafer: `${lot.id}-W${String(s).padStart(2, '0')}`, status: 'WIP', step: 0, tool: null, holdReason: null });
      lot.wafers = wafers;
      wo.lots.push(lot.id); this.lots.push(lot); this.byLot.set(lot.id, lot);
      this.stats.wip++;
      if (this.persist) { this.persist.woCreate(wo); this.persist.lotCreate(lot); this.persist.waferCreate(lot, wafers); }
      this._enqueue(lot, route[0]);
      this.stats.releases++;
    }
    this.wos.push(wo);
    return wo;
  }

  // ---- 内部：入队 + 派工触发 ----
  _enqueue(lot, modKey) {
    lot._pt = this.modAvgH[modKey] * (0.7 + 0.6 * Math.random());   // 本步预估时长（供 SPT/CR）
    this.queues[modKey].push(lot);
    this.emit({ type: 'lotRelease', lot: lot.id, wo: lot.wo, mod: modKey, product: lot.product, so: lot.soId || null, customer: lot.customer || null });
    this.dispatch(modKey);
  }

  dispatch(modKey) {
    if (!this.shouldRun()) return;   // 演示系统"自动化总开关"关：不派工（产线冻结，队列等待开闸）
    const q = this.queues[modKey];
    if (!q || q.length === 0) return;
    const free = this.tools.filter(t => t.module === modKey && t._lot == null && t.status === 'IDLE' && !t._hold);
    if (free.length === 0) return;
    const t = free[0];
    const idx = this._pick(q, modKey);
    const lot = q.splice(idx, 1)[0];
    t._lot = lot.id; t.status = 'RUN';
    this.emit({ type: 'toolStatus', id: t.id, status: 'RUN' });
    lot.curTool = t.id; lot.curStart = Date.now();
    if (this.persist) this.persist.lotUpdate(lot);
    this._processing.set(t.id, lot);
    this.emit({ type: 'lotStart', id: t.id, tool: t.id, lot: lot.id, wo: lot.wo, mod: modKey });
    const durMs = Math.max(300, (25 / Math.max(1, t.wph)) * 3600e3 / this.speed);
    // 看门狗：默认自驱动，防 EAP 缺席时死锁；EAP 真实回灌 lotDone 会先清掉它（见 completeTool）
    t._watchDog = setTimeout(() => this.completeTool(t.id), durMs);
  }

  completeTool(toolId) {
    const lot = this._processing.get(toolId);
    if (!lot) return;
    const t = this.byId.get(toolId);
    if (t && t._watchDog) { clearTimeout(t._watchDog); t._watchDog = null; }   // 清看门狗：EAP 真实回灌的完成优先，杜绝重复/提前完成
    this._processing.delete(toolId); t._lot = null;
    const stepMod = lot.route[lot.step];
    const hEntry = { step: lot.step, mod: stepMod, tool: toolId, start: lot.curStart, end: Date.now(),
      durH: +((Date.now() - lot.curStart) / 3600e3).toFixed(3) };
    lot.hist.push(hEntry);
    this.emit({ type: 'lotStepDone', lot: lot.id, mod: stepMod, tool: toolId });
    if (this.persist) this.persist.lotStepDone(lot.id, hEntry);
    lot.curTool = null; lot.curStart = null;
    lot.step++; lot.rem--;
    if (lot.step >= lot.route.length) {
      lot.status = 'DONE'; this.stats.done++; this.stats.wip--;
      this.stats.cycSumH += (Date.now() - lot.created) / 3600e3;
      this._finalizeWafers(lot, 'DONE');
      this.emit({ type: 'lotDone', id: toolId, tool: toolId, lot: lot.id, wo: lot.wo, product: lot.product, cycleH: +((Date.now() - lot.created) / 3600e3).toFixed(2), so: lot.soId || null, customer: lot.customer || null });
    } else if (lot.status === 'HOLD') {
      this._finalizeWafers(lot, 'HOLD');
      this.emit({ type: 'lotHold', lot: lot.id, reason: lot.holdReason || 'SPC' });   // SPC 停线：完成当前步后不入队
    } else if (!this.shouldRun()) {
      // 演示系统"自动化总开关"关：完成当前步后停在原地（不推进下一站），
      // 批次进入 _parked 等待开闸；resume() 时重新入队续跑（产线冻结语义）。
      this._parked.push(lot);
    } else {
      this.stats.moves++;
      this._advanceWafers(lot);
      this._enqueue(lot, lot.route[lot.step]);          // 自动尝试下一模块派工
    }
    if (this.persist) this.persist.lotUpdate(lot);
    t.status = 'IDLE';
    this.emit({ type: 'toolStatus', id: toolId, status: 'IDLE' });
    this.dispatch(t.module);
    this._pruneDone();   // 回收已完工的 lot/wo，锁死内存上限
  }

  // 演示系统"自动化总开关"开闸续跑：把关闸期间完成当前步后停驻的批次重新入队，
  // 继续下一站流转（与 loadAndHydrate 的入队语义一致）。
  resume() {
    if (!this._parked.length) return 0;
    const n = this._parked.length;
    for (const lot of this._parked) {
      if (lot.status === 'WIP' && lot.route[lot.step] != null) this._enqueue(lot, lot.route[lot.step]);
    }
    this._parked = [];
    return n;
  }

  // 内存护栏：在制/历史 lot、wo 超过上限时回收最旧已完成项，防止无限增长拖垮整机。
  // 仅移除 DONE 的 lot 与「全部子批已完成」的 wo；在制/HOLD 绝不删，避免破坏派工对账。
  _pruneDone() {
    if (this.lots.length > this.maxLots) {
      const over = this.lots.length - this.maxLots;
      let removed = 0;
      for (let i = 0; i < this.lots.length && removed < over; i++) {
        if (this.lots[i].status === 'DONE') { this.byLot.delete(this.lots[i].id); this.lots.splice(i, 1); i--; removed++; }
      }
    }
    if (this.wos.length > this.maxWos) {
      const over = this.wos.length - this.maxWos;
      let removed = 0;
      for (let i = 0; i < this.wos.length && removed < over; i++) {
        const wo = this.wos[i];
        const allDone = (wo.lots || []).every(id => { const l = this.byLot.get(id); return !l || l.status === 'DONE'; });
        if (allDone) { this.wos.splice(i, 1); i--; removed++; }
      }
    }
  }

  // 晶圆随 lot 步序推进：每步小概率工艺损耗标记为 SCRAP（全路线累计约 1 片）
  _advanceWafers(lot) {
    if (!lot.wafers) return;
    for (const w of lot.wafers) {
      if (w.status === 'SCRAP') continue;
      w.step = lot.step;
      if (Math.random() < 0.004) w.status = 'SCRAP';
    }
  }
  _finalizeWafers(lot, status) {
    if (!lot.wafers) return;
    for (const w of lot.wafers) {
      if (w.status === 'SCRAP') continue;
      w.step = lot.step; w.status = status;
    }
  }

  // ---- SPC 停线：设备/批次 hold 与 release ----
  holdTool(toolId, reason = 'SPC') {
    const t = this.byId.get(toolId);
    if (!t) return false;
    t._hold = true; t.holdReason = reason;
    this.emit({ type: 'toolHold', id: toolId, reason });
    return true;
  }
  releaseTool(toolId) {
    const t = this.byId.get(toolId);
    if (!t) return false;
    t._hold = false; t.holdReason = null;
    this.emit({ type: 'toolRelease', id: toolId });
    this.dispatch(t.module);
    return true;
  }
  holdLot(lotId, reason = 'SPC') {
    const lot = this.byLot.get(lotId);
    if (!lot || lot.status !== 'WIP') return false;
    lot.status = 'HOLD'; lot.holdReason = reason;
    if (lot.wafers) lot.wafers.forEach(w => { if (w.status === 'WIP') { w.status = 'HOLD'; w.holdReason = reason; } });
    this.emit({ type: 'lotHold', lot: lotId, reason });
    if (this.persist) this.persist.lotUpdate(lot);
    return true;
  }
  releaseLot(lotId) {
    const lot = this.byLot.get(lotId);
    if (!lot || lot.status !== 'HOLD') return false;
    lot.status = 'WIP'; lot.holdReason = null;
    if (lot.wafers) lot.wafers.forEach(w => { if (w.status === 'HOLD') w.status = 'WIP'; });
    this.emit({ type: 'lotReleaseHold', lot: lotId }); // 蓝图态：lotReleaseHold 事件当前无订阅者（挂枝/广播）
    this._enqueue(lot, lot.route[lot.step]);            // 重新入队继续流转
    if (this.persist) this.persist.lotUpdate(lot);
    return true;
  }

  // ---- 派工规则（对齐 DES pickBy：HYBRID = 瓶颈BN / 其余FIFO） ----
  // P1-4：优先服从 APS 指令——关键批次(critical/LATE)绝对优先；HYBRID 的瓶颈模块由 APS 实时驱动
  _pick(queue, modKey) {
    const d = this.apsDirective;
    // 关键批次优先：APS 判为 LATE/吃紧工单的关键 lot，无论模块一律插队，缩短逾期风险
    if (d && d.criticalLots && d.criticalLots.size) {
      const ci = queue.findIndex(l => d.criticalLots.has(l.id));
      if (ci >= 0) return ci;
    }
    // 瓶颈感知：HYBRID 的 BN 优先模块 = APS 实时瓶颈（替代硬编码 LITHO），集中清约束
    const bn = (d && Array.isArray(d.bottleneckMods) && d.bottleneckMods.length) ? d.bottleneckMods : this.hybridBn;
    if (this.rule === 'HYBRID') return bn.includes(modKey) ? pickBy(queue, 'BN', modKey, this) : pickBy(queue, 'FIFO', modKey, this);
    if (this.rule === 'BN') return pickBy(queue, 'BN', modKey, this);
    return pickBy(queue, this.rule, modKey, this);
  }

  setRule(rule) { this.rule = rule; }

  // ---- 查询 ----
  wipSnapshot() {
    const byModule = {};
    ROUTE.forEach(m => {
      byModule[m] = { queue: this.queues[m].length,
        processing: this.tools.filter(t => t.module === m && t._lot != null).length };
    });
    const byProduct = {};
    this.lots.forEach(l => { if (l.status === 'WIP') byProduct[l.product] = (byProduct[l.product] || 0) + 1; });
    return { rule: this.rule, byModule, byProduct, wip: this.stats.wip, done: this.stats.done,
      moves: this.stats.moves, releases: this.stats.releases,
      avgCycleH: this.stats.done ? +(this.stats.cycSumH / this.stats.done).toFixed(2) : 0 };
  }
  lotView(lot) {
    const wafers = lot.wafers || [];
    const y = {}; wafers.forEach(w => { y[w.status] = (y[w.status] || 0) + 1; });
    return { id: lot.id, wo: lot.wo, product: lot.product, step: lot.step, rem: lot.rem,
      status: lot.status, due: new Date(lot.due).toISOString(), created: new Date(lot.created).toISOString(),
      curTool: lot.curTool, waferCount: wafers.length, waferYield: y, hist: lot.hist,
      designId: lot.designId || null, maskId: lot.maskId || null, productType: lot.productType || 'volume',
      soId: lot.soId || null, customer: lot.customer || null };
  }
  woView(wo) {
    const lots = this.lots.filter(l => l.wo === wo.id);
    const byS = {}; lots.forEach(l => { byS[l.status] = (byS[l.status] || 0) + 1; });
    return { id: wo.id, product: wo.product, qty: wo.qty, dueHours: wo.dueHours,
      created: new Date(wo.created).toISOString(), due: new Date(wo.due).toISOString(),
      lots: byS, total: lots.length,
      designId: wo.designId || null, maskId: wo.maskId || null, productType: wo.productType || 'volume',
      soId: wo.soId || null, customer: wo.customer || null };
  }
}

module.exports = { WIPEngine, ROUTE, PRODUCTS, buildRoute, pickBy };
