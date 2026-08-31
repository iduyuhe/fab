// ============================================================
//  知识库（平台事实文本）：供规则应答引擎引用
//  仅含静态说明文本，不含任何实时数字（实时数据一律来自 REST 调用）
// ============================================================

const PLATFORM = {
  name: '数智晶圆厂平台 (Fab MES)',
  tagline: '面向 AI 芯片制造的数字化智能制造演示平台，覆盖 MES / ERP / 数字孪生 / 五大质量与产能引擎。',
  modules: [
    { key: 'DIFF', name: '光刻 (Litho)', desc: '涂胶、曝光、显影，决定图形传递精度，是 CD 漂移最需关注的关键层。' },
    { key: 'ETCH', name: '刻蚀 (Etch)', desc: '各向异性去除薄膜，定义图形侧壁形貌。' },
    { key: 'IMP', name: '离子注入 (Implant)', desc: '控制掺杂浓度与结深，影响器件电性。' },
    { key: 'DEP', name: '薄膜沉积 (Dep)', desc: 'CVD/PVD 生长功能薄膜（栅氧、金属互连）。' },
    { key: 'CMP', name: '化学机械抛光 (CMP)', desc: '全局平坦化，保证多层布线平坦度。' },
    { key: 'MET', name: '量测/检测 (Metrology)', desc: 'CD-SEM、膜厚、缺陷检测，质量闸门。' },
  ],
  engines: [
    {
      key: 'SPC', name: '统计过程控制 (SPC)',
      desc: '对关键尺寸(CD)/膜厚等参数做控制图监控，超 3σ 或趋势异常即报警并拦截批次，防止缺陷流出。',
      howto: '在孪生页看装备级 SPC 控制图；报警出现时由操作员确认(release)或拦截(scrap)。',
    },
    {
      key: 'FDC', name: '故障检测与分类 (FDC)',
      desc: '采集装备 trace 数据，用模型检测异常工况（如真空度漂移、功率异常、腔室退化），实时报警。',
      howto: '查看 /api/fdc 报警列表，定位异常装备与报警类型；腔室级退化显示为 chamberDrift 类型。',
    },
    {
      key: 'PdM', name: '预测性维护 (PdM)',
      desc: '基于装备健康度(E10)与历史趋势评估故障风险，提前排程保养，降低非计划停机。',
      howto: '查看 /api/pdm 风险清单，关注高风险装备的剩余寿命预测。',
    },
    {
      key: 'VM', name: '虚拟量测 (VM)',
      desc: '用装备传感器数据软测量替代部分物理量测，降本提速，覆盖率不足处仍需实体量测兜底。',
      howto: '查看 /api/vm 覆盖率与偏差统计。',
    },
    {
      key: 'APS', name: '高级计划与排程 (APS)',
      desc: '基于瓶颈与产能约束做排产，输出产能利用率、交期达标率等 KPI，并给出瓶颈与改善建议。',
      howto: '查看 /api/aps 的 horizon、KPI、bottleneck 与 suggest。',
    },
  ],
  twins: [
    { level: '装备级', page: 'twin.html', desc: '看单台机台状态、SPC 控制图、实时事件流与报警横幅。' },
    { level: '产线级', page: 'line-twin.html', desc: '看产线 WIP 分布、模块吞吐与瓶颈。' },
    { level: '工厂级', page: 'fab-twin.html', desc: '看全厂产能、在制与 ERP 经营视图的全局态势。' },
  ],
  whatif: '在 sim.html 可做 what-if 仿真：调整产能/节拍/投放节奏，观察 WIP、周期与瓶颈变化。APS 还提供 /api/aps/sim 接口做情景推演。',
};

// 场景化教学引导（关键词触发，返回结构化引导）
const SCENARIOS = {
  spc_cd: {
    title: '用 SPC 拦截 CD 漂移',
    steps: [
      '1) 孪生页切到装备级 (twin.html)，定位 LITHO 模块机台，观察 SPC 控制图。',
      '2) 当 CD 均值漂出 ±3σ 控制限时，/api/spc 会产生报警并标记该批次。',
      '3) 操作员在控制台上确认——可放行(release)或拦截(scrap)，避免缺陷流入后段。',
      '4) 趋势性漂移（连续 7 点单边上偏）即使未超限也应预警，属于 SPC 的“小概率趋势规则”。',
    ],
  },
};

// ============================================================
//  L2 教学级 · 带教导师资源
//  仅含静态引导话术（提示/线索/追问脚手架），不含任何实时数字。
//  导师铁律：对教学类问题只给提示不代做；绝不替学生调用 inject/sim。
// ============================================================

