// ============================================================
//  L4 自治安全护栏 (safeguard.js)
//  设计原则：自治默认关闭（requireExplicitConsent=true），任何写操作必须
//  显式人审(confirm)。executor 只接受白名单动作，绝不绕过本护栏。
//  零 API 成本：纯规则校验，不调外部 LLM。
// ============================================================
'use strict';

// 自治默认策略：必须显式开启才能无人值守自动执行。
// 任何写操作在开启后仍需走 needsConfirm 的人审白名单。
const requireExplicitConsent = process.env.AUTONOMY_CONSENT !== '0'; // 默认 true

// 自治动作白名单（与 server.js 真实 POST 写端点一一对应）
//  - spc.inject   → POST /api/spc/inject   （注入量测点，触发判异/停线闭环）
//  - aps.sim      → POST /api/aps/sim       （what-if 情景推演）
//  - spc.release  → POST /api/spc/release   （释放停线/批次）
//  - wo.create    → POST /api/wos           （派工单写库）
// 注：/api/lots/:id/release 在 server.js 中不存在，不纳入白名单。
const ALLOWED_AUTO_ACTIONS = ['spc.inject', 'aps.sim', 'spc.release', 'wo.create'];

// 各动作对应的真实 MES 写端点与请求体构造器
const ACTION_ENDPOINTS = {
  'spc.inject':  { method: 'POST', path: '/api/spc/inject',  build: (p) => ({ product: p.product, param: p.param, tool: p.tool, lot: p.lot, value: p.value, source: p.source }) },
  'aps.sim':     { method: 'POST', path: '/api/aps/sim',     build: (p) => ({ downTools: p.downTools || [], extraWos: p.extraWos || [], horizon: p.horizon }) },
  'spc.release': { method: 'POST', path: '/api/spc/release', build: (p) => ({ tool: p.tool, lot: p.lot }) },
  'wo.create':   { method: 'POST', path: '/api/wos',         build: (p) => ({ qty: p.qty, product: p.product, dueHours: p.dueHours }) },
};

// 是否必须人审：白名单内的写动作默认都需要 confirm（红线性原则）。
function needsConfirm(action) {
  return ALLOWED_AUTO_ACTIONS.includes(action);
}

// 参数合法性基础校验（仅做格式/边界检查，不触及业务）
function validatePayload(action, payload) {
  const p = payload || {};
  switch (action) {
    case 'spc.inject':
      if (p.value == null) return 'spc.inject 需提供 value（量测值）';
      if (typeof p.value !== 'number' || !isFinite(p.value)) return 'spc.inject.value 必须是有限数值';
      break;
    case 'aps.sim':
      if (p.downTools != null && !Array.isArray(p.downTools)) return 'aps.sim.downTools 必须是数组';
      if (p.extraWos != null && !Array.isArray(p.extraWos)) return 'aps.sim.extraWos 必须是数组';
      if (p.horizon != null && (typeof p.horizon !== 'number' || p.horizon < 1 || p.horizon > 168)) return 'aps.sim.horizon 需在 1~168 小时';
      break;
    case 'spc.release':
      if (!p.tool && !p.lot) return 'spc.release 需提供 tool 或 lot';
      break;
    case 'wo.create':
      if (p.qty != null && (typeof p.qty !== 'number' || p.qty < 1 || p.qty > 20)) return 'wo.create.qty 需在 1~20';
      break;
  }
  return null;
}

// 护栏主校验：动作在白名单 + 参数合法
function guard(action, payload) {
  if (!action || typeof action !== 'string') return { ok: false, reason: 'action 缺失或非法' };
  if (!ALLOWED_AUTO_ACTIONS.includes(action)) return { ok: false, reason: `动作 ${action} 不在自治白名单（${ALLOWED_AUTO_ACTIONS.join(', ')}）` };
  const err = validatePayload(action, payload);
  if (err) return { ok: false, reason: err };
  return { ok: true, reason: '通过护栏', endpoint: ACTION_ENDPOINTS[action] };
}

module.exports = {
  ALLOWED_AUTO_ACTIONS,
  needsConfirm,
  guard,
  requireExplicitConsent,
  ACTION_ENDPOINTS,
};
