# 数智晶圆厂平台 · L3 微服务化设计文档（拆分骨架蓝图）

> 文档状态：L3 骨架设计（装配蓝图；`services/index.js`/`bus-adapter.js`/`registry.js` 空壳已在整合期清理，现有 `services/erp-service.js`/`eventbus.js`/`wip.js` 为实际接活模块）
> 编写方：架构 Agent
> 兼容基线：本方案基于 `docs/CONTRACT.md` 已落地的阶段0 多进程骨架（WS 唯一源 :8124 / ERP :8126 / 门户 :8123）

> **整合状态（2026-08-23 更新）**：系统已完成整合——① `eap-host.js`(:8125) 已纳入默认启动编排；② 3D 数字孪生 `fab-digital-twin` 已并入 `fab-mes/twin3d/` 由门户(:8123)统一托管；③ ERP 支持 standalone 与 in-proc(`ERP_INPROC=1`) 双模；④ L4 模块(tenant/apc/adapters/integrations/audit) 已在 `server.js` 装配接活（部分默认 off/demo）；⑤ WMS 业务域本期未建（ERP 库存为财务台账，非仓储执行）。详情见 `系统集成诊断与整合蓝图.docx`。

---

## 0. 目标与约束

- **目标**：把单体 `server.js` 内联的 WIP/SPC/FDC/VM/PdM/APS 领域逻辑，从"演示内联"提升为"可独立部署的服务边界"，统一经 `eventbus` + 可插拔 MQ 通信，定义服务接口契约。
- **本次范围**：仅做**骨架与适配层**。不强制多容器部署，现有 8123/8124/8126/8127 仍按现状可运行。
- **红线（来自 CONTRACT.md §8）**：
  1. `emitEv` 是全局事件唯一出口，任何拆分不得绕开它直接 `broadcast` 或直写 `events` 表。
  2. ERP 依赖的 `lotRelease`/`lotDone`/ `/api/lots/:id` 字段**冻结**，禁止删除/重命名。
  3. WS 事件源仅 :8124 一个；门户/APS 只能订阅，不能成为新源。
  4. 不引入未安装的 npm 包（骨架占位，不 `require` 外部 MQ 客户端）。

---

## 1. 服务边界划分（Service Boundaries）

| 服务 | 进程现状 | 职责边界 | 引擎/实现 | 数据依赖 |
|---|---|---|---|---|
| **MES 网关服务** | server.js :8124 | REST `/api/*` + **唯一 WS 事件源** + SECS/GEM(:5000) 桥接 | 现有 | eventbus + storage |
| **WIP 服务** | 内联（蓝图：`services/index.js#createWipService`） | 工单/批次调度、派工规则、WIP 快照 | `WIPEngine`（已由 `services/wip.js` 抽出） | storage（wos/lots/lot_hist） |
| **SPC 服务** | 内联（蓝图：`createSpcService`） | 量测判异、自动停线、报警发布 | `SPC` | storage（spc_alarm）；消费 `metrology` |
| **FDC 服务** | 内联（蓝图：`createFdcService`） | 设备性能退化检测、报警发布 | 轻量 detector | 消费 `toolMetric` |
| **VM 服务（虚拟量测）** | 内联（蓝图：`createVmService`） | METRO 入场预测、实际量测对比、模型更新 | `VMPredictor` | 消费 `lotStart`(METRO)/`metrology` |
| **PdM 服务（预测性维护）** | 内联（蓝图：`createPdmService`） | 设备故障风险排行 | `PdMEngine` | 无状态，查询快照 |
| **APS 服务（产能计划）** | 内联/可选独立 :8125 | 产能计划、what-if 仿真（无状态实时算） | `APSEngine` | 查询快照 |
| **设备接入适配服务（EAP/SECS）** | `eap-host.js` :8125（**已纳入默认启动编排**） | HSMS 会话、远程指令、事件桥到 `emitEv` | 现有 | 仅发 `toolStatus`（src:'eap'）；EAP 定位为设备通信/状态通道，生产调度由 MES 引擎驱动 |
| **ERP 服务** | fab-erp.js :8126（独立进程）**或** server.js in-proc（`ERP_INPROC=1`）双模 | 物料/采购/销售/成本/应收应付 | 现有 | standalone：WS 订阅 8124（含断连重连补偿）；in-proc：经 eventbus 订阅 |
| **Agent 服务** | agent/chat-server.js :8127 | L1 对话 + L2 导师（只读消费 REST） | 现有 | HTTP 订阅 8124/8127 |
| **门户静态服务** | portal.js :8123 | 静态 HTML 托管 | 现有 | WS 只读订阅 8124 |

