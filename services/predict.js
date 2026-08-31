// ============================================================
//  预测与根因分析引擎（跨阶段交期预测 + 根因链）
//  纯函数：输入 engine(MES 派工引擎) + storage，输出可解释的 ETA/根因。
//  设计原则：
//   - 周期取自 engine.modAvgH（25片 / 平均WPH，来自设备真实配置），属"工艺小时"；
//   - ETA 按 engine.speed 加速比折算成墙钟小时（与运行态仿真同帧，避免假阳性逾期）；
//   - 根因链按「HOLD → 设备硬阻塞 → 工艺判异(SPC) → 队列拥塞 → 光罩缺失」逐层归因，
//     每层只命中"真正相关"的批次，避免全量误报。
// ============================================================

const ROUTE = ['LITHO', 'ETCH', 'DEP', 'CMP', 'IMPL', 'METRO'];
const MOD_NAME = { LITHO: '光刻', ETCH: '刻蚀', DEP: '薄膜', CMP: '平坦化', IMPL: '离子注入', METRO: '量测' };

// 单步名义周期(工艺小时)：优先用引擎真实值（设备 WPH 推导），兜底 4h
function nominalCycle(engine, mod) {
  const h = engine.modAvgH && engine.modAvgH[mod];
  return (h && h > 0) ? h : 4;
}

// 模块实时态势
function moduleState(engine, mod) {
  const queue = (engine.queues && engine.queues[mod]) ? engine.queues[mod].length : 0;
  const tools = (engine.tools || []).filter(t => t.module === mod);
  const down = tools.filter(t => t.status === 'DOWN' || t._hold).length;
  const free = tools.filter(t => t.status === 'IDLE' && !t._hold && t._lot == null).length;
  const processing = tools.filter(t => t._lot != null).length;
  return { mod, name: MOD_NAME[mod] || mod, queue, total: tools.length, down, free, processing };
}

// 单批 ETA(墙钟小时) + 根因链
function etaLot(engine, lot, spcAlarms) {
  const now = Date.now();
  const step = lot.step || 0;
  const route = lot.route || [];
  const routeLen = route.length;
  const speed = (engine.speed && engine.speed > 0) ? engine.speed : 1;
  // 当前已在设备上加工 → 当前步计入进行中，剩余从 step+1 起；否则从 step 起
  const remaining = (lot.curTool ? route.slice(step + 1) : route.slice(step));

  let baseH = 0, congH = 0;
  const rc = [];
  const held = lot.status === 'HOLD';

  if (held) rc.push({ type: 'HOLD', severity: 'high', detail: `批次被 Hold：${lot.holdReason || 'SPC'}`, link: lot.id });

  for (const mod of remaining) {
    const cyc = nominalCycle(engine, mod);
    baseH += cyc;
    const ms = moduleState(engine, mod);
    if (ms.down > 0) congH += (ms.free === 0 ? 2 : 1) * cyc;     // 停机加等待（全停机更严重）
  }

  // 工艺根因：SPC 判异精确命中本批当前设备
  if (lot.curTool) {
    const spcHit = (spcAlarms || []).find(a => a.tool === lot.curTool);
    if (spcHit) rc.push({ type: 'PROCESS', severity: 'mid',
      detail: `SPC 判异：${spcHit.param} @ ${spcHit.tool}（μ=${spcHit.mean}, UCL=${spcHit.ucl}）`, link: lot.id });
  }

  // 设备/队列根因：仅对"正在排队等待"的批次判定（curTool 为空 = 尚未上机），
  // 且需满足"有停机削减产能 + 无空闲 + 有排队"才判硬阻塞，避免繁忙产线全量误报。
  const nextMod = route[step];
  if (nextMod && !lot.curTool) {
    const ms = moduleState(engine, nextMod);
    if (ms.down > 0 && ms.free === 0 && ms.queue > 0) rc.push({ type: 'EQUIPMENT', severity: 'high',
      detail: `下一站 ${ms.name} 停机(${ms.down}/${ms.total})且无空闲，硬阻塞`, link: nextMod });
    else if (ms.queue > ms.free + 2) rc.push({ type: 'QUEUE', severity: 'mid',
      detail: `${ms.name} 排队 ${ms.queue} ≫ 空闲 ${ms.free}`, link: nextMod });
  }

  // ETA：工艺小时 ÷ 加速比 = 墙钟小时（与运行态仿真同帧）
  const etaProcessH = baseH + congH;
  const etaWallH = etaProcessH / speed;
  const etaTs = now + etaWallH * 3600e3;
  const dueRemainingH = ((lot.due || now) - now) / 3600e3;
  const slipH = etaWallH - dueRemainingH;            // >0 表示会晚于承诺交期

  let risk = 'OK';
  if (held) risk = 'HOLD';                           // 被 Hold = 卡住待释放，单列状态
  else if (dueRemainingH < 0 || slipH > 0) risk = 'LATE';
  else if (rc.some(r => r.type === 'EQUIPMENT' || r.type === 'QUEUE')) risk = 'WATCH';
  else if (slipH > -12) risk = 'WATCH';

  return {
    id: lot.id, wo: lot.wo, product: lot.product, productType: lot.productType || 'volume',
    step, routeLen, status: lot.status, due: lot.due, etaTs,
    etaWallH: +etaWallH.toFixed(2), slipH: +slipH.toFixed(1),
    risk, rootCauses: rc, designId: lot.designId || null,
  };
}

