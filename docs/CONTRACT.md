# 数智晶圆厂平台 · 阶段0（地基加固）接口契约与架构设计

> 文档状态：阶段0 设计契约（仅设计，不改业务代码逻辑）
> 编写方：总架构 Agent
> 适用范围：EAP/MES 主进程、门户静态进程、APS 进程、ERP 进程之间的跨域接口
> 所有字段/端点/事件名均来自对现有代码的实地核对（`server.js` / `core.js` / `aps.js` / `fab-erp.js`）

---

## 当前落地进度（实施 Agent 记录，C1–C14）

> 已按契约完成单进程 → 多进程骨架 + 存储抽象 + 拓扑单源拆分，原功能零退化（C16 回归全绿）。

- [x] **C1** `storage/interface.js`：StorageAdapter 抽象基类 + §5.2 方法签名
- [x] **C2** `storage/sqlite.js`：平移 `db`/`PRAGMA`/所有 `CREATE TABLE`/`insXxx/updXxx/qXxx` prepared statement，SQL 原文等价
- [x] **C3** `storage/index.js`：`getStorage()` 工厂，默认 `sqlite`
- [x] **C4** `server.js`：删除裸 `db`/`stmt`，改用 `storage`；`emitEv` 落库、`flushEvts`、`insXxx/updXxx/qXxx` 全部经 `storage.*`
- [x] **C5** `config/topo.js`：导出 `LINES` / `MODULE_LINE`（值同原 server.js）
- [x] **C6** `server.js` + `aps.js`：移除内联定义，改 `require('./config/topo')`；`/api/topo` 与 `/api/aps` 输出数值不变
- [x] **C7** `services/eventbus.js`：封装 `emitEv`+`broadcast`+`wss`；`emitEv` 增可选 MQ 钩子（默认 no-op）
- [x] **C8** `server.js`：改用 `eventbus`，业务订阅经 `onEmit` 注册；SECS/E10/量测/VM/SPC/FDC 触发条件不变
- [x] **C9** `services/wip.js`：迁入 `WIPEngine` 实例化 + `persist`（绑定 `storage`），导出 `engine`/`persist`
- [x] **C10** `server.js`：经 `services/wip` 注入 `engine`
- [x] **C11** `portal.js`：HTTP `:8123` 仅 serve 静态 HTML（console/twin/line-twin/fab-twin/sim + `?src=mes`），无 WS 源
- [x] **C12** `server.js`：删除静态页分支，仅留 `/api/*` 与 WS 升级
- [x] **C13** `server.js`：启动日志更新（注明静态页在 8123，WS 唯一源在 8124）
- [x] **C14** `bin/start-all.sh`：编排 MES(8124)+门户(8123)+ERP(8126)
- [x] **C15** 本文档顶部进度表（本表）
- [x] **C16** 回归验证：8124/8123/8126 均监听；`/api/health|tools|topo|aps|spc|metrology` 200；ERP `mesConnected=true`；`/twin.html` 200；WS 收到 `hello`+实时事件

> 阶段0 未实现（契约列为可选，接口已预留）：NATS/Redis MQ、Postgres、独立 APS 进程(`aps-server.js`)、时序库 `timeseries.js`。

---

## 0. 现有架构事实速览（基于代码核对）

| 项 | 事实（来自代码） |
|---|---|
| MES 主进程 | `server.js`，默认端口 **8124**，单进程内聚合：REST API + WS 事件流 + SECS/GEM(HSMS :5000) + 静态页 + WIP 引擎 + SPC/FDC/VM/PdM |
| 事件总线 | 进程内函数 `emitEv(ev)`（`server.js:285`），职责：① WS `broadcast` ② 入队落库 `events` 表 ③ 内部订阅（E10 记录、量测生成、VM、SPC、FDC、SECS 推送） |
| WS 广播 | `wss = new WebSocketServer({noServer:true})`；`broadcast(ev)` 向所有 `readyState===1` 客户端 `JSON.stringify(ev)` 发送（`server.js:259-263`） |
| ERP 进程 | `fab-erp.js` 独立进程，端口 **8126**；通过 `WebSocket(MES_WS=ws://127.0.0.1:8124)` 订阅 MES 事件流；同时轮询 `GET /api/wos` 刷新 `wo→product` 缓存 |
| WMS 进程 | `fab-wms.js` 独立进程，端口 **8128**；通过 `WebSocket(MES_WS=ws://127.0.0.1:8124)` 订阅 MES 事件流（lotRelease 实物拣货+齐套、lotDone 成品上架）；与 ERP 同源于 MES 真相源、域隔离（独立库 `fab-wms.db`） |
| 存储 | `node:sqlite` + WAL；MES 库 `fab-mes.db`，ERP 库 `fab-erp.db`（两库物理隔离） |
| 拓扑数据 | 进程内常量 `LINES`（3 条产线）/ `MODULE_LINE`（模块→产线/工段），`server.js:74-92`；APS 内又重复定义了一份同源 `MODULE_LINE`（`aps.js:14-21`） |
| 已发出的事件类型 | `toolStatus`, `toolMetric`, `amhs`, `lotRelease`, `lotStart`, `lotStepDone`, `lotDone`, `lotHold`, `toolHold`, `toolRelease`, `lotReleaseHold`, `spcAlarm`, `metrology`, `vmPrediction`, `vmResult`, `fdcAlarm`, `hello`（WS 握手） |
| 核心 REST 端点 | `/api/health`,`/api/meta`,`/api/tools`,`/api/events`,`/api/wip`,`/api/e10`,`/api/wos`,`/api/lots`,`/api/lots/:id`,`/api/config`,`/api/topo`,`/api/aps`,`/api/aps/sim`,`/api/spc`,`/api/spc/release`,`/api/spc/inject`,`/api/fdc`,`/api/metrology`,`/api/vm`,`/api/pdm`,`/api/history/events`,`/api/ingest` |
| ERP REST 端点 | `/api/erp/health`,`/api/erp/materials`,`/api/erp/inventory`,`/api/erp/tx`,`/api/erp/suppliers`,`/api/erp/customers`,`/api/erp/po`(+`/receive`),`/api/erp/so`(+`/ship`),`/api/erp/costs`,`/api/erp/arap` |

