/**
 * SEMI 标准工艺库（脱敏教学版）
 * ---------------------------------------------------------------------------
 * ⚠️ 脱敏声明：本模块为「数智晶圆厂平台」L2 教学级配套参考资料。
 *   - 不含任何真实晶圆厂机密配方数值；所有数值均为「行业通用共识范围/教学示例」。
 *   - SEMI 标准代号仅引用公开标准族（E10/E30/E37/E87/C3/C5/MF/M1 等），只含公开含义。
 *   - 不接入真实设备，不改动任何业务代码。
 *   - 配套文档：docs/SEMI-RECIPES.md；配套课程：docs/COURSES.md。
 * ---------------------------------------------------------------------------
 * 结构：module.exports = { SEMI, MODULE_PROCESS }
 *   SEMI            —— 公开 SEMI 标准族索引
 *   MODULE_PROCESS  —— 六模块结构化工艺库（可 require 供导师 Agent 引用）
 */

const SEMI = {
  E10: { code: 'SEMI E10', desc: '设备可靠性/可用度/可维护性(RAM)状态模型', public: true },
  E30: { code: 'SEMI E30', desc: '通用设备模型(GEM)，设备-主机通信能力集合', public: true },
  E37: { code: 'SEMI E37', desc: 'HSMS 基于 TCP/IP 的 SECS 高速消息通信', public: true },
  E87: { code: 'SEMI E87', desc: '载具/物料运输管理(CMS)', public: true },
  E84: { code: 'SEMI E84', desc: '设备与装卸端口(EFEM/AGV)间的负载通信', public: true },
  C3:  { code: 'SEMI C3',  desc: '工艺气体纯度等级规范(公开族)', public: true },
  C5:  { code: 'SEMI C5',  desc: '大宗/特种气体兼容性规范(公开族)', public: true },
  C8:  { code: 'SEMI C8',  desc: '光刻胶相关材料兼容规范(公开族)', public: true },
  MF:  { code: 'SEMI MF',  desc: '半导体材料规范(靶材/前驱体等公开族)', public: true },
  M1:  { code: 'SEMI M1',  desc: '抛光硅单晶锭/硅片规范(公开族)', public: true },
  P1:  { code: 'SEMI P1',  desc: '安全与人体工学指南(公开族)', public: true },
  E142:{ code: 'SEMI E142',desc: '过程控制量测数据格式概念(公开族)', public: true },
};