// 实验关键判据端点/字段（供导师函数引用真实状态）
// 字段名以 MES 真实 REST 返回为准（见 server.js / spc.js / aps.js）：
//  - /api/spc  → { groups:[{product,param,tool,n,ucl,lcl,...}], alarms:[{ts,product,param,tool,value,ucl,lcl,rules[]}] }
//  - /api/aps  → { kpi:{bottleneckModule,bottleneckLoad}, modules:[{key,name,loadPct,status}], bottleneck:[{module,name,loadPct,reason,suggest}] }
//  - /api/wip  → { wip, done, moves, releases, byModule, byProduct }
const LAB_EXPERIMENTS = {
  A_spc_cd: {
    name: '实验 A · 用 SPC 拦截 CD 漂移',
    spec: 'CD 规格上限 USL 见 METRO_PARAMS（注入时 def.usl）；控制限为 SPC 自动算出的 ucl/lcl。',
    trigger: '向 /api/spc/inject 注入 参数=CD 且 value > USL 的量测值。',
    judge: '注入后 GET /api/spc 的 alarms 中需存在 param==="CD" 且 rules 含判异(R1~R3)的记录。',
    steps: [
      '① 观察 CD 的规格上限 USL（注入接口中的 def.usl）与控制限 ucl/lcl。',
      '② 自己向 /api/spc/inject 注入一个超出 USL 的 CD 量测值。',
      '③ 查 /api/spc 看 alarms 是否出现 param=CD 的判异记录。',
      '④ 在 twin.html 确认对应设备被 hold（停线）。',
    ],
  },
  B_aps_bottleneck: {
    name: '实验 B · 用 APS 缓解产能瓶颈',
    spec: '瓶颈由 APS 负荷率(loadPct)Top1 决定；>100% 为 OVERLOAD。',
    trigger: '向 /api/aps/sim 传入 downTools（让瓶颈模块更堵）或 extraWos（加派工单）。',
    judge: 'sim 返回的 modules 中对应模块 simLoad > baseLoad，或 simKpi.lateWos 随 extraWos 增加。',
    steps: [
      '① 查 /api/wip 与 /api/aps，找到当前瓶颈模块（bottleneck[0].module）。',
      '② 思考：要让它成为瓶颈，需要怎样改变产能（DOWN 若干台 / 加派工单）。',
      '③ 自己向 /api/aps/sim 提交 downTools 或 extraWos 配置。',
      '④ 看返回的 modules[].delta 与 simKpi.lateWos 冲击。',
    ],
  },
};

// 导师引导话术库：分步提示模板 + 常见误区 + 追问脚手架（只提示，不代做）
const TUTOR = {
  // 公共前缀与追问脚手架
  prefix: '[导师模式·引导]',
  spc_common_misunderstand: [
    '误区1：把"规格限 USL/LSL"与"控制限 ucl/lcl"混淆。触发报警看的是控制限超限（R1 规则），而 USL 是你注入该超过的目标值。',
    '误区2：以为"随便填个数"就能报警。必须 value 超过该 CD 组的控制上限 ucl（通常需明显大于 USL 才会判异）。',
    '误区3：等待系统自动注入。实验要求你自己发起 /api/spc/inject 调用。',
  ],
  spc_prompts: {
    how_to_alarm:
      '回忆一下：CD 的规格上限 USL 是多少？要触发 SPC 判异，注入值需要满足什么条件（与控制限 ucl 的关系）？先想清楚，再决定注入哪个值。',
    why_no_alarm:
      '你注入了值却没看到报警，可能原因：① 注入的 value 未超过控制上限 ucl（控制限由历史均值算出，不一定等于 USL）；② 注入的 param 不是 CD；③ 注入了但没重新查 /api/spc。请先查 /api/spc 确认 alarms 里有没有 param=CD 的判异记录。',
    cd_drift:
      'CD 漂移指量测均值逐渐偏离目标。SPC 对趋势很敏感（连续9点偏上= R2 规则），即使单次未超限，趋势也会判异。想想该注入怎样的一组值来模拟"漂移"。',
  },
  aps_common_misunderstand: [
    '误区1：瓶颈是"设备最多的模块"。瓶颈看的是负荷率 loadPct，不是设备数。',
    '误区2：认为 sim 会改真产线。/api/aps/sim 是无状态 what-if 推演，不写库、不改真实排程。',
    '误区3：直接改真实数据。缓解瓶颈只通过 sim 的 downTools/extraWos 假设，不给真实系统加压。',
  ],
  aps_prompts: {
    how_to_bottleneck:
      '先看 /api/wip 与 /api/aps 的 bottleneck[0].module 字段——当前瓶颈模块是？要让它"更瓶颈"或验证改善，你需要怎样改变它的产能（DOWN 几台？还是加派工单 extraWos）？想清楚再提交 /api/aps/sim。',
    where_bottleneck:
      '瓶颈不是凭感觉，要从数据看：GET /api/aps，看 modules[].loadPct，Top1 即瓶颈；bottleneck[0] 也直接给出。它负荷率是多少？',
    relieve:
      '缓解瓶颈有两条思路：① 增加该模块产能（减少 downTools 或加设备）；② 转移负荷（用 extraWos 模拟把部分批次排到低负荷时段）。你打算从哪条路验证？',
  },
  help_scaffold: {
    next_step:
      '你现在在实验的哪一步？告诉我你已完成的操作（例如：已查过 /api/spc、已注入、已查 /api/aps），我基于真实状态给你下一步提示。',
    reflection:
      '先别急着要答案——你能用自己的话复述一下这个实验的"目标判据"是什么吗？（提示：看 COURSES.md 里每个实验的"判据"一行）',
  },
  // 给教学意图卡片的"可继续问"引导问题
  followups: {
    spc: ['注入后怎么确认真的触发了报警？', '为什么我注入的值没报警？', 'CD 漂移和单次超差有什么区别？'],
    aps: ['当前瓶颈模块负荷率是多少？', 'DOWN 几台能让冲击最明显？', '加派工单会怎样影响交期？'],
    help: ['实验 A 的判据是什么？', '我卡在第几步了？', '下一步该调哪个端点？'],
  },
};