> ⚠️ 注意：`server.js:298` 中 `lotDone` 会经 SECS 网关推送，但 `emitEv` 的 SECS 推送条件只匹配 `toolStatus/lotStart/lotDone` 且 `src!=='eap'`；ERP 订阅正是依赖这些事件。任何拆分都必须保留这一数据流。

---

## 1. 事件总线事件类型清单（Event Contract）

### 1.1 通用信封（envelope）
所有经 `emitEv` 发出的事件均为 JSON 对象，固定字段：

```jsonc
{
  "type": "string",   // 事件类型，见下表
  "ts":   "string",   // ISO8601，emitEv 内部由 nowISO() 生成（仅落库用，广播体不含 ts 字段，由消费端自取 Date.now()）
  // + 下表各 type 的 payload 字段
}
```

WS 广播体**不含** `ts`（`emitEv` 在 `broadcast` 前未附加 ts；ts 仅用于 `events` 表落库）。消费方（含 ERP）以收到时刻或 `seq` 为准。

### 1.2 事件类型总表

| type | 发布方 | 订阅方（当前代码内） | payload schema（字段：类型） | 说明 |
|---|---|---|---|---|
| `toolStatus` | MES 引擎 `dispatch/completeTool`、`tick`、`/api/ingest`(EAP) | WS 广播、E10、SECS 网关 | `id:string, status:'RUN'\|'IDLE'\|'PM'\|'DOWN', src?:'eap'` | 设备状态变化。`src:'eap'` 标识来自 EAP 桥 |
| `toolMetric` | `tick`（`server.js:317`） | WS、FDC(`fdcCheck`) | `id:string, util:int(30-99), wafers:int, wph:int(15-200)` | 设备性能指标周期采样 |
| `amhs` | `tick`（`server.js:324`） | WS | `from:string, to:string, foup:string` | 物料搬运（FOUP 在设备间流转）事件 |
| `lotRelease` | `WIPEngine._enqueue`（`core.js:72`） | WS、ERP(领料) | `lot:string, wo:string, mod:string` | lot 释放入队。**注意：无 product 字段**，ERP 需经 `wo` 查 `/api/wos` 反查 |
| `lotStart` | `WIPEngine.dispatch`（`core.js:89`） | WS、VM(`vmPredictLot`，当 `mod==='METRO'`) | `lot:string, wo:string, mod:string, tool:string` | lot 在某设备开始加工 |
| `lotStepDone` | `WIPEngine.completeTool`（`core.js:103`） | WS、量测生成(`generateMetrology`，当 `mod==='METRO'`) | `lot:string, mod:string, tool:string` | 单步完成 |
| `lotDone` | `WIPEngine.completeTool`（`core.js:110`） | WS、ERP(成品入库+成本)、SECS 网关 | `lot:string, wo:string, product:string, cycleH:number` | lot 整批完工 |
| `lotHold` | `WIPEngine.completeTool`/`holdLot`（`core.js:112/143`） | WS | `lot:string, reason:string` | lot 被停线挂起 |
| `toolHold` | `WIPEngine.holdTool`（`core.js:128`） | WS | `id:string, reason:string` | 设备被 SPC 停线 |
| `toolRelease` | `WIPEngine.releaseTool`（`core.js:135`） | WS | `id:string` | 设备解除停线 |
| `lotReleaseHold` | `WIPEngine.releaseLot`（`core.js:151`） | WS | `lot:string` | lot 解除停线重新入队 |
| `spcAlarm` | `SPC.onAlarm`（`server.js:173`） | WS | `product:string, param:string, tool:string, value:number, mean:number, ucl:number, lcl:number, rules:string[]` | SPC 判异报警（触发自动停线） |
| `metrology` | `generateMetrology`（`server.js:223`） | WS、SPC(`spc.onMetrology`)、VM(`vmRecord`) | `lot:string, product:string, tool:string\|null, step:int, param:string, unit:string, value:number, target:number, usl:number, lsl:number, result:'OK'\|'OOR'` | 量测数据点（SPC 数据源） |
| `vmPrediction` | `vmPredictLot`（`server.js:201`） | WS | `lot:string, product:string, tool:string, param:string, pred:number, cold?:bool` | VM 虚拟量测预测 |
| `vmResult` | `vmRecord`（`server.js:212`） | WS | `lot:string, product:string, tool:string, param:string, pred:number\|null, actual:number, errPct:number\|null, status:'OK'\|'DEVIATION'\|'NO_PRED'` | VM 预测 vs 实际对比 |
| `fdcAlarm` | `fdcCheck`（`server.js:190`） | WS | `ts:number(epoch ms), tool:string, module:string, wph:number, avgWph:number, util:number` | FDC 设备退化报警 |
| `hello` | WS `connection`（`server.js:593`） | 客户端握手 | `service:'fab-mes', version:string, tools:int, ts:string` | WS 连接建立首帧 |
| `wmsPick` | WMS `handleMesEvent`(`lotRelease`) | WMS 本地 `wms_tx` 留痕（未来经 `/api/ingest` 并入总线） | `material:string, batch:string, qty:number(负=出库), loc_from:'WH-RAW', loc_to:'STAGE-A', ref:lot, note:string` | 投料实物拣货（与 ERP 领料同源） |
| `wmsPutaway` | WMS `handleMesEvent`(`lotDone`) / `putaway` | WMS 本地 `wms_tx` 留痕 | `material:string, batch:string, qty:number, loc_from:'STAGE-A', loc_to:'WH-FIN'\|'WH-RAW', ref:lot\|grId, note:string` | 成品上架 / 采购上架 |
| `wmsGoodsReceipt` | WMS `goodsReceipt` | WMS 本地 `wms_tx` 留痕 | `material:string, batch:string, qty:number, loc_to:'RCV-01', ref:po, note:string` | 采购收货到暂存 |
| `wmsShip` | WMS `shipOrder` | WMS 本地 `wms_tx` 留痕 | `material:string, batch:string, qty:number(负=出库), loc_from:'WH-FIN', ref:order, note:string` | 销售发运出库 |

