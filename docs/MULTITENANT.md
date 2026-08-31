# L4 多租户隔离设计（MULTITENANT）

> 数智晶圆厂平台 · L4 工厂级（工厂操作系统 / 多 fab / 多客户）
> 目标：平台可作为工厂操作系统服务于多个 fab/客户，数据/配置/事件按 tenant 隔离。
> 红线：绝不破坏 L1→L3 现有单租户演示功能；默认 `MULTI_TENANT` 未设时行为与原版完全一致。

## 1. 隔离维度

| 维度 | 隔离方式 | 现状 / 演进 |
|------|----------|------------|
| 数据 | 行级 `tenant` 标记 + 查询过滤（推荐起步） | 事件表优先加 `tenant` 列；后续扩到 lots/wos/metrology |
| 配置 | 每租户拓扑/路由覆盖，缺省用全局默认 | `config/topo.js` 作为默认源，租户可 overlay |
| 事件 | `ev.tenant` 可选字段，WS 订阅按 tenant 过滤 | emitEv 出口不变，仅新增可选字段 |
| UI | 前端按 `x-tenant-id` 切换上下文 | 不在本期强制，预留 header 约定 |

## 2. tenant 上下文透传机制

- 模块：`tenant/context.js`，基于 Node 原生 `async_hooks.AsyncLocalStorage`（零新依赖）。
- `getTenant(ctx)`：从 `x-tenant-id` 头 / `ctx.tenant` / `ctx.meta.tenant` 提取，缺省 `'default'`。
- `withTenant(id, fn)`：在 fn 及其全部 await 链路内绑定 tenant。
- `currentTenant()`：取当前上下文 tenant，无包裹时返回 `'default'`。
- 装配器：`tenant/index.js` 的 `initTenant({storage})` 暴露上述 API + `attachToEv` + `listTenants()`。

## 3. 事件 tenant 附载策略（不修改 eventbus）

为规避循环依赖与任何退化风险，**本期不修改 `services/eventbus.js`**：

- 调用方在构造 `ev` 时显式带 `tenant` 字段（推荐，清晰可追溯）；
- 或用 `withTenant` 包裹业务逻辑后，经 `initTenant().attachToEv(ev)` 自动补 `currentTenant()`
  （仅 `MULTI_TENANT=1` 且 ev 未带 tenant 时生效，单租户原样返回）。

`emitEv` 仍保持事件唯一出口（WS 源唯一 :8124，CONTRACT 未破坏）。`ev.tenant` 为新增可选字段，不删除/重命名任何现有字段。

## 4. 存储隔离策略

推荐 **行级 tenant 标记 + 查询过滤**（起步成本最低、兼容现有单库演示）：

- 在 `events` 表加 `tenant TEXT DEFAULT 'default'`，`enqueueEvent` 落库时写入 `currentTenant()`；
- `queryEvents` 注入 `AND tenant=?`，单租户下 tenant='default' 不影响结果；
- 演进路线三选一：
  1. **行级列（当前）**：单库多租户，最简单，隔离靠应用层过滤；
  2. **独立 schema**：同库按 `tenant_xxx.*` 分 schema，DB 级隔离增强；
  3. **独立库**：每租户独立 DB 文件/连接，最强隔离，运维成本最高。
- 切换点集中在 `storage/` 抽象层，业务代码无感。

## 5. 默认单租户兼容

- `MULTI_TENANT` 未设 → 所有行为与原版完全一致；`ev.tenant` 为 `undefined`，
  查询不加 tenant 条件，前端无感知。
- `DEFAULT_TENANT`（默认 `'default'`）保证无上下文时回退安全值。

## 6. 环境变量配置

| 变量 | 说明 | 默认 |
|------|------|------|
| `MULTI_TENANT` | `1`/`true` 启用多租户隔离，`其他/未设`为单租户 | 未设（单租户） |
| `DEFAULT_TENANT` | 缺省租户 ID | `default` |
| `FAB_TENANTS` | 已知租户清单（逗号分隔），供 `listTenants()` stub | 空（仅 default） |

## 7. 生效与验证

- 静态检查：`node --check tenant/context.js tenant/index.js`
- 加载检查：`node -e "require('./tenant/context.js');require('./tenant/index.js')"`
- 默认模式下 `listTenants()` 返回 `[{id:'default',isDefault:true,active:true}]`，不强制 tenant。

## 8. 不在本期范围

- 不改动 `server.js / portal.js / fab-erp.js / aps.js / core.js / agent/` 业务逻辑。
- 不引入未安装重型包（AsyncLocalStorage 为 Node 原生）。
- 租户级认证/配额/计费、动态开通为后续演进项。