function rcKey(r) { return r.type + '::' + r.detail; }

// ---------------- OTD 交期预测 + 跨阶段根因 ----------------
function analyzeOTD(engine, storage) {
  const now = Date.now();
  const spc = storage.querySpcAlarms ? storage.querySpcAlarms(50) : [];
  const lots = (engine.lots || []).filter(l => l.status !== 'DONE');
  const lotEta = lots.map(l => etaLot(engine, l, spc));

  // 工单聚合：ETA 取关键路径（最晚批次），根因取并集
  const byWo = {};
  for (const le of lotEta) (byWo[le.wo] = byWo[le.wo] || []).push(le);
  const wos = Object.values(byWo).map(group => {
    const etaWallH = Math.max(...group.map(g => g.etaWallH));
    const wo = engine.wos.find(w => w.id === group[0].wo) || {};
    const dueRemainingH = (wo.due ? (wo.due - now) : Math.max(...group.map(g => g.due - now || 0))) / 3600e3;
    const slipH = etaWallH - dueRemainingH;
    const hasHold = group.some(g => g.status === 'HOLD');
    const hasLate = group.some(g => g.risk === 'LATE');
    const risk = hasLate ? 'LATE' : hasHold ? 'HOLD' : (slipH > 0 ? 'LATE' : (slipH > -12 ? 'WATCH' : 'OK'));
    const rcMap = {};
    group.forEach(g => g.rootCauses.forEach(r => { if (!rcMap[rcKey(r)]) rcMap[rcKey(r)] = r; }));
    const atRisk = group.filter(g => g.risk !== 'OK').length;
    return {
      id: group[0].wo, product: wo.product || group[0].product, qty: wo.qty || group.length,
      due: wo.due || null, etaTs: now + etaWallH * 3600e3, slipH: +slipH.toFixed(1), risk,
      lots: group.length, atRisk,
      rootCauses: Object.values(rcMap).sort((a, b) => (a.severity === 'high' ? -1 : 1) - (b.severity === 'high' ? -1 : 1)),
      soId: wo.soId || null, customer: wo.customer || null, productType: wo.productType || 'volume',
    };
  }).sort((a, b) => a.slipH - b.slipH);

  // 跨阶段根因聚合（按类型计数）
  const rcTypeCount = {};
  const rcByType = {};
  lotEta.forEach(le => le.rootCauses.forEach(r => {
    rcTypeCount[r.type] = (rcTypeCount[r.type] || 0) + 1;
    (rcByType[r.type] = rcByType[r.type] || []).push({ lot: le.id, wo: le.wo, detail: r.detail, severity: r.severity });
  }));

  // 阶段瓶颈视图：每模块的队列/在制/停机/预测拥堵
  const stage = ROUTE.map(mod => {
    const ms = moduleState(engine, mod);
    const wipAtMod = lots.filter(l => (l.route || [])[l.step] === mod && l.status === 'WIP').length;
    const congH = ms.queue > ms.free ? (ms.queue - ms.free) * nominalCycle(engine, mod) * 0.2 : 0;
    return { ...ms, wip: wipAtMod, congH: +congH.toFixed(1), bottleneck: ms.down > 0 || (ms.queue > ms.free + 1) };
  });

  const late = lotEta.filter(l => l.risk === 'LATE').length;
  const held = lotEta.filter(l => l.risk === 'HOLD').length;
  const watch = lotEta.filter(l => l.risk === 'WATCH').length;
  const slips = lotEta.map(l => l.slipH).filter(s => isFinite(s));
  const avgSlip = slips.length ? +(slips.reduce((a, b) => a + b, 0) / slips.length).toFixed(1) : 0;
  const topRoot = Object.entries(rcTypeCount).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([type, n]) => ({ type, n }));

  return {
    generatedAt: new Date(now).toISOString(),
    summary: {
      totalLots: lotEta.length, lateLots: late, heldLots: held, watchLots: watch, onTrack: lotEta.length - late - held - watch,
      wos: wos.length, lateWos: wos.filter(w => w.risk === 'LATE').length, heldWos: wos.filter(w => w.risk === 'HOLD').length,
      avgSlipH: avgSlip, topRootCauses: topRoot,
    },
    wos,
    lots: lotEta.sort((a, b) => a.slipH - b.slipH),
    rootCauseByType: rcByType,
    stage,
  };
}