> 字段名一律为 `camelCase`，与现有代码完全一致，实施 Agent 不得改名。

### 1.3 事件契约稳定性规则（阶段0 红线）
- 新增事件类型必须先在本文档登记，并新增 `emitEv` 调用点的注释指向本表。
- `lotRelease`/`lotStart`/`lotStepDone`/`lotDone` 的字段是 ERP 对接依据，**禁止删除或重命名字段**。
- 跨进程消费方只允许基于事件 `type` + 上述字段做过滤，禁止依赖字段顺序。

---

## 2. 进程间通信方案（IPC Contract）

### 2.1 现状
ERP 已验证可用「**各进程独立 HTTP REST + 一份共享 WS 事件流订阅**」完成跨进程联动（ERP 订阅 MES 的 8124 WS，并轮询 `/api/wos` 取 wo→product 映射）。这是已落地、零新增依赖的模式。

### 2.2 推荐方案
**阶段0 采用「独立 HTTP REST + 共享 WS 事件流」为主，引入轻量消息总线 (NATS/Redis Streams) 为可选增强，不强制。**

理由：
1. **零新增依赖、零运维**：WS 事件流已在 8124 运行，ERP 已消费，无需引入 broker 即可支撑阶段0。
2. **故障隔离**：MES 崩溃不影响 ERP 进程存活（当前已满足）；各进程独立 DB，无锁冲突。
3. **可演进**：后续若需多 MES 实例、事件回放、持久化订阅，再引入 NATS（单二进制、Node 客户端成熟）或 Redis Streams，作为 `emitEv` 的可插拔后端（见 §5 存储抽象 + §3 骨架中的 `eventbus` 适配层）。

### 2.3 跨进程数据获取约定
| 场景 | 方案 | 端点 |
|---|---|---|
| ERP 订阅 MES 实时事件 | WS 客户端连接 `ws://MES_HOST:8124` | 消费 `lotRelease`/`lotDone` 等 |
| ERP 取 lot 历史/wo 映射 | 周期轮询 + 按需拉取 | `GET /api/wos`、`GET /api/lots/:id` |
| 门户/孪生页 取实时快照 | WS 订阅 + 按需 `GET /api/*` | 全部只读端点 |
| 未来 MQ 模式（可选） | 各进程既 `emitEv` 到 WS 也 publish 到 NATS subject `fab.events.<type>` | 订阅方用 Queue Group 做负载均衡 |

> 多进程拆分后，WS 事件流**只保留在 MES 主进程(8124)**；其他进程/前端统一连 8124 订阅。切勿在各进程重复开 WS 源，避免事件重复。

