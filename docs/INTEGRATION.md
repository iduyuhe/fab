# 数智晶圆厂平台 · L4 工厂级集成设计（MES/ERP 对接适配层）

> 文档定位：L4 工厂级集成标准。描述如何将现有演示版 `server.js`(:8124) 与 `fab-erp.js`(:8126)
> 包装为标准集成适配器，并给出对接真实 MES（SAP ME / 用友 MES / 真实产线 MES）与 ERP
> （SAP S/4HANA / 用友 U9）的接口映射、env 切换开关，以及与现有演示的兼容性约束。
> 所有内容基于代码实地核对（`server.js` / `fab-erp.js` / `adapters/` / `docs/CONTRACT.md`）。

---

## 1. 目标与原则

- **零退化**：默认 `MES_MODE` / `ERP_MODE` 未设或 =`demo` 时，平台行为与原演示版完全一致
  （本地 `server.js` :8124 + `fab-erp.js` :8126）。
- **适配层 + env 切换 + 默认 demo**：沿用 L3 设备接入适配层（`adapters/index.js` +
  `opcua-client.js` + `eda-client.js`）的成熟范式——适配器只做映射与配置，不接管业务。
- **不新造事件**：适配器把真实系统事件翻译为平台 **已有** canonical 事件（CONTRACT.md §1.2），
  绝不新增 `type`。
- **不引入重型依赖**：真实模式仅读取 env 连接配置（URL/Token），不实际建立连接，
  避免引入 `node-opcua` / SAP SDK / 用友 SDK 等未安装包。

---

## 2. MES 对接标准

### 2.1 端点映射（REST + 事件）

| 场景 | demo（默认） | real/sap（env 指向） |
|---|---|---|
| REST base | `http://127.0.0.1:8124` | `MES_REAL_URL` |
| 事件订阅(WS 唯一源) | `ws://127.0.0.1:8124` | `MES_REAL_WS` |
| 健康检查 | `GET /api/health` | `GET {url}/health` |
| 工单/批次 | `GET /api/wos`、`GET /api/lots`、`GET /api/lots/:id` | 语义等价端点（对接实现填充） |
| 设备/拓扑 | `GET /api/tools`、`GET /api/topo`、`GET /api/meta` | 语义等价 |
| 智能引擎 | `GET /api/spc|metrology|fdc|vm|pdm|aps` | 语义等价（拉取用） |

> WS 事件源唯一性（CONTRACT §8-3）：无论 demo 还是真实，事件流只来自一个 MES 源，
> 门户/ERP/APS 只做订阅方，不成为新源。

### 2.2 canonical 事件映射（MesAdapter.translateToCanonical）

真实 MES 事件字段各异，适配器翻译为以下平台 canonical 事件（字段严格同 CONTRACT §1.2）：

| 真实 MES 事件(示意 type) | → 平台 canonical 事件 | 关键字段映射 |
|---|---|---|
| `ToolStatus` / `EquipStatus` | `toolStatus` | `{id, status:RUN/IDLE/PM/DOWN, src:'mes'}`（状态词表归一） |
| `LotRelease` | `lotRelease` | `{lot, wo, mod}`（**无 product**，ERP 经 wo 反查） |
| `LotStart` / `LotDispatch` | `lotStart` | `{lot, wo, mod, tool}` |
| `LotDone` / `LotComplete` | `lotDone` | `{lot, wo, product, cycleH}`（ERP 成本归集依据） |
| `Metrology` / `SpcSample` | `metrology` | `{lot,product,tool,step,param,unit,value,target,usl,lsl,result}` |
| `EquipFault` | `fdcAlarm` | `{ts,tool,module,wph,avgWph,util}` |

未识别事件直接丢弃（返回 `null`），不污染平台事件流。

### 2.3 env 切换开关（MES）

| env | 说明 | 默认 |
|---|---|---|
| `MES_MODE` | `demo` \| `sap` \| `real` | `demo` |
| `MES_REAL_URL` | 真实 MES REST 基址 | 空（demo 忽略） |
| `MES_REAL_WS` | 真实 MES 事件流地址(WS/MQ) | 空 |
| `MES_REAL_TOKEN` | 访问令牌 | 空 |
| `MES_REAL_IDOC` | SAP 专用 IDoc/WebService 端点 | 空 |

---

## 3. ERP 对接标准

### 3.1 端点映射

| 场景 | demo（默认） | real/sap/yonyou（env 指向） |
|---|---|---|
| REST base | `http://127.0.0.1:8126` | `ERP_REAL_URL` |
| 成本/库存 | `GET /api/erp/costs`、`GET /api/erp/inventory` | `GET {url}/costs`、`/inventory` |
| 上游 MES | `ws://127.0.0.1:8124` + `http://127.0.0.1:8124` | 由上游 MES 适配器决定 |

