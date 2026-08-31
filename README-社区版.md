# 晶圆厂 AI 原生的智能制造平台 · L1 社区级

> 纯粹 AI 原生的智能制造平台：事件驱动主线 + 三级数字孪生 + 五引擎 + 原生 ERP。平台不依赖、不受制于任何第三方商业套装，外部系统仅作为可选接入。

## 项目简介

**晶圆厂 AI 原生的智能制造平台** 是一个已落地的 AI 芯片晶圆厂智能制造平台（社区演示版 / L1），模拟一座先进制程（N2 2nm / A16 AI 芯片）晶圆厂的端到端运营。平台以 **AI 原生闭环**为主轴——**五大引擎（SPC/FDC/PdM/VM/APS）+ APC + Agent 实时编排**是平台自己的核心能力，不依赖任何外部商业软件；外部系统仅作可对接的下游/上游可选通道。平台以**事件驱动**为主线，构建**三级数字孪生**（设备级 / 产线级 / 全厂级），支持 **what-if 仿真**与对话式副驾。

## L1 社区级定位

| 级别 | 范围 | 本包 |
|------|------|------|
| L1 社区级 | 零外部依赖、单命令拉起、本地演示沙盘 | ✅ 本仓库 |
| L2 企业级 | 多节点、高可用、持久化集群 | — |
| L3 云原生 | 弹性伸缩、云厂商集成 | — |

L1 仅用 Node 22 + `ws` 一个运行时依赖，数据库（MES/ERP）启动时自动建表，无需任何外部服务（无 Redis / 无 MQ / 无独立数据库）。

## 技术架构（文字图）

```
                          ┌─────────────────────────────┐
   浏览器 ───────────────▶│  门户 portal.js  :8123       │
   (console/twin/sim)     │  静态托管 + 前端直连 8124 WS │
                          └──────────────┬──────────────┘
                                         │ 订阅 ws://MES:8124
                          ┌──────────────▼──────────────┐
                          │  MES server.js   :8124       │
                          │  REST /api/*                 │
                          │  WS 事件源 (唯一)            │
                          │  SECS/GEM :5000              │
                          │  三级孪生 + 五引擎 + APS     │
                          │  fab-mes.db (node:sqlite WAL)│
                          └──┬───────────┬────────┬──────┘
              WS 订阅        │           │        │ WS/HTTP
            ┌───────────────▼┐  ┌────────▼─────┐ ┌────▼──────┐ ┌────▼──────┐
            │ EAP  :8125     │  │ ERP  :8126    │ │ WMS :8128  │ │Agent :8127 │
            │ HSMS/SECS 设备 │  │ 工单/物料    │ │ 仓储实物  │ │ 五大引擎  │
            │ 驱动设备执行   │  │ /财务        │ │ /库位      │ │ 编排问答  │
            └────────────────┘  └─────────────┘ └───────────┘ └───────────┘
```
> 六进程常驻：门户(8123) / MES+HSMS(8124/5000) / EAP(8125) / ERP(8126) / Agent(8127) / WMS(8128)。MES 为唯一 WS 事件源，其余进程均为订阅方。
>
> **P0 安全访问（已启用）：** 门户 :8123 已加基础鉴权——未登录访问页面会 302 跳登录页、未登录调用 `/api/*` 返回 401、WS 隧道亦校验登录态。默认管理员 `admin / admin123`，生产请设环境变量 `FAB_AUTH_USER` / `FAB_AUTH_PASS` / `FAB_AUTH_SECRET`。登录端点：`POST /api/auth/login`、`/api/auth/logout`、`/api/auth/me`。

**WS 唯一事件源在 MES(:8124)**，门户与 ERP 均为订阅方，通过 `MES_WS` / `MES_HTTP` 指向 MES。

## 一键启动

### 方式 A：Docker（推荐，零本地依赖）

```bash
docker compose up --build
```

### 方式 B：本地 Node（需 Node 22 + 项目中已含 ws）

```bash
bash bin/start-community.sh
```

进程后台运行，日志在 `logs/`，停止用输出中的 `kill` 命令。