---

## 3. API 契约（核心 `/api/*` 端点）

> 所有响应统一头 `Access-Control-Allow-Origin: *`、正文 `application/json`。
> 时间字段统一 ISO8601 字符串。批量查询 `limit` 超过硬上限时服务端截断（见各端点）。

### 3.1 MES 主数据 / 状态
| 方法 | 路径 | 请求 | 响应 | 说明 |
|---|---|---|---|---|
| GET | `/api/health` | — | `{ok:true, service:'fab-mes', version:'M3-S1', tools:int, clients:int, uptime:number}` | 健康检查 |
| GET | `/api/meta` | — | `{modules:[{key,name,count}], products:[{key,label,passes}], routes:[{product,step,module}], secsDevices:{}, statusMap:{}, dispatchRules:[]}` | 主数据 |
| GET | `/api/tools` | — | `{total:int, byStatus:{RUN,IDLE,PM,DOWN}, byModule:{MODULE:count}, tools:[Tool]}` | 设备全量（`Tool` 见 §4.1） |
| GET | `/api/topo` | — | `{lines:[Line], moduleLine:{MODULE:{line,bay}}, toolCount:int}` | 产线/工段拓扑（`Line` 见 §4.4） |
| GET | `/api/events` | `?after=seq&limit=` | `{count, events:[{seq,ts,type,...payload}]}` | 内存+DB 事件流（limit≤500） |
| GET | `/api/history/events` | `?from=&to=&type=&limit=` | `{count, events:[{seq,ts,type,...payload}]}` | DB 历史事件（limit≤1000） |
| GET | `/api/wip` | — | `WIPEngine.wipSnapshot()` → `{rule, byModule, byProduct, wip, done, moves, releases, avgCycleH}` | WIP 快照 |
| GET | `/api/e10` | — | `E10Tracker.snapshot()` | 设备状态时间占比 |
| GET | `/api/e10dbg` | — | `{dev, now, startTs}` | 调试用 |

### 3.2 WIP / 工单 / 批次
| 方法 | 路径 | 请求体 / 参数 | 响应 | 说明 |
|---|---|---|---|---|
| GET | `/api/wos` | — | `{count, wos:[WoView]}` | 工单列表；`WoView={id,product,qty,dueHours,created,due,lots:{STATUS:count},total}` |
| POST | `/api/wos` | `{qty?:1-20, product?:'N2'\|'A16', dueHours?:number}` | `201 {wo:WoView}` | 创建工单并自动生成 lots |
| GET | `/api/lots` | `?status=WIP\|HOLD\|DONE` | `{count, lots:[LotView]}` | 批次列表（取最近200） |
| GET | `/api/lots/:id` | 路径参数 | `{id,wo,product,step,rem,status,due,created,curTool,hist:[{step,mod,tool,start,end,durH}]}` | 单批详情（ERP `costLot` 依赖此 `hist`） |
| POST | `/api/config` | `{rule?, autoWo?, speed?}` | `{rule, autoWo, speed}` | 派工规则/自动投料/速度；`rule∈['FIFO','SPT','CR','EDD','BN','HYBRID']` |
| GET | `/api/config` | — | `{rule, autoWo, speed, rules:[]}` | 当前配置 |

### 3.3 智能引擎（只读查询为主，少量写操作用于演示闭环）
| 方法 | 路径 | 请求体 | 响应 | 说明 |
|---|---|---|---|---|
| GET | `/api/aps?horizon=1-168` | 默认24 | `APSEngine.plan()` → `{generated,horizonH,rule,kpi,modules,lines,lineBottleneck,bottleneck,wos,suggest}` | 产能计划（无状态实时算） |
| POST | `/api/aps/sim` | `{downTools?:string[], extraWos?:[{product,qty,dueHours}], horizon?}` | `{horizon,downTools,extraWos,baseKpi,simKpi,modules:[{module,name,baseLoad,simLoad,delta}],bottleneck,lineBottleneck,simValid}` | what-if 仿真（只读快照副本，不改引擎） |
| GET | `/api/spc` | — | `{...spc.snapshot(), alarms:[{...rules:[]}]}` | SPC 状态+报警 |
| POST | `/api/spc/release` | `{tool?, lot?}` | `{ok, released}` | 解除停线 |
| POST | `/api/spc/inject` | `{product?,param?,tool?,value?,lot?}` | `{injected:metrologyEvent}` | 注入量测验证判异闭环 |
| GET | `/api/fdc` | — | `{count, alarms:[...]}` | FDC 报警 |
| GET | `/api/metrology` | `?param=&lot=&product=&limit≤500` | `{count, stats:[{param,product,unit,n,mean,sd,min,max,cpk}], samples:[...]}` | 量测数据+统计 |
| GET | `/api/vm` | `?limit≤200` | `{stats, results:[{id,ts,lot,product,tool,param,pred,actual,errPct,status}]}` | 虚拟量测 |
| GET | `/api/pdm` | — | `PdMEngine.assess()` | 预测性维护风险排行 |