> ERP 联动机制（CONTRACT §2.3）：订阅 MES WS 事件流（`lotRelease`→领料、`lotDone`→成品入库+成本），
> 轮询 `GET /api/wos` 维护 `wo→product` 缓存。适配器不改动此机制，仅把上游地址抽象为可切换。

### 3.2 canonical 数据映射（ErpAdapter.mapErpData）

平台 canonical 数据模型（与 `fab-erp.js` 输出同构）：

- **costBatch**：`{ lot, product, matCost, laborCost, equipCost, totalCost, cycleH }`
  → 兼容 SAP BAPI / 用友 U9 字段（`materialCost`/`labor_cost`/`machineCost` 等自动对齐）。
- **inventory**：`{ value, materials:[{code,name,cat,unit,price,stock,safetyStock}] }`
  → 兼容 `materialCode`/`sku`/`onHand` 等异构字段名。

### 3.3 env 切换开关（ERP）

| env | 说明 | 默认 |
|---|---|---|
| `ERP_MODE` | `demo` \| `sap` \| `yonyou` | `demo` |
| `ERP_REAL_URL` | 真实 ERP REST 基址 | 空 |
| `ERP_REAL_TOKEN` | 访问令牌 | 空 |
| `ERP_REAL_APIKEY` | API Key（如用友 OpenAPI） | 空 |
| `ERP_REAL_TENANT` | 多租户标识（用友 U9） | 空 |

---

## 4. 集成装配器

`integrations/index.js` 提供统一入口：

```js
const { initIntegrations, getMesAdapter, getErpAdapter } = require('./integrations');

// 启动期装配（按 env）：MES_MODE / ERP_MODE（默认 demo）
initIntegrations({ config: {} });

const mes = getMesAdapter();   // MesAdapter 单例
const erp = getErpAdapter();   // ErpAdapter 单例

mes.getEndpoints();            // 当前 MES 端点映射（demo→本地 8124）
erp.getEndpoints();            // 当前 ERP 端点映射（demo→本地 8126）
mes.translateToCanonical(ev);  // 真实事件→canonical（仅翻译，不连）
erp.mapErpData(d, 'cost');     // 标准 ERP 数据→canonical
```

- 默认 demo：适配器指向本地进程，原演示闭环零影响。
- 真实模式：仅读取 env 配置，不建立连接（避免依赖）。需实际对接时，在适配器内补全连接实现。

---

## 5. 与现有演示的兼容性（默认 demo 零影响）

| 验证项 | demo 模式结果 |
|---|---|
| `getMesAdapter().getEndpoints().rest` | `http://127.0.0.1:8124`（= server.js） |
| `getErpAdapter().getEndpoints().rest` | `http://127.0.0.1:8126`（= fab-erp.js） |
| 现有 server.js / fab-erp.js / portal.js / agent | **未改动**，逻辑完全保留 |
| 事件流（emitEv 唯一出口） | 不受影响，适配器只读不写事件总线 |

约束（CONTRACT 红线）：适配器不新造事件、不绕开 `emitEv`、不改 server/fab-erp 业务逻辑。

---

## 6. 与 L3 设备适配层（adapters/）的关系

| 层 | 目录 | 模式 env | 职责 |
|---|---|---|---|
| L3 设备接入 | `adapters/{opcua-client,eda-client,index}.js` | `ADAPTER_MODE` | OPC-UA / EDA → emitEv（设备事件入总线） |
| L4 工厂级集成 | `integrations/{mes-adapter,erp-adapter,index}.js` | `MES_MODE` / `ERP_MODE` | 真实 MES/ERP → 端点映射 + canonical 翻译 |

二者同范式（适配层 + env 切换 + 默认 demo），职责互补：
- L3 解决「设备 → 平台事件总线」；
- L4 解决「平台 ↔ 企业级 MES/ERP 系统」的接口适配。
真实 MES 接入后，其事件经 `MesAdapter.translateToCanonical` 转为 canonical 后，
仍应统一经 `emitEv` 汇入总线（与 L3 适配器一致），确保单一事件出口。

---

## 7. 后续接入真机指引（不破坏当前）

1. 设 `MES_MODE=sap` 或 `real`，填 `MES_REAL_URL` / `MES_REAL_WS` / `MES_REAL_TOKEN`。
2. 在 `MesAdapter` 内补全连接实现（如需 SAP SDK / WS 客户端），并将收到的原始事件
   经 `translateToCanonical` 后经注入的 `emitEv` 汇出（保持总线唯一性）。
3. ERP 同理：设 `ERP_MODE=sap`/`yonyou`，填 `ERP_REAL_URL` 等，在 `ErpAdapter` 内
   拉取后通过 `mapErpData` 转为 canonical 供上层消费。
4. 所有新增真实事件 `type` 必须先在本表与 CONTRACT.md §1.2 登记，禁止隐式新造。
