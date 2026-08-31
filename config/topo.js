// ============================================================
//  拓扑单一配置源（§4.4 / C5）：替代 server.js 与 aps.js 双份定义。
//  MES 与 APS 共用，避免重复定义漂移。
//  值与原 server.js:74-87 / aps.js:14-21 完全一致。
// ============================================================
const LINES = [
  { key: 'FAB-L1', name: '前道产线 L1 (Litho→Dep→Etch)', bays: ['BAY-1', 'BAY-2'] },
  { key: 'FAB-L2', name: '前道产线 L2 (Implant→CMP)',   bays: ['BAY-3', 'BAY-4'] },
  { key: 'FAB-L3', name: '量测/辅助产线 L3 (Metro)',     bays: ['BAY-5'] },
];
// 模块 → 所属产线/工段（按 MODULES 顺序与设备 uid 连续分配）
const MODULE_LINE = {
  LITHO: { line: 'FAB-L1', bay: 'BAY-1' },
  DEP:   { line: 'FAB-L1', bay: 'BAY-2' },
  ETCH:  { line: 'FAB-L1', bay: 'BAY-2' },
  IMPL:  { line: 'FAB-L2', bay: 'BAY-3' },
  CMP:   { line: 'FAB-L2', bay: 'BAY-4' },
  METRO: { line: 'FAB-L3', bay: 'BAY-5' },
};

module.exports = { LINES, MODULE_LINE };