// 意图 → 友好引导菜单（意图不明确时返回）
const MENU = [
  '平台概览 / 你们是做什么的？',
  '怎么看数字孪生（装备/产线/工厂级）？',
  '五大引擎（SPC/FDC/PdM/VM/APS）分别是什么？',
  '查实时 WIP / 在制状态',
  '查设备状态（运行/空闲/故障分布）',
  '查 ERP 成本 / 库存金额',
  '查某设备腔室遥测（腔温/RF/气流量/真空度）',
  '哪些腔室在退化 / 有漂移报警？',
  '怎么做 what-if 仿真？',
  '用 SPC 拦截 CD 漂移（场景教学）',
];

// ============================================================
//  L3 协作副驾资源（面向工程师：根因 + 处置建议 + 工单草稿）
//  仅含静态话术模板与根因映射表，不含任何实时数字（数字一律来自 REST）。
//  副驾铁律：只生成分析与建议文本（含工单草稿），绝不替工程师调用
//            inject/sim/release 等写接口，不写库、不绕开事件总线。
//  注意：以下字段映射以 MES 真实 REST 返回为准（见 server.js / spc.js /
//        aps.js / pdm.js / vm.js / fdc）。任务描述的 WE1~WE6 / score / contrib /
//        rulHours / riskLevel / predicted / residual / solver / optimality 等
//        "深化字段"当前源码尚未落地，副驾函数全部按真实字段实现，并对
//        未来可能出现的可选深化字段做向下兼容回退。
// ============================================================