// ---------------- NPI 研发流预测 + 根因 ----------------
function analyzeNPI(engine, storage) {
  const now = Date.now();
  const spc = storage.querySpcAlarms ? storage.querySpcAlarms(50) : [];
  const designs = storage.listDesigns ? storage.listDesigns() : [];
  const npiLots = (engine.lots || []).filter(l => l.designId);

  const list = designs.map(d => {
    const masks = storage.listMasks ? storage.listMasks(d.id) : [];
    const maskReady = masks.length > 0 && masks.some(m => m.status === 'READY');
    const lots = npiLots.filter(l => l.designId === d.id);
    const eng = lots.filter(l => l.productType === 'engineering');
    const tape = lots.filter(l => l.productType === 'tapeout');
    const vol = lots.filter(l => l.productType === 'volume');
    const focus = tape[0] || eng[0] || vol[0];
    let etaWallH = null, slipH = null, risk = 'OK', progressPct = 0;
    const rc = [];
    if (!focus) {
      rc.push({ type: 'FLOW', severity: 'mid', detail: '尚未投放任何 NPI 批次（工程批/流片批）', link: d.id });
    } else {
      const fe = etaLot(engine, focus, spc);
      progressPct = focus.routeLen ? Math.round((focus.step / focus.routeLen) * 100) : 0;
      etaWallH = fe.etaWallH; slipH = fe.slipH; risk = fe.risk;
      fe.rootCauses.forEach(r => rc.push(r));
    }
    if (!d.mask_id) rc.push({ type: 'MASK', severity: 'high', detail: '设计未绑定光罩（mask_id 缺失）', link: d.id });
    else if (!maskReady) rc.push({ type: 'MASK', severity: 'high', detail: `光罩 ${d.mask_id} 未就绪（状态：${masks.map(m => m.status).join('/') || '无'}）`, link: d.mask_id });

    return {
      id: d.id, name: d.name, product: d.product, status: d.status || 'DESIGN',
      maskId: d.mask_id || null, maskReady,
      engCount: eng.length, tapeCount: tape.length, volCount: vol.length,
      progressPct, etaTs: etaWallH != null ? now + etaWallH * 3600e3 : null, slipH, risk, rootCauses: rc,
    };
  }).sort((a, b) => (a.risk === 'LATE' ? -1 : 0) - (b.risk === 'LATE' ? -1 : 0) || (a.slipH || 0) - (b.slipH || 0));

  const atRisk = list.filter(d => d.risk === 'LATE').length;
  const maskBlocked = list.filter(d => d.rootCauses.some(r => r.type === 'MASK')).length;
  return {
    generatedAt: new Date(now).toISOString(),
    summary: { designs: list.length, atRisk, maskBlocked, totalNpiLots: npiLots.length },
    designs: list,
  };
}

module.exports = { analyzeOTD, analyzeNPI, etaLot, nominalCycle, moduleState, MOD_NAME };
