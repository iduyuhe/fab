// ============================================================
//  集成装配器（L4 工厂级 · MES/ERP 集成统一入口）
//  ------------------------------------------------------------
//  按 env 实例化 MES / ERP 适配器，对外提供单例访问。
//
//  env 切换开关：
//    MES_MODE   demo(默认) | sap | real   —— 见 integrations/mes-adapter.js
//    ERP_MODE   demo(默认) | sap | yonyou  —— 见 integrations/erp-adapter.js
//
//  默认（MES_MODE / ERP_MODE 未设或 =demo）：
//    返回指向本地进程的适配器（server.js :8124 / fab-erp.js :8126），
//    平台行为与原始演示版完全一致（零退化）。
//
//  设计范式复用 L3 设备适配层（adapters/index.js）：适配层 + env 切换 + 默认 demo。
//  本模块不启动任何连接/定时器；连接器实例化由各自适配器内部惰性处理（真实模式仅读配置不连）。
// ============================================================
//  ⚠️ 蓝图态(BLUEPRINT)：L4 集成/适配器装配骨架。当前"数字主线 spine"不经过此路径（默认 demo、未被主进程 require 接活），仅作架构占位与真实对接预留；按"串主轴不推翻"策略保持蓝图态，不强行接线，避免引入未验证副作用。
'use strict';

const { MesAdapter } = require('./mes-adapter');
const { ErpAdapter } = require('./erp-adapter');

let _mes = null;
let _erp = null;

/**
 * 初始化集成适配器（按 env 装配）。幂等：重复调用不重建。
 * @param {object} config  可选覆盖 { mesMode, erpMode }
 * @returns {object} { mesMode, erpMode, started:[], note }
 */
function initIntegrations({ config = {} } = {}) {
  const mesMode = (config.mesMode || process.env.MES_MODE || 'demo').toLowerCase();
  const erpMode = (config.erpMode || process.env.ERP_MODE || 'demo').toLowerCase();

  _mes = new MesAdapter({ mode: mesMode });
  _erp = new ErpAdapter({ mode: erpMode });

  const note = (mesMode === 'demo' && erpMode === 'demo')
    ? 'demo 模式：适配器指向本地 MES(:8124)/ERP(:8126)，演示闭环零影响'
    : `已装配适配器：MES=${mesMode}, ERP=${erpMode}（真实模式仅读 env 配置，未建立连接）`;

  return { mesMode, erpMode, started: ['mes', 'erp'], note };
}

function getMesAdapter() {
  if (!_mes) _mes = new MesAdapter({ mode: process.env.MES_MODE || 'demo' });
  return _mes;
}

function getErpAdapter() {
  if (!_erp) _erp = new ErpAdapter({ mode: process.env.ERP_MODE || 'demo' });
  return _erp;
}

module.exports = { initIntegrations, getMesAdapter, getErpAdapter, MesAdapter, ErpAdapter };