### 3.4 EAP 事件桥
| 方法 | 路径 | 请求体 | 响应 | 说明 |
|---|---|---|---|---|
| POST | `/api/ingest` | `{id:string, type:'toolStatus', status:'RUN'\|'IDLE'\|'PM'\|'DOWN'}` | `200 {ok,src:'eap',id,status}` / `404 unknown tool` / `400 unsupported` | EAP Host → MES 标准事件入口 |

### 3.5 ERP（独立进程 :8126，前缀 `/api/erp`）
| 方法 | 路径 | 请求体 | 响应 | 说明 |
|---|---|---|---|---|
| GET | `/api/erp/health` | — | `{ok, service:'fab-erp', version:'ERP-1', mesConnected:bool, uptime}` | — |
| GET | `/api/erp/materials` | — | `{count, lowStock, materials:[{code,name,cat,unit,price,stock,safety_stock}], low:[]}` | cat: RAW/FIN |
| GET | `/api/erp/inventory` | — | `{value, materials:[]}` | 库存金额 |
| GET | `/api/erp/tx?limit≤200` | — | `{count, tx:[]}` | 库存流水 |
| GET | `/api/erp/suppliers` / `/customers` | — | `{suppliers/customers:[]}` | 主数据 |
| POST/GET | `/api/erp/po` | POST `{material,supplier?,qty?,price?}` | POST→`{ok,id,material,qty,price}`；GET→`{count,pos:[]}` | 采购单 |
| POST | `/api/erp/po/:id/receive` | — | `{ok,error?}` | 收货→入库+应付 |
| POST/GET | `/api/erp/so` | POST `{customer?,product?,qty?,price?,due?}` | POST→`{ok,id,price}`；GET→`{count,sos:[]}` | 销售单 |
| POST | `/api/erp/so/:id/ship` | — | `{ok,error?}` | 发运→出库+应收 |
| GET | `/api/erp/costs` | — | `{count,totalCost,avgCost,byProduct, batches:[]}` | 批次成本 |
| GET | `/api/erp/arap` | — | `{count, apTotal, arTotal, rows:[]}` | 应收应付 |

### 3.6 WMS（独立进程 :8128，前缀 `/api/wms`）
WMS = 仓储实物执行层（库位/批次库存/上架/拣货齐套/收发流水），与 ERP 财务台账域隔离、同源于 MES 事件流。
| 方法 | 路径 | 请求体 | 响应 | 说明 |
|---|---|---|---|---|
| GET | `/api/wms/health` | — | `{ok, service:'fab-wms', version:'WMS-1', mesConnected:bool, uptime}` | — |
| GET | `/api/wms/locations` | — | `{count, locations:[{code,zone,kind,capacity,occupied}]}` | 库位主数据 |
| GET | `/api/wms/inventory` | — | `{count, byLocation:[{loc,skus,qty}], inventory:[{material,batch,qty,loc_code,status}]}` | 批次级库存 |
| GET | `/api/wms/tasks` | — | `{open, all, tasks:[{id,type,ref,material,qty,loc_code,status}]}` | 拣货/上架任务 |
| GET | `/api/wms/tx?limit≤200` | — | `{count, tx:[{ts,type,material,batch,qty,loc_from,loc_to,ref}]}` | 收发流水（不可变留痕） |
| GET | `/api/wms/kit?lot=` | — | `{count, kits:[{lot,product,ok,missing:[{material,need,have}]}]}` | 在制批次齐套检查 |
| POST | `/api/wms/goods-receipt` | `{po?,material?,qty?}` | `{ok,grId,material,qty}` | 采购收货→RCV-01 暂存+上架任务 |
| POST | `/api/wms/putaway` | `{taskId, locCode?}` | `{ok,taskId,material,locCode}` | 上架：RCV-01→指定库位 |
| POST | `/api/wms/ship` | `{order?,material?,qty?}` | `{ok,order,material,qty}` | 销售发运→WH-FIN 出库 |

### 3.7 静态页路由（MES 主进程当前承载，拆分后移交门户进程）
`/`, `/console.html`, `/twin.html`, `/line-twin.html`, `/fab-twin.html`, `/sim.html`，以及兼容入口 `/?src=mes`。

---

## 4. 数据模型（Data Model）

### 4.1 Tool（设备）— `tools` 表 + 内存 `tools[]`
| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `id` | string | `server.js:57` | 全局唯一，如 `LITHO-001` |
| `module` | string | MODULES.key | LITHO/ETCH/DEP/CMP/IMPL/METRO |
| `modName` | string | MODULES.name | 模块中文名 |
| `status` | 'RUN'\|'IDLE'\|'PM'\|'DOWN' | 引擎/EAP | 实时状态 |
| `wph` | int | 初始随机 | 每小时晶圆数 |
| `util` | int | 周期采样 | 利用率% |
| `wafers` | int | 累计 | 累计晶圆 |
| `chambers` | int | 初始 | 腔体数 |
| `recipe` | string | 初始 | 配方号 |
| `line` | string | 由 `MODULE_LINE` 反查 `server.js:91` | 所属产线 `FAB-Lx` |
| `bay` | string | 同上 | 所属工段 `BAY-x` |
| `_lot` / `_hold` / `holdReason` / `_pt` / `curStart` | 运行时内部字段 | 引擎 | **非持久化**，仅供引擎调度 |