// SPC 报警规则 → 根因/处置映射（规则来自 spc.js 真实输出）
// 真实 rules 文本形如：
//   'R1 超控制限'      → 单点出界（偶发超差/设备突发偏移/量测异常）
//   'R2 连续9点偏上/偏下' → 系统性漂移（机台老化/工艺参数偏移/环境变化）
//   'R3 连续6点上升/下降' → 趋势性恶化（耗材磨损/温度累积/渐进退化）
const ROOTCAUSE = {
  // SPC 判异规则 → 根因 + 处置 + 工单动作
  spc: {
    'R1 超控制限': {
      cause: '单点超出控制限（mean±3σ），多为偶发超差：来料波动、机台突发偏移、量测异常或换批污染。',
      action: '对该批次复检(Hold+重测)，确认量测可信后评估放行/拦截；排查对应机台近期同一参数事件。',
      ticket: '复检 + 机台点检',
    },
    'R2': {
      cause: '连续 9 点位于均值同侧，提示系统性漂移：机台老化、工艺配方偏移、温湿度/气体纯度等环境缓变。',
      action: 'Hold 该机台并做配方与基准复核，调机(tune)至目标中心；趋势未消除前限制其承接关键层。',
      ticket: '机台调机 + 漂移根因排查',
    },
    'R3': {
      cause: '连续 6 点单调上升/下降，提示趋势性恶化：耗材磨损、腔体污染累积、加热/冷却元件退化。',
      action: '预判将持续越界，提前 Hold 机台并安排 PM/清腔；将受影响在制批次转入备用机台。',
      ticket: '预防性维护(PM) + 趋势拦截',
    },
    // 兜底：命中未知规则或只有 rules 文本
    _fallback: {
      cause: '命中控制图判异规则，需结合参数与机台历史定位是偶发还是系统性。',
      action: 'Hold 相关批次与机台，做复检与配方复核，按严重度决定是否调机/PM。',
      ticket: 'SPC 判异处置',
    },
  },
  // 瓶颈负荷率 → 根因 + 缓解 + 工单动作
  bottleneck: [
    { min: 100, level: '过载', cause: '负荷 ≥100% 超产能：需求批次-步超过 24h 产能，存在硬瓶颈。', action: '增加该模块产能（扩充设备 / 加班 / 将部分批次重排至低负荷时段），或下调投放节奏。', ticket: '瓶颈扩容 / 重排程缓解' },
    { min: 85, level: '偏紧', cause: '负荷 85~100%：逼近上限，少量扰动即转过载。', action: '提升优先级调度减少排队；评估错峰投放；预留 1~2 台缓冲产能。', ticket: '调度优化 / 缓冲产能预留' },
    { min: 75, level: '偏高', cause: '负荷 75~85%：偏高但未阻塞，需监控。', action: '维持并定期复查，避免叠加其他模块退化形成连锁瓶颈。', ticket: '负荷监控' },
    { min: 0, level: '正常', cause: '负荷 <75%：健康。', action: '无需干预，保持现状。', ticket: '—' },
  ],
  // PdM 风险档位 → 建议（基于 pdm.js 真实 suggest 字段）
  pdm: {
    PROACTIVE_PM: { cause: '风险评分高（>0.7）：设备最可能发生下一台故障。', action: '安排提前维护(PM)，避免非计划停机；在停机前转移其 WIP。', ticket: '预测性维护派单' },
    INSPECT: { cause: '风险评分中（0.45~0.7）：存在退化迹象。', action: '加强巡检/在线监控，缩短点检周期，准备备件。', ticket: '巡检加频' },
    NORMAL: { cause: '风险低。', action: '常规维护即可。', ticket: '—' },
  },
  // FDC 报警 → 根因（基于 fdc.js 真实字段：wph 低于模块均值 60%）
  fdc: {
    cause: '装备 wph 低于同模块均值 60%：性能退化（腔体污染/部件磨损/气压/射频异常），但不一定超差。',
    action: '检查该机台工艺性能趋势，必要时清腔/点检/降负荷运行，避免拖累产出。',
    ticket: 'FDC 性能退化排查',
  },
  // VM 精度 → 处置（基于 vm.js 真实 stats：mape / hit5Pct）
  vm: {
    cause: '虚拟量测偏差偏大：模型覆盖不足或工艺漂移，需实体量测兜底。',
    action: '当 errPct 超 5% 或 hit5Pct 偏低时，提升实体量测抽检比例，补充训练样本。',
    ticket: 'VM 精度复核 + 抽检加严',
  },
};

// 副驾话术库：前缀、根因分析模板、处置建议模板、工单草稿模板
const COPILOT = {
  prefix: '[副驾·分析]',   // 所有副驾回复统一前缀，与导师 [导师模式·引导] 区分
  prefixNote: '（副驾仅作分析与建议，工单草稿需工程师确认后由相应系统执行；不替您调用任何写接口）',

  // 工单草稿模板：title/desc/priority/actions 由调用方填
  ticketDraft: (o) => {
    const lines = [
      `【建议工单草稿】`,
      `标题：${o.title || '未命名'}`,
      `来源：副驾基于 ${o.source || '实时引擎'} 自动生成（待工程师确认）`,
      `优先级：${o.priority || '中'}`,
      `关联对象：${o.target || '-'}`,
      `根因推测：${o.cause || '-'}`,
      `处置建议：${o.action || '-'}`,
      `建议动作：`,
      ...(o.actions && o.actions.length ? o.actions.map(a => `  · ${a}`) : ['  · (待补充)']),
      `— 本草稿由 AI 副驾生成，未实际派单/写库 —`,
    ];
    return lines.join('\n');
  },

  // 整体健康诊断分级
  healthRank: (items) => items
    .slice()
    .sort((a, b) => (b.weight || 0) - (a.weight || 0)),
};

module.exports = { PLATFORM, SCENARIOS, MENU, TUTOR, LAB_EXPERIMENTS, COPILOT, ROOTCAUSE };
