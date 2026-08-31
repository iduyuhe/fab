// ============================================================
//  tenant/index.js — L4 多租户装配器（§L4）
//  initTenant({storage}) 返回多租户能力集合。
//  设计要点：
//   - 仅在 MULTI_TENANT=1 时激活 tenant 隔离语义；
//     默认（未设）完全等价单租户，零影响。
//   - 不修改 eventbus：tenant 由调用方在 ev 中显式带 tenant 字段，
//     或用 withTenant 包裹业务逻辑后由调用方读取 currentTenant() 附带。
//   - 提供 listTenants() stub，从 env/配置读取（演进：接配置中心）。
// ============================================================
const { getTenant, withTenant, currentTenant, DEFAULT_TENANT } = require('./context');

// 是否启用多租户隔离
const MULTI_TENANT = process.env.MULTI_TENANT === '1' || process.env.MULTI_TENANT === 'true';

/**
 * 多租户装配。
 * @param {object} opts
 * @param {object} [opts.storage]  存储实例（预留：演进时注入行级过滤）
 * @returns {object} tenant API
 */
function initTenant({ storage } = {}) {
  // 注册租户清单（stub）：从 FAB_TENANTS 逗号分隔 env 读取，缺省仅 default
  const configured = (process.env.FAB_TENANTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const tenants = Array.from(new Set([DEFAULT_TENANT, ...configured]));

  return {
    enabled: MULTI_TENANT,
    defaultTenant: DEFAULT_TENANT,
    storage,

    // 上下文透传（透传自 context.js，保持单一实现）
    getTenant,
    withTenant,
    currentTenant,

    /**
     * 在 emitEv 调用处包裹：多租户下从事件中显式携带的 tenant 提取并附到 ev.tenant。
     * 提取源（见 context.js getTenant）：ev.tenant / ev.meta.tenant / ev.headers['x-tenant-id']，
     * 缺省回退 DEFAULT_TENANT。单租户下原样返回，不新增字段。
     * 用法：bus.emitEv(tenant.attachToEv({type, tenant:'fabA', ...}))
     */
    attachToEv(ev) {
      if (!ev || typeof ev !== 'object') return ev;
      if (!MULTI_TENANT) return ev;            // 单租户：原样返回（不新增字段）
      // 多租户：事件级 tenant 透传。getTenant 优先读 ev.tenant/ev.meta.tenant/header，缺省 default。
      // 与 MULTITENANT.md §3 一致：调用方构造 ev 时显式带 tenant 字段即可透传，无需 withTenant 包裹。
      ev.tenant = getTenant(ev);
      return ev;
    },

    /**
     * listTenants stub：返回已配置租户列表。
     * 演进：接 DB/配置中心，支持动态租户开通、配额、状态。
     */
    listTenants() {
      return tenants.map(id => ({
        id,
        isDefault: id === DEFAULT_TENANT,
        active: true,
      }));
    },
  };
}

module.exports = { initTenant, MULTI_TENANT, DEFAULT_TENANT };
