# 数智晶圆厂平台 · L4 合规审计层设计

> 文档状态：L4 实施设计（已落地）
> 适用范围：`audit/`、`storage/sqlite.js`(audit_log)、`server.js`(/api/audit + initAudit)
> 目标：满足半导体行业对操作可追溯、不可篡改、数据保留的要求（SEMI E10/E30/E87），并为 L4 自治闭环（副驾自动执行）留痕。

---

## 1. 总体架构

```
emitEv(ev)  ──► eventbus 广播 + events 表落库 + 各业务订阅
                  │
                  └─► [只读订阅] audit/index.js onEmit
                          │  白名单过滤（写操作/状态变更/智能引擎判异）
                          ▼
                       storage.appendAudit(rec)
                          │  链式 hash = sha256(prev_hash|ts|actor|action|target|payload)
                          ▼
                       audit_log 表（追加式，不可篡改）
                          │
                          ▼
              GET /api/audit  ── 审计查询（含 SEMI 追溯标签）
              logAction()     ── 副驾建议 / 自治执行显式留痕
```

- 接入点：`eventbus.onEmit` —— 现有 `emitEv` 仍是全局唯一事件出口，审计**仅做只读订阅**，不广播、不直写 `events` 表、不新造事件（CONTRACT §8 红线）。
- 默认开启：审计只对新增事件生效，不影响历史数据；`audit_log` 表为新增叠加表，不影响 `tools/wos/lots/events/...` 等现有表与任何现有方法签名。

---

## 2. 不可篡改机制：链式 Hash

`audit_log` 表结构：

| 列 | 说明 |
|---|---|
| id | 自增主键 |
| ts | ISO8601 时间戳 |
| tenant | 租户（默认 `default`） |
| actor | 操作主体（设备 id / lot / `system` / 副驾 id） |
| action | 动作（= ev.type 或显式 `copilotSuggest` 等） |
| target | 作用对象（设备/lot/foup） |
| semi | SEMI 追溯标签 JSON（['E10'] 等） |
| payload | 原始事件/上下文 JSON |
| prev_hash | **上一笔记录的 hash**（创世首条 = `'0'`） |
| hash | `sha256(prev_hash|ts|actor|action|target|payload)` |

**计算方式**（Node 原生 `node:crypto`，零新增依赖）：

```
hash = sha256( prev_hash + '|' + ts + '|' + actor + '|' + action + '|' + target + '|' + payload )
```

- 每笔记录的 `prev_hash` 指向上一笔的 `hash`，形成哈希链。
- 任何对历史记录的 `payload/actor/ts` 等字段篡改，都会使该记录的 `hash` 改变，进而破坏其后所有 `prev_hash → hash` 的连续性。校验时只需从头重算并与存储 `hash` 比对，即可发现篡改。
- 校验脚本（示意）：按顺序取 `audit_log`，以 `prev_hash='0'` 起步，逐条重算 `hash` 并与存储值比对；首个不一致处即篡改点。

---

## 3. SEMI 追溯映射

### 3.1 标准条款

| 条款 | 定义 | 平台对应 |
|---|---|---|
| **E10** | 设备可靠度/可用性/可维护性与状态模型 | 设备状态机 `RUN/IDLE/PM/DOWN`，`toolStatus/toolHold/toolRelease` 事件 |
| **E30** | GEM 配方管理(RMS) | 设备 `recipe` 字段；`recipeLoad` 事件（预留）；工单/批次流转 `lotStart/lotDone` 等 |
| **E87** | 载具(FOUP/Reticle Pod)控制与追溯 | AMHS `amhs` 事件含 `foup` 字段，标记载具移动 |

### 3.2 平台事件 → SEMI 映射表

| 平台事件 | SEMI 条款 | 说明 |
|---|---|---|
| `toolStatus` | E10 | 设备状态变更 |
| `toolMetric` | E10 | 设备性能采样 |
| `toolHold` / `toolRelease` | E10 | 设备停线/解除 |
| `recipeLoad` | E30 | 配方加载/切换（预留） |
| `lotRelease` / `lotStart` / `lotStepDone` / `lotDone` | E30 | 工单批次流转 |
| `lotHold` / `lotReleaseHold` | E30 | 批次停线/解除 |
| `amhs` / `carrierMove` | E87 | 载具(FOUP)流转 |
| `spcAlarm` / `fdcAlarm` | E30 | 智能引擎判异（操作追溯） |
| `copilotSuggest` / `copilotAutoExec` | E30 | L4 副驾建议 / 自治执行留痕 |

映射定义在 `audit/semi-map.js`（`SEMI_TRACING` / `EVENT_TO_SEMI` / `semiOf`），审计落库与文档共用，避免漂移。

---

## 4. 数据保留策略

- 保留期由环境变量 `AUDIT_RETENTION_DAYS` 控制（默认未设置 = 永久保留，符合"默认保留"语义）。
- 本阶段**仅说明策略、不实现删除**：审计链为追加式，删除任何一条都会破坏哈希链；如需按期归档，应在离线归档副本上执行，主链保留以满足不可篡改要求。
- 建议：生产环境将 `AUDIT_RETENTION_DAYS` 设为合规要求值（如 365/1825），并配独立 WORM 存储或只读副本做长期归档。

---

## 5. 与事件总线集成方式

- `audit/index.js` 的 `initAudit({storage, eventbus})` 在 `server.js` 中 **eventbus 创建后、业务订阅之后** 调用一次。
- 通过 `eventbus.onEmit(fn)` 注册单一订阅：
  - 仅对白名单内"写操作/状态变更/判异"事件落审计，不影响业务订阅逻辑。
  - 订阅异常被 `try/catch` 隔离，审计失败不回灌主流程。
- 显式留痕：`logAction({actor, action, target, payload, semi})` 供副驾/自治模块调用（如 `copilotSuggest`/`copilotAutoExec`），`actor` 可设为副驾 id 以区分人机操作。
- 查询：`queryAudit({after, limit, actor, action})` 供 `GET /api/audit` 使用。

---

## 6. 对现有功能的影响

- **零退化**：`audit_log` 为新增表；`storage` 仅新增 `initAuditSchema`/`appendAudit`/`queryAudit` 三个方法，原有方法签名与表结构未改。
- `server.js` 仅两处最小改动：引入 `initAudit` + 一行调用；新增 `GET /api/audit` 路由。其余路由/WS/引擎逻辑完全不变。
- 审计是 `emitEv` 的只读下游，不新增事件、不改字段，ERP/门户/SECS 等消费方数据流不变。

---

## 7. 验证

- `node --check server.js audit/index.js audit/semi-map.js storage/sqlite.js` 通过。
- 启动后 `GET /api/audit?limit=20` 返回最近审计记录，`semi` 字段带 E10/E30/E87 标签。
- 哈希链校验：按 §2 重算即可验证不可篡改性。