// 典型窗口统一用 { min, max, unit, note } 表示「行业通用范围，教学示例」
const MODULE_PROCESS = {
  LITHO: {
    purpose: '将掩模图形转移到涂胶硅片，定义图形化层（CD 来源层）',
    semiStandards: [
      { code: 'SEMI E10', desc: '光刻机状态建模' },
      { code: 'SEMI E30', desc: 'EUV/ArF 与主机通信' },
      { code: 'SEMI P1', desc: '光刻胶/化学品安全' },
      { code: 'SEMI C8', desc: '光刻胶材料兼容(公开族)' },
    ],
    typicalWindow: {
      wavelength: { min: 13.5, max: 193, unit: 'nm', note: 'EUV≈13.5 / ArF≈193（浸没等效更短），教学示例' },
      resistThickness: { min: 30, max: 150, unit: 'nm', note: '依层而定，教学示例' },
      developTemp: { min: 20, max: 25, unit: '°C', note: '控温 ±0.x°C，教学示例' },
      overlayTarget: { min: 0, max: 0, unit: 'nm', note: '对准中心；容差依节点（2nm 量级个位数 nm），教学示例' },
    },
    keyParams: [
      { name: 'CD', target: 25, usl: 27.5, lsl: 22.5, unit: 'nm', note: '教学示例：目标 20–30nm 量级，USL/LSL ±10%' },
      { name: 'Overlay', target: 0, usl: 3, lsl: -3, unit: 'nm', note: '教学示例容差' },
    ],
    failureModes: ['CD 偏大/偏小', 'Overlay 偏移', '显影不均', '聚焦漂移'],
    spc: { monitor: 'CD / Overlay', entry: 'POST /api/spc/inject → GET /api/spc', experiment: 'A' },
  },

  ETCH: {
    purpose: '有选择去除未保护薄膜，将图形转移到下层',
    semiStandards: [
      { code: 'SEMI E10', desc: '刻蚀机状态模型' },
      { code: 'SEMI C3', desc: '刻蚀气体纯度(公开族)' },
      { code: 'SEMI C5', desc: '气体兼容性(公开族)' },
      { code: 'SEMI E30', desc: '配方加载与执行' },
    ],
    typicalWindow: {
      pressure: { min: 1, max: 100, unit: 'mTorr', note: '依 RIE/ICP 类型，教学示例' },
      rfPower: { min: 100, max: 2000, unit: 'W', note: '依设备与膜层，教学示例' },
      gasFlow: { min: 10, max: 500, unit: 'sccm', note: '依气体种类，教学示例' },
      selectivity: { min: 5, max: 50, unit: ':1', note: '对掩模/下层膜选择比，越高越好，教学示例' },
    },
    keyParams: [
      { name: 'Uniformity', target: 0, usl: 3, lsl: -3, unit: '%', note: '刻蚀均匀性容差，教学示例' },
      { name: 'Rate', target: 100, usl: 130, lsl: 70, unit: 'nm/min', note: '典型 10–500，教学示例' },
    ],
    failureModes: ['过刻/欠刻', '选择比不足', '侧壁角度异常', '颗粒'],
    spc: { monitor: '均匀性 / 速率趋势', entry: '概念映射到 /api/spc', experiment: null },
  },

  DEP: {
    purpose: '生长/沉积导电、绝缘或阻挡层薄膜',
    semiStandards: [
      { code: 'SEMI E10', desc: '沉积设备状态模型' },
      { code: 'SEMI MF', desc: '靶材/前驱体材料规范(公开族)' },
      { code: 'SEMI C3', desc: '沉积用气体纯度(公开族)' },
      { code: 'SEMI E30', desc: '多步配方/ALD 循环管理' },
    ],
    typicalWindow: {
      pvdTemp: { min: 20, max: 400, unit: '°C', note: 'PVD 基板温度，教学示例' },
      cvdTemp: { min: 300, max: 800, unit: '°C', note: 'CVD 温度，教学示例' },
      cvdPressure: { min: 0.1, max: 10, unit: 'Torr', note: 'CVD 压力，教学示例' },
      aldTemp: { min: 150, max: 400, unit: '°C', note: 'ALD 温度，教学示例' },
      aldCycles: { min: 20, max: 300, unit: 'cycles', note: '依膜厚，教学示例' },
    },
    keyParams: [
      { name: 'Thickness', target: 100, usl: 110, lsl: 90, unit: 'nm', note: '典型 5–500，教学示例' },
      { name: 'StepCoverage_ALD', target: 95, usl: 100, lsl: 80, unit: '%', note: '台阶覆盖率下限，教学示例' },
    ],
    failureModes: ['膜厚偏差', '孔洞/缝隙', '台阶覆盖不足', '颗粒'],
    spc: { monitor: '膜厚均值与西格玛', entry: '概念映射到 /api/spc', experiment: null },
  },

  CMP: {
    purpose: '全局平坦化，去除多余膜层提供平整表面',
    semiStandards: [
      { code: 'SEMI E10', desc: 'CMP 设备状态模型' },
      { code: 'SEMI MF', desc: '抛光垫/slurry 材料规范(公开族)' },
      { code: 'SEMI C3', desc: '清洗化学品兼容(公开族)' },
    ],
    typicalWindow: {
      headPressure: { min: 1, max: 5, unit: 'psi', note: '抛光头压力，教学示例' },
      rotation: { min: 30, max: 120, unit: 'rpm', note: '转盘/头转速，教学示例' },
      slurryFlow: { min: 100, max: 300, unit: 'mL/min', note: '浆料流量，教学示例' },
      removalRate: { min: 50, max: 500, unit: 'nm/min', note: '去除速率，教学示例' },
    },
    keyParams: [
      { name: 'Removal', target: 200, usl: 220, lsl: 180, unit: 'nm', note: '典型 50–500，教学示例' },
      { name: 'Dishing', target: 0, usl: 20, lsl: 0, unit: 'nm', note: '碟形上限，越小越好，教学示例' },
    ],
    failureModes: ['碟形', '侵蚀', '划伤', '厚度不均'],
    spc: { monitor: '去除均匀性趋势', entry: '概念映射到 /api/spc', experiment: null },
  },

  IMPL: {
    purpose: '将掺杂离子可控注入硅片，形成 PN 结与阈值调控',
    semiStandards: [
      { code: 'SEMI E10', desc: '注入机状态模型' },
      { code: 'SEMI E30', desc: '剂量/能量配方管理' },
      { code: 'SEMI C3', desc: '气源纯度(BF₃/PH₃ 族，高危安全)' },
    ],
    typicalWindow: {
      energy: { min: 1, max: 200, unit: 'keV', note: '依结深，教学示例' },
      dose: { min: 1e11, max: 1e16, unit: 'ions/cm²', note: '注入剂量范围，教学示例' },
      beamCurrent: { min: 0.1, max: 30, unit: 'mA', note: '束流，教学示例' },
      targetTemp: { min: 25, max: 400, unit: '°C', note: '靶温，教学示例' },
    },
    keyParams: [
      { name: 'Dose', target: 1e14, usl: 1.1e14, lsl: 0.9e14, unit: 'ions/cm²', note: '教学示例量级' },
      { name: 'Uniformity', target: 0, usl: 1.5, lsl: -1.5, unit: '%', note: '片内均匀性，教学示例' },
    ],
    failureModes: ['剂量偏差', '沟道效应', '颗粒污染'],
    spc: { monitor: '剂量与均匀性趋势', entry: '概念映射到 /api/spc', experiment: null },
  },

  METRO: {
    purpose: '测量 CD / Overlay / 膜厚 / 缺陷，输出 SPC 判异数据',
    semiStandards: [
      { code: 'SEMI E10', desc: '量测设备状态模型' },
      { code: 'SEMI E30', desc: '量测配方管理' },
      { code: 'SEMI E142', desc: '量测数据格式概念(公开族)' },
    ],
    typicalWindow: {
      precision: { min: 0.1, max: 1, unit: 'nm', note: '重复精度亚 nm 量级，依设备代际，教学示例' },
      sampling: { min: 1, max: 5, unit: 'wafers/lot', note: '每批抽样数，教学示例' },
    },
    keyParams: [
      { name: 'CD', target: 25, usl: 27.5, lsl: 22.5, unit: 'nm', note: '同 LITHO，教学示例' },
      { name: 'Overlay', target: 0, usl: 3, lsl: -3, unit: 'nm', note: '教学示例容差' },
    ],
    failureModes: ['量测噪声', '采样不足', '趋势漂移未捕获'],
    spc: { monitor: 'CD / OVL 控制图（核心入口）', entry: 'GET /api/spc 读取报警', experiment: 'A' },
  },
};

module.exports = { SEMI, MODULE_PROCESS };