> 服务边界 = **事件订阅权 + 引擎持有权 + 存储访问权** 的清晰划分。蓝图将原本集中在 `server.js:101-217` 的装配逻辑按上表拆分，每个 `create*Service` 是一个可独立进程的单元。

---

## 2. 事件契约（Event Contract）

事件类型与 payload 以 `docs/CONTRACT.md §1.2` 为唯一权威（本次不新增事件类型，仅重新归属订阅方）。关键生产/消费映射：

| 事件 type | 主要生产方 | 消费服务（蓝图归属） |
|---|---|---|
| `lotRelease` / `lotStart` / `lotStepDone` / `lotDone` | WIP 服务 | ERP、VM(METRO)、量测生成、SECS 桥 |
| `metrology` | 量测服务（由 lotStepDone 触发） | SPC、VM |
| `spcAlarm` | SPC 服务 | WS（门户/孪生） |
| `vmPrediction` / `vmResult` | VM 服务 | WS |
| `toolMetric` | MES 网关(tick) | FDC 服务 |
| `fdcAlarm` | FDC 服务 | WS |
| `toolStatus` | WIP / tick / EAP 桥 | E10、SECS 桥、WS |
| `amhs` | MES 网关(tick) | WS |

**订阅装配方式**：`services/index.js` 调用 `eventbus.onEmit(fn)`，在每个服务工厂内定义 `onEvent(ev)` 按 `ev.type` 过滤处理；FDC 等需二次发布的，由统一订阅转交 `eventbus.emitEv(out)`，确保**唯一出口**不被破坏。

---

## 3. 服务间通信协议

### 3.1 进程内（现状，默认）
```
emitEv(ev) → broadcast(WS) + storage.enqueueEvent + subscribers(onEmit) + mqPublish(钩子, 默认 no-op)
```
所有服务在同一进程经 `eventbus.onEmit` 订阅，零延迟、零序列化开销。

### 3.2 跨进程（演进，可插拔）
经 `services/bus-adapter.js` 的 `attachBusAdapter(eventbus)`，将 `eventbus.registerMQ` 钩子接到外部 MQ：

- **发布**：`emitEv` 内 `mqPublish(ev)` 镜像发布到 MQ topic（如 `fab.events.<type>`），**不替代** WS/落库。
- **订阅**：各服务进程订阅自身关心的 topic，回灌到本地 `onEmit`（标记 `src:'mq'` 防环）。
- **适配器可插拔**：由 `MQ_TYPE` 选择 `nats` / `rabbitmq` / `redis` / `inproc`（默认）。
- 当 `MQ_TYPE` 未设或为 `inproc` 时，退化为进程内直连（与现状完全一致）。

> 详细连接配置与 env 见 §6。骨架仅定义接口形态（`publish` / `subscribe`），**不实际 connect**、不 `require` 未安装包。

---

## 4. 部署拓扑

### 4.1 现状（单容器多进程）
```
                 ┌─────────────────────────────────────┐
  浏览器/孪生 ───►│ portal :8123 (静态)                 │
                 │ MES :8124 (WS源+REST+引擎+EAP桥)    │
                 │ ERP :8126 (独立进程；或 in-proc 双模) │
                 │ Agent :8127 (已独立)                │
                 │ 进程内：WIP/SPC/FDC/VM/PdM/APS 经    │
                 │        eventbus.onEmit 装配         │
                 └─────────────────────────────────────┘
                 设备 SECS/GEM :5000 (MES 内)
```

