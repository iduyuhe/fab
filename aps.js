// ============================================================
//  APS — 产能计划引擎（先进排程 Advanced Planning & Scheduling）
//  无状态实时计算：读引擎快照（tools/lots/wos/主数据），输出：
//   · 模块产能模型（容量 wph / 24h 批次-步产能）
//   · 模块负荷率（在制需求 vs 产能）→ 瓶颈识别（Top3 + 原因 + 建议）
//   · 工单前推排程（lot 并行 · 路线步时 + 瓶颈等待）→ ETC/交期状态
//  API: GET /api/aps?horizon=24
// ============================================================
const MOD_NAMES = {
  LITHO: '光刻 Litho', ETCH: '刻蚀 Etch', DEP: '薄膜沉积 Dep',
  CMP: 'CMP', IMPL: '离子注入 Implant', METRO: '量测 Metrology',
};
// 模块 → 产线/工段（拓扑单源：与 MES 共用 config/topo.js，C5/C6）
const { MODULE_LINE } = require('./config/topo');

class APSEngine {
  // snapshot: { tools, lots, wos, modAvgH, rule, lineOf, _useILP }
  // 全部引用只读，不修改任何引擎状态
  // _useILP: 可选布尔，true 时对瓶颈负荷分配启用整数规划近似分支（默认 heuristic）
  plan(snap, horizonH = 24) {
    const { tools, lots, wos, modAvgH, rule, lineOf, _useILP } = snap;
    const now = Date.now();
    const mods = Object.keys(MOD_NAMES);
    const lineKey = id => (typeof lineOf === 'function' ? lineOf(id) : 'FAB-L3');

    // ---------- 1. 模块产能模型 ----------
    const mod = {};
    mods.forEach(m => {
      const ts = tools.filter(t => t.module === m);
      mod[m] = {
        key: m, name: MOD_NAMES[m], tools: ts.length,
        run: ts.filter(t => t.status === 'RUN').length,
        down: ts.filter(t => t.status === 'DOWN' || t.status === 'PM').length,
        capWph: ts.reduce((s, t) => s + (t.status !== 'DOWN' ? t.wph : 0), 0),   // 可用小时产能(wafer)
        avgH: modAvgH[m] || 1,                                                   // 单台设备单步时长(hr)
        needCount: 0,                                                            // 在制需求：批次-步
        demandH: 0,                                                              // 需求加工小时
        cap24: 0,                                                                // 24h 批次-步产能
      };
      mod[m].cap24 = mod[m].tools * (24 / (mod[m].avgH || 1));                   // 设备数 × 24h/单步时长
    });

    // ---------- 2. 在制需求（剩余路线累计） ----------
    for (const lot of lots) {
      if (lot.status !== 'WIP') continue;
      for (let i = lot.step; i < lot.route.length; i++) {
        const m = lot.route[i];
        if (mod[m]) { mod[m].needCount++; mod[m].demandH += mod[m].avgH; }
      }
    }

    // ---------- 3. 负荷率 + 瓶颈 ----------
    mods.forEach(m => {
      const c = mod[m];
      c.loadPct = c.cap24 > 0 ? +(c.needCount / c.cap24 * 100).toFixed(1) : 100;
      c.status = c.loadPct >= 100 ? 'OVERLOAD' : c.loadPct >= 75 ? 'BUSY' : c.loadPct >= 30 ? 'NORMAL' : 'IDLE';
      // 瓶颈等待系数：负荷 >80% 后线性放大（0→0.8→2.8 倍步时）
      c.waitK = Math.max(0, (c.loadPct - 80) / 100) * 4;
    });
    const ranked = [...mods].sort((a, b) => mod[b].loadPct - mod[a].loadPct);
    const bottleneck = ranked.slice(0, 3).map((m, i) => {
      const c = mod[m];
      const reason = c.loadPct >= 100 ? `负荷 ${c.loadPct}% 超产能（需求 ${c.needCount} 批次-步 / 24h 产能 ${Math.round(c.cap24)}）`
        : c.loadPct >= 75 ? `负荷 ${c.loadPct}% 偏高（${c.tools} 台中 ${c.run} 台运行）`
        : `负荷 ${c.loadPct}% 正常`;
      const suggest = c.loadPct >= 85
        ? (i === 0 ? '增加光刻产能或转移部分批次至低负荷时段（加班/扩充设备）' : '提升优先级调度，减少该模块排队等待')
        : '维持现状，定期复查';
      return { module: m, name: c.name, loadPct: c.loadPct, reason, suggest };
    });

    // ---------- 3.5 产线级聚合（数字孪生"产线级"数据地基） ----------
    // 把模块维度按拓扑 roll-up 为 产线(FAB-Lx) 负荷 / 瓶颈 / 在制分布
    const lineAgg = {};
    for (const t of tools) {
      const lk = lineKey(t.id);
      if (!lineAgg[lk]) lineAgg[lk] = {
        key: lk, tools: 0, run: 0, down: 0, capWph: 0,
        needCount: 0, demandH: 0, cap24: 0, mods: {},
      };
      const la = lineAgg[lk];
      la.tools++; if (t.status === 'RUN') la.run++;
      if (t.status === 'DOWN' || t.status === 'PM') la.down++;
      la.capWph += t.status !== 'DOWN' ? (t.wph || 0) : 0;
      la.mods[t.module] = (la.mods[t.module] || 0) + 1;
    }
    // 产线 24h 产能 = 各模块产能之和（与模块口径一致）
    mods.forEach(m => { const la = lineAgg[MODULE_LINE[m].line]; if (la) la.cap24 += mod[m].cap24; });
    // 在制需求按当前设备反查产线归属
    for (const lot of lots) {
      if (lot.status !== 'WIP') continue;
      for (let i = lot.step; i < lot.route.length; i++) {
        const m = lot.route[i];
        if (!mod[m]) continue;
        const lk = lineKey(lot.curTool || '');
        const la = lineAgg[lk] || lineAgg['FAB-L3'];
        la.needCount++; la.demandH += mod[m].avgH;
      }
    }
    const lineKeys = Object.keys(lineAgg);
    lineKeys.forEach(lk => {
      const la = lineAgg[lk];
      la.loadPct = la.cap24 > 0 ? +(la.needCount / la.cap24 * 100).toFixed(1) : 0;
      la.status = la.loadPct >= 100 ? 'OVERLOAD' : la.loadPct >= 75 ? 'BUSY' : la.loadPct >= 30 ? 'NORMAL' : 'IDLE';
      la.hotMods = Object.entries(la.mods).map(([k, v]) => ({ module: k, tools: v }));
    });
    const lineRanked = lineKeys.sort((a, b) => lineAgg[b].loadPct - lineAgg[a].loadPct);
    const lineBottleneck = lineRanked.slice(0, 3).map(lk => {
      const la = lineAgg[lk];
      // 该产线内负荷最高的模块（从已算好的模块负荷里取，而非依赖全局前3）
      const modsInLine = mods.filter(m => MODULE_LINE[m].line === lk);
      const hotModule = modsInLine.sort((a, b) => mod[b].loadPct - mod[a].loadPct)[0] || null;
      return {
        line: lk, loadPct: la.loadPct, status: la.status,
        tools: la.tools, run: la.run, down: la.down,
        needCount: la.needCount, cap24: Math.round(la.cap24),
        hotModule,
      };
    });

    // ---------- 4. 工单前推排程（lot 并行） ----------
    const scheduled = wos.map(wo => {
      const lotsOf = lots.filter(l => l.wo === wo.id);
      let maxChainH = 0, maxLot = '';
      for (const lot of lotsOf) {
        let chainH = 0;
        for (let i = lot.step; i < lot.route.length; i++) {
          const c = mod[lot.route[i]];
          if (!c) continue;
          chainH += c.avgH * (1 + c.waitK);                                   // 步时 × (1+等待)
        }
        if (chainH > maxChainH) { maxChainH = chainH; maxLot = lot.id; }
      }
      const etcH = +maxChainH.toFixed(2);
      const finishAt = now + etcH * 3600e3;
      const remainH = (wo.due - now) / 3600e3;
      const slackH = +(remainH - etcH).toFixed(2);                             // 交期余量
      const status = slackH >= 0 ? (slackH / Math.max(1, etcH) >= 0.25 ? 'EARLY' : 'ONTIME') : 'LATE';
      return {
        id: wo.id, product: wo.product, productLabel: wo.productLabel, qty: wo.qty,
        lots: wo.lots.length, due: new Date(wo.due).toISOString(),
        etcH, finishAt: new Date(finishAt).toISOString(), slackH,
        criticalLot: maxLot, status, critical: status === 'LATE' || slackH < etcH * 0.25,
      };
    });
    const late = scheduled.filter(w => w.status === 'LATE').length;
    const onTimePct = scheduled.length ? +((scheduled.length - late) / scheduled.length * 100).toFixed(0) : 100;

    // ---------- 5. KPI + 建议 ----------
    const kpi = {
      bottleneckModule: bottleneck[0] ? bottleneck[0].module : null,
      bottleneckLoad: bottleneck[0] ? bottleneck[0].loadPct : 0,
      avgLoadPct: +((mods.reduce((s, m) => s + mod[m].loadPct, 0)) / mods.length).toFixed(1),
      onTimePct, lateWos: late, wosOpen: scheduled.length,
      wip: lots.filter(l => l.status === 'WIP').length,
      totalCapWph: mods.reduce((s, m) => s + mod[m].capWph, 0),
      rule,
    };
    const suggest = [];
    if (bottleneck[0] && bottleneck[0].loadPct >= 100) suggest.push(`瓶颈 ${bottleneck[0].module} 负荷 ${bottleneck[0].loadPct}%：${bottleneck[0].suggest}`);
    if (late > 0) suggest.push(`${late} 个工单预计逾期（${scheduled.filter(w => w.status === 'LATE').map(w => w.id).join(', ') || ''}），建议提高优先级或瓶颈模块加班`);
    if (mods.every(m => mod[m].loadPct < 60)) suggest.push('全线产能富余（平均负荷 ' + kpi.avgLoadPct + '%），可承接新订单');
    if (!suggest.length) suggest.push('产能均衡，无阻塞风险');

    // L3 专业版：约束求解分支（整数规划近似）
    // 默认 heuristic（保留阶段0 无状态启发式）；_useILP 时切换为 ILP 近似并给出 gap
    let solver = 'heuristic', optimality = null;
    if (_useILP) {
      const demand = mods.map(m => ({ module: m, needH: mod[m].demandH, cap24: mod[m].cap24, loadPct: mod[m].loadPct }));
      const ilp = this.solveILP(mods, demand, horizonH);
      solver = 'ilp';
      optimality = { gapPct: ilp.gapPct, objValue: ilp.objValue, bound: ilp.bound, feasible: ilp.feasible };
    }

    return {
      generated: new Date().toISOString(), horizonH, rule,
      kpi,
      modules: mods.map(m => ({ ...mod[m] })),
      lines: lineKeys.map(lk => ({ ...lineAgg[lk], hotMods: lineAgg[lk].hotMods })),
      lineBottleneck,
      bottleneck, wos: scheduled, suggest,
      solver, optimality,
    };
  }