DB `tools` 表字段：`id, module, status, util, wafers, wph, updated_at`（不含 line/bay，line/bay 当前为内存派生，拆分时建议落库或并入拓扑服务）。

### 4.2 Lot（批次）— 内存 `engine.lots` + `lots` 表
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | `LOT-xxxx` |
| `wo` | string | 所属工单 |
| `product` | 'N2'\|'A16' | 产品 |
| `productLabel` | string | 如 `N2 2nm` |
| `route` | string[] | 重入工艺路线（模块序列） |
| `step` | int | 当前步索引 |
| `rem` | int | 剩余步数 |
| `status` | 'WIP'\|'HOLD'\|'DONE' | — |
| `due` / `created` | epoch ms | 交期/创建 |
| `curTool` | string\|null | 当前加工设备 |
| `hist` | `{step,mod,tool,start,end,durH}[]` | 步级历史（ERP 成本归集依赖） |

`lots` 表：`id, wo, product, productLabel, step, rem, status, due, created, curTool`。

### 4.3 WO（工单）— 内存 `engine.wos` + `wos` 表
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | `WO-xxxx` |
| `product` | string | — |
| `productLabel` | string | — |
| `qty` | int | lot 数 |
| `dueHours` | number | 交期小时 |
| `created` / `due` | epoch ms | — |
| `lots` | string[] | 关联 lot id 列表 |

`wos` 表：`id, product, productLabel, qty, dueHours, created, due`。

### 4.4 Line / Bay（新增拓扑归属）— 当前为配置层常量
| 实体 | 字段 | 说明 |
|---|---|---|
| Line | `key`(FAB-L1..3), `name`, `bays:string[]` | 产线定义（`LINES`） |
| Bay | `key`(BAY-1..5) | 工段，归属某产线 |
| ModuleLine | `MODULE → {line, bay}` | 模块→产线/工段映射（`MODULE_LINE`，server.js 与 aps.js 各有一份，需收敛为单一配置源） |

> **阶段0 动作**：将 `MODULE_LINE` / `LINES` 收敛为单一可加载配置（如 `config/topo.js` 或 DB `meta_topo` 表），MES 与 APS 共用，避免重复定义漂移。

---

## 5. 存储抽象建议（Storage Abstraction）

### 5.1 现状问题
- 关系型数据（`tools/wos/lots/events/metrology/...`）直接依赖 `node:sqlite` 的 `DatabaseSync`，SQL 散落在 `server.js` 各处。
- 时序数据（设备 `toolMetric`、量测 `metrology` 流）与关系数据混用同一 SQLite，高频写入无专门优化。
- MES/ERP 各持一个 sqlite 文件，跨进程无共享事务。

### 5.2 推荐抽象层
引入 `storage/` 模块，定义统一接口，关系型后端可切换：

```
storage/
  index.js          // 工厂：按 STORAGE_DRIVER 返回实现
  interface.js      // StorageAdapter 抽象基类（方法签名）
  sqlite.js         // 现有 node:sqlite 实现（保持现状，封装已有 prepared stmt）
  postgres.js       // 可选：生产切换（同接口，SQL 适配）
  timeseries.js     // 可选：时序数据适配（InfluxDB/TimescaleDB/RedisTimeSeries）
```

接口契约（建议方法，保持与现有调用语义一致）：
```js
class StorageAdapter {
  // 关系型
  initSchema() {}
  upsertTool(t) {} updateToolStatus(id,status,ts) {} updateToolMetric(...) {}
  insertEvent(ts,type,payload) {} queryEvents({after,limit,type,from,to}) {}
  insertWO(w) {} insertLot(l) {} updateLot(l) {} insertLotHist(h) {}
  insertMetrology(m) {} insertVmLog(v) {} insertSpcAlarm(a) {}
  queryMetrology({param,lot,product,limit}) {} queryWos() {} queryLot(id) {}
  // 时序（可选）
  writeMetricSeries(points[]) {} queryMetricWindow(toolId, from, to) {}
}
```

### 5.3 切换策略
- 阶段0：**不切换引擎**，仅把 `server.js` 中的 `db`/`insXxx`/`qXxx` 引用收敛到 `storage/sqlite.js`，对外暴露上述方法。业务调用点改为 `storage.xxx()`，功能零退化。
- 时序数据：阶段0 仍落 SQLite `metrology`/`toolMetric` 队列；仅当演示规模上量时，将 `toolMetric` 高频采样切到 `timeseries.js`（接口预留，不强制实现 InfluxDB）。

---