### 4.2 演进路径（多容器）
1. **阶段 A（本次）**：新增 `services/index.js` 装配蓝图 + `bus-adapter` + `registry`。server.js 业务不变，可选渐进调用装配器。
2. **阶段 B**：将各 `create*Service` 提升为独立 Node 进程，经 `MQ_TYPE=nats` 互联；WS 源仍仅保留在 MES 网关(:8124)。
3. **阶段 C**：引入 `services/registry.js` 的 env 地址覆盖，配合容器编排（K8s / docker-compose）做服务发现与健康探针。
4. **阶段 D（产线对接）**：EAP/SECS 服务独立部署，连接真实设备 HSMS；ERP/Agent 保持独立；存储切换 Postgres（接口已在 `storage/` 预留）。

> 关键不变式：**WS 事件源始终唯一（8124）**；跨进程服务只能订阅，不能成为新源。

---

## 5. 渐进切换指南（server.js → 蓝图）

在 `server.js` 中：
```js
// 现：内联 const pdm=new PdMEngine(); const vm=new VMPredictor(); ... onEmit(ev=>{...})
// 改（可选，渐进）：
const { assembleServices } = require('./services');
const { services, adapter } = assembleServices({ storage, eventbus, context: { byId, tools } });
// REST 路由改调 services.wip.engine / services.aps.engine 等
// 删除 server.js 内联引擎实例化与 onEmit 订阅块
```
切换期间两版共存，server.js 行为不变（蓝图默认不强制接管）。`MQ_TYPE` 仍为 `inproc` 时与现状零差异。

---

## 6. 环境变量配置表（env）

| 变量 | 默认值 | 用途 | 消费方 |
|---|---|---|---|
| `MQ_TYPE` | `inproc` | MQ 适配器类型：`inproc`/`nats`/`rabbitmq`/`redis` | bus-adapter |
| `MQ_URL` | 见各适配器骨架 | MQ broker 连接串（nats:// / amqp:// / redis://） | bus-adapter |
| `SVC_<NAME>_HOST` | `localhost` | 服务发现：覆盖某服务 host | registry |
| `SVC_<NAME>_PORT` | 见 DEFAULTS | 服务发现：覆盖某服务 port | registry |
| `PORT` / `PORTAL_PORT` / `ERP_PORT` / `APS_PORT` | 8124/8123/8126/8125 | 各进程监听端口 | 各入口 |
| `MES_WS` / `MES_HTTP` | `ws://127.0.0.1:8124` / `http://127.0.0.1:8124` | 消费方指向 MES | ERP/Agent/门户 |

> `<NAME>` ∈ {mes,portal,erp,agent,wip,spc,fdc,pdm,vm,aps,eap}。当前单体演示阶段全部指向 localhost，未来多容器时由编排注入。

---

## 7. 文件清单（本次交付）

| 文件 | 职责 |
|---|---|
| `services/index.js` | 领域服务装配器 `assembleServices({storage,eventbus,context})`；持有 WIP/SPC/FDC/PdM/VM/APS 工厂；经 `eventbus.onEmit` 按类型分发；含渐进切换说明 |
| `services/bus-adapter.js` | MQ 可插拔适配层；基于 `eventbus.registerMQ` 钩子；默认 no-op，给出 NATS/RabbitMQ/Redis 骨架 + env 读取；不实际连接 |
| `services/registry.js` | 极简服务发现 stub；`getServiceAddr(name)` / `listServices()`；默认 localhost 映射，env 可覆盖 |
| `docs/MICROSERVICES.md` | 本设计文档 |

> 未改动：server.js / portal.js / fab-erp.js / aps.js / core.js / agent/ / eventbus.js —— 现有单体仍可独立运行。