### 端口与环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 8124 | MES 主进程端口（唯一 WS 源） |
| `PORTAL_PORT` | 8123 | 门户静态进程端口 |
| `EAP_PORT` | 8125 | EAP 协议网关端口（HSMS/SECS 设备通信） |
| `ERP_PORT` | 8126 | ERP 进程端口 |
| `AGENT_PORT` | 8127 | Agent 对话式编排器端口 |
| `WMS_PORT` | 8128 | WMS 仓储执行域端口 |
| `HSMS_PORT` | 5000 | SECS/GEM HSMS 端口（内嵌于 MES） |
| `MES_WS` | ws://127.0.0.1:8124 | 消费方订阅的 WS 地址 |
| `MES_HTTP` | http://127.0.0.1:8124 | 消费方轮询的 HTTP 地址 |

Docker / 脚本均自动透传上述变量；如需改端口，启动前 `export PORT=9000` 等即可。

## 访问地址

- **门户首页**：http://localhost:8123
  - 控制台 `console.html`、EAP 控制台 `eap-console.html`、ERP 操作台 `erp-ops.html`、WMS 仓储 `wms-ops.html`、主数据配置台 `config-admin.html`
  - 2D 孪生 `twin.html`/`line-twin.html`/`fab-twin.html`、3D 物理工厂 `twin3d/`、角色工作台 `twin3d/portal.html`、仿真 `sim.html`、实验台 `lab.html`、AI 助手 `agent.html`、NPI 流片 `npi-ops.html`
- **MES API**：http://localhost:8124/api/*
- **EAP**：http://localhost:8125
- **ERP**：http://localhost:8126
- **Agent**：http://localhost:8127/api/agent/chat
- **WMS**：http://localhost:8128

## 内置默认场景

- **N2 2nm 工艺**：先进逻辑制程演示
- **A16 AI 芯片工艺**：面向 AI 加速器的晶圆流片场景

## 功能清单

- 三级数字孪生：设备级 / 产线级 / 全厂级（fab-twin）+ 3D 物理工厂（Three.js）
- 五引擎：SPC（统计过程控制）、FDC（故障检测分类）、PdM（预测性维护）、VM（虚拟量测）、APS（高级排程）
- EAP 真实驱动设备执行（HSMS/SECS :5000，START/ABORT/STOP 下发，lotDone 由 EAP 闭环）
- 原生 ERP：工单 / 批次 / 物料 / 财务，经 WS + 轮询与 MES 协同
- WMS 仓储执行域（:8128）：库位 / 批次 / 上架规则 / 齐套 / 收发流水，与 ERP 同源派生
- APC 执行级闭环：VM 预测 → APC 偏移补偿 → S2F41 SET_PARAM 回灌设备（APC_ENABLED=1）
- Agent 编排器（:8127）：订阅 MES 事件总线，串 FDC/SPC/APC/VM/APS 五大引擎 + OTD 主轴实时问答
- what-if 仿真：工艺与排程推演
- 对话助手入口：自然语言查询产线状态与指标
- SECS/GEM 设备通信接口（:5000）
- NPI 设计→流片主线：设计档案（designs）/ 光罩（photomasks）/ 工程批 / 流片批，沿同一 MES 主轴推进（`npi-ops.html` + `/api/designs`·`/api/masks`·`/api/npi/launch`）

> **战略定位（2026-08-29 校准）：** 平台主轴是<b>纯粹 AI 原生</b>闭环（五引擎 + APC + Agent），<b>不依赖、不受制于任何第三方商业套装软件</b>；外部系统最多是<b>可选接口</b>、<b>不作为主流</b>——原生闭环成熟即自然替代。
>
> 蓝图态（诚实标注，非缺陷 / 可做、不等商务）：多租户行级隔离（若定位多客户 SaaS 则激活）、真实外部系统对接（P1 做"通用可对接 demo"，不绑定厂商）、OPC-UA/EDA/ISA-95 适配器当前为 demo stub 接入主轴（ADAPTER_MODE 切换）、全量 SCADA 对接、移动端响应式 PWA。上述为"挂枝/蓝图"，不伪装为已生产化。<b>另：P0 基础鉴权已上线，门户访问需登录。</b>

## 贡献指引

1. Fork 本仓库
2. 仅可在 `bin/`、`Dockerfile`、`.dockerignore`、`docker-compose.yml`、`README*` 等打包/文档层改动
3. **请勿修改业务代码**：`server.js` / `portal.js` / `fab-erp.js` / `aps.js` / `core.js`
4. 提交 PR 描述你的部署/打包改进

## License

MIT（占位）。© 数智晶圆厂平台 社区版。
