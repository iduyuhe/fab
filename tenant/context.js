// ============================================================
//  tenant/context.js — L4 多租户上下文透传（§L4）
//  职责：在请求/WS 生命周期内承载当前 tenant。
//  机制：Node 原生 async_hooks.AsyncLocalStorage，零新依赖。
//  默认兼容：未启用多租户时 tenant 恒为 'default'，对现有逻辑零影响。
// ============================================================
const { AsyncLocalStorage } = require('async_hooks');

// tenant 上下文存储（单例）
const tenantStore = new AsyncLocalStorage();

// 默认租户（可由 env DEFAULT_TENANT 覆盖）
const DEFAULT_TENANT = process.env.DEFAULT_TENANT || 'default';

/**
 * 从请求/WS 元数据/header 提取 tenant。
 * 支持：
 *   - ctx.headers['x-tenant-id']            （HTTP 请求头）
 *   - ctx.tenant                            （调用方已附带的元数据）
 *   - ctx.meta && ctx.meta.tenant           （WS 消息元数据包）
 *   - ctx.req && ctx.req.headers            （express/http 风格）
 * 提取不到时回退 DEFAULT_TENANT，绝不抛错。
 */
function getTenant(ctx) {
  if (ctx == null) return DEFAULT_TENANT;

  // 直接字段
  if (typeof ctx.tenant === 'string' && ctx.tenant) return ctx.tenant;

  // WS / 消息元数据包
  if (ctx.meta && typeof ctx.meta.tenant === 'string' && ctx.meta.tenant) {
    return ctx.meta.tenant;
  }

  // HTTP 头（含大小写兼容）
  const h = ctx.headers || (ctx.req && ctx.req.headers);
  if (h) {
    const t = h['x-tenant-id'] || h['X-Tenant-Id'];
    if (typeof t === 'string' && t) return t;
  }

  return DEFAULT_TENANT;
}

/**
 * 运行期将 tenant 绑定到当前异步上下文。
 * 在 fn 内（含其内所有 await 链路）调用 currentTenant() 均得到 id。
 * 返回值透传 fn 的执行结果。
 */
function withTenant(id, fn) {
  const tid = (typeof id === 'string' && id) ? id : DEFAULT_TENANT;
  return tenantStore.run(tid, fn);
}

/**
 * 取当前异步上下文的 tenant。
 * 未在 withTenant 包裹时返回 DEFAULT_TENANT（默认单租户）。
 */
function currentTenant() {
  const t = tenantStore.getStore();
  return (typeof t === 'string' && t) ? t : DEFAULT_TENANT;
}

module.exports = { tenantStore, DEFAULT_TENANT, getTenant, withTenant, currentTenant };
