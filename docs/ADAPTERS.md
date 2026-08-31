# 数智晶圆厂平台 · 设备接入专业版（L3 适配器层）

> 本文档说明 L3 专业级的产线级设备接入标准适配层：OPC-UA 客户端 + EDA(E4/E5/E37) 事件订阅。
> 目标：把数据源从「演示注入」升级为「标准协议接入」，让孪生/引擎具备专业级协议语义；
> **同时不破坏现有演示闭环**（默认 `ADAPTER_MODE=demo`，server.js 演示逻辑不变）。

---

## 1. 标准协议简介

### 1.1 OPC-UA（OPC Unified Architecture）
- 工业自动化跨平台、安全、面向服务的通信标准（IEC 62541）。
- 设备/PLC/SCADA 暴露 **AddressSpace（节点树）**，客户端订阅 `NodeId` 的数据（`DataValue` = value + quality + sourceTimestamp）。
- 本平台用其承载 **机台状态（Status）** 与 **量测/性能变量（Process/Performance Data）** 的实时采集。

### 1.2 EDA（Equipment Data Acquisition，SEMI EDA）
- 基于 SECS/GEM 的「设备数据采集」标准族，偏**事件订阅**语义：
  - **E4**：SECS-II 消息数据项编码格式（SESF data items）。
  - **E5**：SECS-II 消息定义（Equipment Status / Process Data / Alarm / Trace 等 SESF）。
  - **E37**：HSMS（高速 SECS 消息服务）传输层 —— 传输由 `server.js` 的 `SecsGemGateway`（HSMS :5000）承担，本适配器偏 E4/E5 事件语义映射层。
- 本平台用其承载 **设备状态变化（S6F11 EquipState）**、**工艺数据（Process Data）**、**报警（S5F1）** 的订阅。

---

## 2. 适配器映射表（标准事件/数据 → 平台 ev_* 类型）

> 平台事件类型以 `docs/CONTRACT.md §1.2` 为唯一事实来源（**无 `ev_` 前缀**）。
> 适配器产出事件一律经注入的 `emitEv` 汇出，字段与契约完全一致，不得改名/删字段。

### 2.1 OPC-UA → 平台事件（`adapters/opcua-client.js`）

| OPC-UA 节点/语义 | DataValue 示例 | 平台事件 type | 映射字段（与契约一致） |
|---|---|---|---|
| `*.Status` 状态变化 | `{value:'RUNNING',quality:'Good'}` | `toolStatus` | `id, status(RUN/IDLE/PM/DOWN), src:'eap'` |
| `*.Util/.Wafers/.WPH` 性能采样 | `{value:78,quality:'Good'}` | `toolMetric` | `id, util / wafers / wph` |
| `*.MetroCD` 量测点 | `{value:18.3,quality:'Good'}` | `metrology` | `lot:null,product:null,tool,step:null,param,unit,value,target,usl,lsl,result` |

- OPC-UA 状态映射：`RUNNING→RUN, IDLE→IDLE, MAINTENANCE→PM, FAILURE→DOWN`（E10 语义对齐）。
- `quality !== 'Good'` 的坏质量点丢弃，不污染事件流。
- `toolStatus` 仅在状态变化时发出（边沿触发），`src:'eap'` 标识来自设备接入层。

### 2.2 EDA(E4/E5/E37) → 平台事件（`adapters/eda-client.js`）

| EDA 事件（stream） | 载荷示例 | 平台事件 type | 映射字段（与契约一致） |
|---|---|---|---|
| `EQUIP_STATUS`（S6F11 EquipState） | `{status:'EQP_RUN'}` | `toolStatus` | `id, status(RUN/IDLE/PM/DOWN), src:'eap'` |
| `PROCESS_DATA`（量测变量） | `{param:'CD',value:18.3,lsl,usl,target}` | `metrology` | `lot:null,product:null,tool,step:null,param,unit,value,target,usl,lsl,result` |
| `PROCESS_DATA`（性能变量） | `{metric:'util',value:78}` | `toolMetric` | `id, util` |
| `ALARM`（S5F1，设备/工艺故障） | `{code:'ALARM_EQUIP_FAULT'}` | `fdcAlarm` | `ts,tool,module,wph,avgWph,util` |
| `ALARM`（S5F1，工艺判异） | `{code:'ALARM_PROCESS_OOS'}` | `spcAlarm` | `product,param,tool,value,mean,ucl,lcl,rules` |

- EDA 状态映射：`EQP_RUN→RUN, EQP_IDLE→IDLE, EQP_PM→PM, EQP_DOWN→DOWN`。
- 报警映射：`ALARM_EQUIP_FAULT→fdcAlarm`（设备退化），`ALARM_PROCESS_OOS→spcAlarm`（对接 SPC 自动停线）。