## 6. 多进程骨架方案（Multi-Process Skeleton）

### 6.1 目标拓扑
```
浏览器/孪生前端
   │  WS(:8124) + HTTP 静态(:8123)
   ▼
┌─────────────┐   WS 订阅    ┌──────────────────┐
│ 门户静态进程 │◀────────────│  MES 主进程 :8124 │
│ :8123       │  (只读订阅)  │  (WS源+REST+引擎) │
│ 静态HTML     │             │  SECS/GEM :5000   │
└─────────────┘             └────────┬─────────┘
                                     │ REST /api/* (ERP 拉取)
                                     ▼
                              ┌──────────────────┐
                              │ ERP 进程 :8126    │
                              │ (已独立)          │
                              └──────────────────┘
        EAP 协议网关 :8125（SECS/GEM；HSMS :5000 内嵌于 MES）；APS 内置于 MES 8124（不独立）
```

### 6.2 目录结构与落点
```
fab-mes/
├── server.js              # 改为 MES 主进程入口（仅引擎+REST+WS+SECS）
├── erp.js                 # 由 fab-erp.js 重命名/保留，ERP 进程入口
├── portal.js              # 新增：门户静态进程 :8123，仅 serve 静态 HTML
├── aps-server.js          # 新增（可选）：APS 独立进程 :8125，复用 aps.js
├── services/              # 新增：进程内服务模块
│   ├── eventbus.js        # emitEv + broadcast + (可选)MQ 适配，单一出口
│   ├── wip.js             # 包 WIPEngine 实例化（原 server.js:604 区块）
│   ├── spc.js bridge      # SPC/FDC/VM/PdM 装配（原 server.js:163-214）
│   └── topo.js            # 收敛 LINES/MODULE_LINE 单一配置源
├── storage/               # 新增：§5 存储抽象
│   ├── index.js
│   ├── interface.js
│   └── sqlite.js
├── config/
│   └── topo.js            # 单一拓扑配置（替代 server.js & aps.js 双份）
├── bin/
│   └── start-all.sh       # 启动编排（见 §6.4）
└── docs/CONTRACT.md
```

### 6.3 各进程职责与共享事件
| 进程 | 端口 | 职责 | 如何共享事件 |
|---|---|---|---|
| MES 主进程 | 8124 | WIP 引擎、SPC/FDC/VM/PdM、SECS/GEM(:5000)、REST `/api/*`(除 `/api/erp/*`)、**唯一 WS 事件源** | 自身 `emitEv` |
| 门户静态进程 | 8123 | 托管 console/twin/line-twin/fab-twin/sim HTML；反向代理或前端直连 8124 WS | 作为 WS 客户端订阅 8124（只读） |
| EAP 协议网关 | 8125 | HSMS(:5000) 设备通信（SECS/GEM S6F11），经 MES 回灌驱动 lot 生命周期 | WS 连 MES 网关(:5000)，S6F11→`/api/ingest`→MES emitEv |
| Agent 对话式智能体 | 8127 | 基于 MES/ERP REST 的问答与自治建议 | REST `/api/agent/chat`（门户 8123 代理转发） |
| APS 引擎 | 内置 MES 8124 | 负荷/瓶颈/排程只读规划，**不独立成进程** | 由 MES dispatch 调用 `GET /api/aps/sim`（当前为只读仪表，未进派工决策） |
| ERP 进程 | 8126 | 物料/采购/销售/成本 | 现状：WS 订阅 8124 + 轮询 `/api/wos`、`/api/lots/:id` |
| WMS 进程 | 8128 | 库位/批次库存/上架/拣货齐套/收发流水（仓储实物执行层） | WS 订阅 8124（lotRelease/lotDone），本地 `wms_tx` 留痕；与 ERP 同源派生、域隔离 |

> 关键约束：**WS 事件源只能有一个（8124）**。拆分后门户/APS 不得自建 WS 广播，只做订阅方，避免事件被复制/丢失。

### 6.4 启动方式
```bash
# bin/start-all.sh（示例，Node 22）
NODE="C:/Users/35657/.workbuddy/binaries/node/versions/22.22.2/node.exe"
$MES_WS=ws://127.0.0.1:8124 $NODE server.js &        # MES :8124
$MES_WS=ws://127.0.0.1:8124 $NODE portal.js &        # 门户 :8123
$MES_HTTP=http://127.0.0.1:8124 $NODE erp.js &       # ERP :8126 (已独立)
# $NODE aps-server.js &                              # 可选 APS :8125
```
支持 env 覆盖端口：`PORT`(MES)、`PORTAL_PORT`(门户)、`ERP_PORT`(ERP)、`APS_PORT`(APS)、`MES_WS`/`MES_HTTP`（消费方指向）。

---

## 7. 阶段0 实施 Checklist（具体到文件与函数）

> 目标：原功能不退化。每步完成后跑 `node server.js` + `node erp.js` 验证端点与原事件流无变化。
> 标注 [新文件] 的为新增，其余为改现有文件。

