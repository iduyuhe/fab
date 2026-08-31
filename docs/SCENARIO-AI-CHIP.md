# AI 芯片典型工艺路线 — 社区版(L1)默认场景

> 本文档固化「数智晶圆厂平台」社区版启动即加载的 **AI 芯片默认工艺场景**。
> 经核对 `config/topo.js`、`core.js`、`server.js` 现有默认配置，该场景已**天然内置**，
> 平台启动即生效，**无需任何代码改动**。本文档仅作场景固化与讲解引用约定。

---

## 1. 场景总览

| 维度 | 默认值 | 来源 |
|------|--------|------|
| 产品 | `N2` (2nm) / `A16` | `core.js:9-12` `PRODUCTS` |
| 工艺路线 | 6 模块重入：LITHO→ETCH→DEP→CMP→IMPL→METRO | `core.js:7` `ROUTE` |
| 重入次数 | N2=4 次 / A16=3 次（多产品光刻层 → 重入） | `core.js:9-12` `passes` |
| 设备模块 | 6 类共 192 台 | `server.js:28-35` `MODULES` |
| 产线拓扑 | FAB-L1 / FAB-L2 / FAB-L3（BAY-1~BAY-5） | `config/topo.js:6-19` |
| 自动投料 | `autoWo = true`，间隔 `AUTO_WO_MS` 投 N2/A16 工单 | `server.js:472,474` |
| 派工规则 | HYBRID（瓶颈 LITHO 用 BN，其余 FIFO） | `core.js:14,33,159` |

> 注：用户口述路线为 Litho→Dep→Etch→Implant→CMP→Metro，与代码 `ROUTE`
> （LITHO→ETCH→DEP→CMP→IMPL→METRO）为**同一六模块集合**，仅演示顺序差异；
> 二者均代表「AI 芯片前道六工段重入工艺」，属同一默认场景，无矛盾。

---

## 2. 产品定义（/api/meta → products）

| Key | 标签 | 重入 passes | 含义 |
|-----|------|-------------|------|
| `N2`  | N2 2nm | 4 | 2nm 旗舰 AI 芯片，光刻层数更多，重入 4 轮 |
| `A16` | A16    | 3 | 上代 AI 芯片，重入 3 轮 |

每条工单默认 `qty=3` 批次（自动投料时 `qty=3~5`），`dueHours=24~72`。

---

## 3. 完整重入工艺路线（/api/meta → routes）

单轮基序（`ROUTE`）＝ 6 步，N2 展开为 `6×4=24` 步、A16 展开为 `6×3=18` 步。
每步 → 模块 → 产线/工段映射（来自 `config/topo.js` 的 `MODULE_LINE`）：

| 步序(单轮) | 模块 Key | 模块名 | 产线 | 工段(Bay) |
|:---:|------|------|------|------|
| 1 | LITHO | 光刻 Litho (EUV/ArF) | FAB-L1 | BAY-1 |
| 2 | ETCH  | 刻蚀 Etch            | FAB-L1 | BAY-2 |
| 3 | DEP   | 薄膜沉积 Dep         | FAB-L1 | BAY-2 |
| 4 | CMP   | CMP                  | FAB-L2 | BAY-4 |
| 5 | IMPL  | 离子注入 Implant     | FAB-L2 | BAY-3 |
| 6 | METRO | 量测/检测 Metrology   | FAB-L3 | BAY-5 |

重入特征：每完成一轮 6 步后回到 LITHO，形成 N2 闭环 4 次 / A16 闭环 3 次。
lot 沿路线在模块间自动流转（`core.js:_enqueue`→`dispatch`→`completeTool`）。

---

## 4. 设备模块清单与数量（/api/meta → modules；/api/tools 统计）

| 模块 Key | 名称 | 设备数 | 所属产线 |
|----------|------|:---:|------|
| LITHO | 光刻 Litho (EUV/ArF) | 14 | FAB-L1 / BAY-1 |
| ETCH  | 刻蚀 Etch            | 42 | FAB-L1 / BAY-2 |
| DEP   | 薄膜沉积 Dep         | 54 | FAB-L1 / BAY-2 |
| CMP   | CMP                  | 26 | FAB-L2 / BAY-4 |
| IMPL  | 离子注入 Implant     | 22 | FAB-L2 / BAY-3 |
| METRO | 量测/检测 Metrology   | 34 | FAB-L3 / BAY-5 |
| **合计** | — | **192** | — |

