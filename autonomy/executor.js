// ============================================================
//  L4 自治执行器 (executor.js)
//  经护栏(guard)校验 + 确认标志(confirmed)，调用真实 MES 写端点
//  （fetch POST MES_HTTP，与 chat-server 同地址）。
//  默认未确认直接拒绝并提示需 confirm；只接受白名单动作。
//  审计：若 /api/audit/log 存在则调，否则 console。
//  零 API 成本：仅本地 fetch，不调外部 LLM。
// ============================================================
'use strict';

const sg = require('./safeguard');

const MES_HTTP = process.env.MES_HTTP || 'http://127.0.0.1:8124';

// 审计出口：优先真实审计端点，回退 console（server.js 无 /api/audit/log）
async function audit(entry) {
  try {
    const r = await fetch(`${MES_HTTP}/api/audit/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    if (r.ok) return;
  } catch (_) { /* 审计端点不存在或不可达，回退 console */ }
  console.log('[autonomy-audit]', JSON.stringify(entry));
}

// 执行自治动作：经 guard + confirmed 校验后 POST 真实 MES 端点
async function executeAction({ action, payload, confirmed }) {
  // 1) 护栏：动作白名单 + 参数合法
  const g = sg.guard(action, payload);
  if (!g.ok) {
    const result = { ok: false, blocked: 'guard', reason: g.reason, action };
    await audit({ ts: Date.now(), kind: 'autonomy', decision: 'rejected', stage: 'guard', action, reason: g.reason });
    return result;
  }

  // 2) 人审闸门：白名单写动作必须 confirm（requireExplicitConsent 默认 true）
  if (sg.needsConfirm(action) && !confirmed) {
    const result = {
      ok: false,
      blocked: 'consent',
      reason: `动作 ${action} 需要人审确认。请回复"确认执行"以自动执行。`,
      action,
      endpoint: g.endpoint.path,
    };
    await audit({ ts: Date.now(), kind: 'autonomy', decision: 'rejected', stage: 'consent', action, reason: '未确认' });
    return result;
  }

  // 3) 调用真实 MES 写端点
  const { method, path, build } = g.endpoint;
  const body = build(payload || {});
  let res;
  try {
    const r = await fetch(`${MES_HTTP}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let res;
    try { res = await r.json(); } catch (_) { res = { __raw: await r.text() }; }
    const ok = r.ok;
    const result = { ok, action, endpoint: path, payload: body, response: res };
    await audit({ ts: Date.now(), kind: 'autonomy', decision: ok ? 'executed' : 'error', action, endpoint: path, payload: body, response: res });
    return result;
  } catch (e) {
    const result = { ok: false, blocked: 'network', reason: `调用 ${path} 失败：${e.message}`, action };
    await audit({ ts: Date.now(), kind: 'autonomy', decision: 'error', stage: 'network', action, endpoint: path, reason: e.message });
    return result;
  }
}

module.exports = { executeAction, audit, MES_HTTP };