  // ============================================================
  //  solveILP(modules, demand, horizonH) — 整数规划近似求解（L3）
  //  问题建模（轻量，内置近似、无外部包）：
  //    决策：各模块「加班小时 x_m ≥ 0 整数」与「转产批次 y_m ≥ 0 整数」
  //    目标：min Σ (α·x_m + β·LATE_m)  —— 最小化加班成本 + 逾期惩罚
  //    约束：cap24_m + x_m · 单步产能 ≥ needH_m（产能满足）；x_m ≤ horizonH·空闲设备
  //  近似解法：贪心 + 局部搜索（不保证全局最优，故返回 gap 估计）
  //    1) 贪心：对 OVERLOAD 模块按缺口分配最小加班小时
  //    2) 局部搜索：尝试把高负荷模块需求向 IDLE 模块虚拟转产，降低最大负荷
  //  gap 估计：用「上界(贪心成本) / 下界(松弛LP:连续加班)」的比值近似最优性间隙
  //  返回: { assignment, objValue, bound, gapPct, feasible }
  // ============================================================
  solveILP(modules, demand, horizonH = 24) {
    const alpha = 1.0, beta = 5.0;                 // 成本权重
    const demandMap = {};
    demand.forEach(d => { demandMap[d.module] = d; });
    const ov = modules.filter(m => demandMap[m] && demandMap[m].loadPct >= 100);

    // ---- 下界（LP 松弛）：连续加班即可补缺口 ----
    let bound = 0;
    for (const m of ov) {
      const d = demandMap[m];
      const shortH = Math.max(0, d.needH - d.cap24);
      const stepCap = d.cap24 / Math.max(1, 24);   // 每小时产能
      bound += alpha * (stepCap > 0 ? shortH / stepCap : shortH);
    }

    // ---- 贪心可行解：整数加班小时向上取整 ----
    const assignment = [];
    let obj = 0;
    for (const m of ov) {
      const d = demandMap[m];
      const shortH = Math.max(0, d.needH - d.cap24);
      const stepCap = d.cap24 / Math.max(1, 24);
      let overH = stepCap > 0 ? Math.ceil(shortH / stepCap) : Math.ceil(shortH);
      overH = Math.min(overH, Math.max(0, horizonH));   // 不超过 horizon
      const late = overH * stepCap < shortH ? 1 : 0;    // 仍不足→逾期
      obj += alpha * overH + beta * late;
      assignment.push({ module: m, overtimeH: overH, lateFlag: !!late });
    }

    // ---- 局部搜索：向 IDLE 模块虚拟转产，降低 obj（演示：最多一轮交换） ----
    const idle = modules.filter(m => demandMap[m] && demandMap[m].loadPct < 30);
    if (ov.length && idle.length) {
      const donor = ov.sort((a, b) => demandMap[b].loadPct - demandMap[a].loadPct)[0];
      const recv = idle.sort((a, b) => demandMap[a].loadPct - demandMap[b].loadPct)[0];
      const shift = Math.min(demandMap[donor].needH * 0.2, demandMap[recv].cap24 * 0.5);
      if (shift > 0) {
        demandMap[donor].needH -= shift; demandMap[recv].needH += shift;
        // 重算 donor 加班（可能下降）
        const dd = demandMap[donor];
        const shortH = Math.max(0, dd.needH - dd.cap24);
        const stepCap = dd.cap24 / Math.max(1, 24);
        const overH = Math.min(Math.ceil(shortH / stepCap), horizonH);
        const a0 = assignment.find(x => x.module === donor);
        if (a0) { a0.overtimeH = overH; obj = Math.max(0, obj - alpha); }
      }
    }

    const gapPct = bound > 0 ? +(((obj - bound) / bound) * 100).toFixed(1) : 0;
    return { assignment, objValue: +obj.toFixed(2), bound: +bound.toFixed(2), gapPct, feasible: ov.every(m => !assignment.find(a => a.module === m).lateFlag) };
  }
}

module.exports = { APSEngine, MOD_NAMES };