设备 uid 全局连续：`LITHO-001…014` / `ETCH-015…056` / `DEP-057…110` /
`CMP-111…136` / `IMPL-137…158` / `METRO-159…192`（`server.js:55-69`）。

---

## 5. 默认投料策略（/api/wip；/api/wos）

- 开关：`autoWo = true`（默认开启，`server.js:472`）。
- 节奏：每 `AUTO_WO_MS` 毫秒自动创建一个工单，产品随机 `N2` / `A16`
  （`server.js:474`），`qty = 3 + floor(rand*3)`，`dueHours = 24 + floor(rand*49)`。
- 效果：平台常驻运行后孪生页**打开即有在制（WIP）**；首次启动后首个间隔内
  可能出现短暂空白，属正常（自动投料为周期触发，非启动阻塞）。
- 手动投料：`POST /api/wos`（`{product:'N2'|'A16', qty, dueHours}`），
  见 `server.js:416-424`。

---

## 6. 数字孪生三级页面呈现对照

| 孪生层级 | 页面文件 | 呈现内容（数据来源） |
|----------|----------|----------------------|
| 装备级 | `twin.html` | 单台设备状态 RUN/IDLE/PM/DOWN、当前加工 lot、util/wph/chambers；事件来自 WS(8124) |
| 产线级 | `line-twin.html` | 按 FAB-L1/L2/L3 聚合各 BAY 模块设备分布与在制队列（/api/topo + /api/tools + /api/wip） |
| 工厂级 | `fab-twin.html` | 三产线全局 WIP、吞吐 moves、完工 done、平均周期 avgCycleH（/api/wip 快照） |

重入路线在三级页面均体现为：lot 在 LITHO→…→METRO 间循环，N2/A16 批次
在工厂级 WIP 按 `byProduct` 分色统计。

---

## 7. 对话 Agent 讲解可引用的关键数据点

对话 Agent 应优先引用以下 REST/WS 实时端点（均经 8124 单事件源，符合 CONTRACT.md）：

- **`GET /api/meta`** — 主数据：`modules`(6模块/192台)、`products`(N2/A16)、
  `routes`(展开后的完整重入步骤序列)。用于解释"这是什么产品、走什么路线"。
- **`GET /api/topo`** — 产线拓扑：`LINES`(FAB-L1/L2/L3 + BAY1-5) 与
  `MODULE_LINE`(模块→产线/工段映射)。用于解释"设备分布在哪条产线"。
- **`GET /api/wip`** — 实时在制：`byModule`(各模块 queue/processing)、
  `byProduct`(N2/A16 在制数)、`wip`/`done`/`moves`/`avgCycleH`/`releases`。
  用于讲解"当前产能、瓶颈、周期"。
- **`GET /api/wos` / `GET /api/lots`** — 工单与批次明细（产品、qty、due、状态）。
- **`GET /api/tools`** — 各模块设备实时数量与状态统计。
- **WS `ws://127.0.0.1:8124`** — 唯一事件源，推送 `lotStart/lotStepDone/lotDone/
  toolStatus` 等，用于实时讲解"某批次刚完成某步、某设备开始加工"。

> 讲解示例："当前工厂级在制 N2 约 X 批、A16 约 Y 批（/api/wip.byProduct）；
> 瓶颈在 FAB-L1 的 LITHO（仅 14 台，HYBRID 规则对 LITHO 用 BN 派工）；
> 该批次正沿 N2 重入路线第 3 轮运行（/api/meta.routes）。"

---

## 8. 合规声明（CONTRACT.md）

- 本场景**未改动任何事件字段**，所有状态变更经 `emitEv` 统一发出，WS 源仅 8124。
- 未删除/重命名字段，未绕开 `emitEv`。
- 本文档仅为场景固化，平台代码保持原功能（自动投料、派工规则不变）。
