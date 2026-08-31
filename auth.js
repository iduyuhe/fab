// ============================================================
//  auth.js — 轻量会话鉴权（P0 信任门槛）
//  门户用其保护「页面 / /api/* / WS 隧道」；后端可复用 verify
//  做网关校验（P1 强化）。不依赖任何外部依赖，纯 Node crypto。
// ============================================================
const crypto = require('crypto');

const SECRET = process.env.FAB_AUTH_SECRET || 'fab-mes-dev-secret-change-me';
const USER = process.env.FAB_AUTH_USER || 'admin';
const PASS = process.env.FAB_AUTH_PASS || 'admin123';
const TTL = parseInt(process.env.FAB_AUTH_TTL || '86400', 10); // 默认 24h
const COOKIE = 'fab_sid';
// 门户→后端网关令牌（P0 仅注入、后端暂不强制；P1 起后端校验）
const GATEWAY = process.env.FAB_GATEWAY_TOKEN || 'fab-gw-local-2026';

function b64url(s) { return Buffer.from(s, 'utf8').toString('base64url'); }
function hmac(s) { return crypto.createHmac('sha256', SECRET).update(s).digest('base64url'); }

function createToken(user) {
  const exp = Date.now() + TTL * 1000;
  const body = b64url(JSON.stringify({ u: user, exp }));
  return `${body}.${hmac(body)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  let expected;
  try { expected = hmac(body); } catch { return null; }
  // 定长比较，防时序攻击
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p.exp || Date.now() > p.exp) return null;
    return p.u;
  } catch { return null; }
}

function cookieOpts() {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL}`;
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getUser(req) {
  const c = parseCookies(req);
  return verifyToken(c[COOKIE]);
}

module.exports = { USER, PASS, TTL, COOKIE, GATEWAY, createToken, verifyToken, cookieOpts, parseCookies, getUser };