### 2.3 事件类型清单（与现有平台一致，已核对 `server.js` emitEv 调用）
`toolStatus` `toolMetric` `amhs` `lotRelease` `lotStart` `lotStepDone` `lotDone` `lotHold` `toolHold` `toolRelease` `lotReleaseHold` `spcAlarm` `metrology` `vmPrediction` `vmResult` `fdcAlarm` `hello`
> 说明：任务初稿曾假设 `ev_*` 命名（如 `ev_down`/`ev_metro`），**与现有代码不符**；本适配器已按真实契约（`toolStatus`/`metrology` 等）实现。

---

## 3. 部署方式

### 3.1 作为库嵌入 MES 进程（推荐起步）
在 `server.js` 中 `emitEv/onEmit` 就绪后、演示逻辑**之后**可选挂载（不改变演示逻辑）：
```js
const { startAdapters } = require('./adapters');
// 默认 ADAPTER_MODE=demo 时直接返回，零影响；切 opcua/eda/all 才启动定时器
startAdapters({ emitEv, config: { opcuaInterval: 2000, edaInterval: 2500 } });
```

> **当前接活状态（2026-08-27）**：`server.js` 已在 `emitEv` 就绪后调用 `startAdapters({ emitEv })`；社区启动器 `bin/start-community.sh` 已默认 `ADAPTER_MODE=all`，即 OPC-UA + EDA 两个适配器在 **stub 模拟** 模式下实时运行、事件经 `emitEv` 汇入总线并联动 SPC/FDC/E10。可通过 `GET /api/adapters` 查看 `mode / started / stats`（stats 为各事件类型累计计数，证明适配器事件真正流入主轴）。真实协议接入（node-opcua 客户端 + EDA/HSMS 真实解析）仍为注释路径，需装依赖并接现场设备。

### 3.2 独立适配器进程（产线部署）
适配器通过 WS 客户端连 `ws://MES:8124`，把标准协议事件作为远端 `emitEv` 等价源推送（复用 `POST /api/ingest` 或新增适配器专用 ingest 端点）。此时 MES 仍保持唯一 WS 广播源（CONTRACT.md §2.3 红线），适配器只作为事件**生产方**经 `emitEv` 汇入。

---

## 4. 与演示模式的切换开关（env）

| env | 取值 | 行为 |
|---|---|---|
| `ADAPTER_MODE` | `demo`（默认） | 不启动任何真实协议适配器，保持现有 server.js 演示闭环 |
| `ADAPTER_MODE` | `opcua` | 启动 OPC-UA 适配器（默认 stub 模拟 server） |
| `ADAPTER_MODE` | `eda` | 启动 EDA(E4/E5/E37) 适配器（默认 stub 模拟事件流） |
| `ADAPTER_MODE` | `all` | 同时启动 opcua + eda |
| `OPCUA_REAL` | `1` | 切真实 OPC-UA 路径（需 `npm i node-opcua`，未默认安装则回退 stub） |
| `EDA_REAL` | `1` | 切真实 EDA/HSMS 路径（需 HSMS 会话，未接则回退 stub） |

### 4.1 真实依赖（默认不安装，按需）
```bash
# 真实 OPC-UA 接入
npm i node-opcua
# 真实 EDA/HSMS：可复用 server.js 的 SecsGemGateway（已含 HSMS :5000），无需额外重包
```
真实路径代码已在 `adapters/*.js` 中以注释形式给出，默认走 `stub` 模式。

---

## 5. 契约红线遵守
1. 适配器产出事件**一律经 `emitEv`** 汇出，不绕开、不直 broadcast / 直写 events 表（CONTRACT.md §8.1）。
2. 事件字段与 `CONTRACT.md §1.2` 完全一致，**未改名/未删字段**；`lotRelease`/`lotDone` 等 ERP 依赖字段冻结（§8.2）。
3. WS 事件源仅 8124 一个；适配器不论以库还是独立进程形态接入，都只作为 emitEv 的生产方，不新建 WS 源（§8.3）。
4. 默认 `demo` 模式不接管事件、不启动定时器，**server.js / portal.js / fab-erp.js / agent/ 业务逻辑零改动**。

---

## 6. 新增文件清单
- `adapters/opcua-client.js`：OPC-UA 客户端适配骨架（stub + 真实路径注释）。
- `adapters/eda-client.js`：EDA(E4/E5/E37) 事件订阅适配骨架（stub + 真实路径注释）。
- `adapters/index.js`：适配器装配器 `startAdapters({emitEv, config})`，按 `ADAPTER_MODE` 启动。
- `docs/ADAPTERS.md`：本说明文档。