- [ ] **C1 [新文件] `storage/interface.js`**：定义 `StorageAdapter` 抽象类与 §5.2 方法签名（仅接口，空实现抛 `not implemented`）。
- [ ] **C2 [新文件] `storage/sqlite.js`**：把 `server.js:96-160` 的 `db` 实例化、`PRAGMA`、所有 `CREATE TABLE`、`insXxx/updXxx/qXxx` prepared statement 平移到此文件，实现 `StorageAdapter`。保持 SQL 原文不变。
- [ ] **C3 [新文件] `storage/index.js`**：`getStorage()` 工厂，默认返回 `sqlite.js` 实现（读 `process.env.STORAGE_DRIVER || 'sqlite'`）。
- [ ] **C4 改 `server.js`**：删除 §96-160 的裸 `db`/stmt 定义，改为 `const storage = require('./storage');`。将 `insTool.run(...)` / `updToolStatus.run(...)` 等调用点逐一替换为 `storage.xxx(...)`；`emitEv` 内落库改为 `storage.insertEvent(...)`；`flushEvts` 改用 `storage` 批写。功能等价校验。
- [ ] **C5 [新文件] `config/topo.js`**：导出 `LINES` 与 `MODULE_LINE`（值同 `server.js:74-87`）。
- [ ] **C6 改 `server.js` 与 `aps.js`**：移除各自内联的 `MODULE_LINE`/`LINES`，改为 `require('./config/topo')`。验证 `/api/topo` 与 `/api/aps` 输出与改动前一致（APS 内 `MODULE_LINE` 值与 server 完全一致，无语义变化）。
- [ ] **C7 [新文件] `services/eventbus.js`**：封装 `emitEv` + `broadcast` + `wss` 创建。把 `server.js:259-299` 的 `wss`/`broadcast`/`emitEv` 逻辑迁入；`emitEv` 增加可选 MQ publish 钩子（默认 no-op，便于将来接 NATS）。
- [ ] **C8 改 `server.js`**：`require('./services/eventbus')` 取 `emitEv`/`broadcast`/`wss`，删除原 259-299 段落。确认 SECS 推送、E10 记录、量测/VM/SPC/FDC 订阅在 `emitEv` 内仍按原条件触发。
- [ ] **C9 [新文件] `services/wip.js`**：把 `server.js:596-604` 的 `persist` 对象 + `new WIPEngine(...)` 实例化逻辑迁入，导出 `engine` 与 `persist`（绑定 `storage`）。
- [ ] **C10 改 `server.js`**：用 `services/wip` 注入 `engine`/`persist`，删除原 596-604。确认 `createWO`/`dispatch` 行为与之前一致。
- [ ] **C11 [新文件] `portal.js`**：新建 HTTP 服务监听 `PORTAL_PORT||8123`，只 serve 静态 HTML（`console.html`/`twin.html`/`line-twin.html`/`fab-twin.html`/`sim.html`），复用 `server.js` 的静态路由分支（把 339-367 行逻辑搬来）。不承载 `/api/*` 与 WS 源。
- [ ] **C12 改 `server.js`**：删除 339-367 的静态页分支（门户职责移交 portal.js），仅保留 8124 的 `/api/*` 与 WS 升级。
- [ ] **C13 改 `server.js` 启动日志**：更新打印的端口说明（MES 8124 / WS 源 / SECS 5000；注明静态页在 8123）。
- [ ] **C14 [新文件] `bin/start-all.sh`**：按 §6.4 编排启动 MES + 门户 + ERP（APS 可选注释）。
- [ ] **C15 文档同步**：在 `CONTRACT.md` 顶部补充「当前落地进度」勾选表，记录 C1-C14 完成情况。
- [ ] **C16 回归验证**：启动全部进程后，用脚本/浏览器确认：① `GET /api/health` 各进程可达；② ERP 仍能在 `lotRelease`/`lotDone` 时领料/入库/成本；③ 孪生页经 8123 加载且 WS 收到事件；④ `/api/aps`、`/api/spc`、`/api/metrology` 输出格式不变。

> 不要求阶段0 实现 NATS/Redis、Postgres、独立 APS 进程——这些在 §2.2 / §5.3 列为可选，接口已预留。

---

## 8. 风险与约束（阶段0 红线）
1. `emitEv` 是全局事件唯一出口，任何拆分不得绕开它直接 `broadcast` 或直写 DB。
2. ERP 依赖 `lotRelease`(经 wo 查 product)、`lotDone`(带 product+cycleH)、`/api/lots/:id`(hist) —— 这些契约字段冻结。
3. WS 事件源仅 8124 一个；门户/APS 只能订阅，不能成为新源。
4. 存储层替换必须保持 SQL 语义等价，DB 文件 `fab-mes.db` 结构向后兼容（不得 DROP 已有表）。
5. 拓扑配置 `MODULE_LINE` 收敛为单源后，MES 与 APS 输出须与原双份定义数值一致（已核对两份值相同，仅去重）。
