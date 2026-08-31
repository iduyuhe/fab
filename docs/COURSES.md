# 数智晶圆厂平台 · 教学课程大纲（L2 教学级）

> 本文档面向 **院校采购版（L2）** 的课程目录，配套 `lab.html` 引导式实验台。
> 所有实验均**复用 L1 已落地的真实引擎能力**（只读 REST / 已授权的注入与仿真动作），
> 不新增业务逻辑、不直写数据库、不绕开事件总线（符合 `docs/CONTRACT.md`）。
> 默认场景：N2 (2nm) / A16 六模块重入工艺（LITHO→ETCH→DEP→CMP→IMPL→METRO，见 `docs/SCENARIO-AI-CHIP.md`）。

---

## 模块 0 · 平台与环境入门（必修）

| 主题 | 内容 | 配套页 |
|------|------|--------|
| 平台架构 | 多进程拆分（门户 8123 / MES 8124 / 对话 Agent 8127）、唯一 WS 事件源、CONTRACT 红线 | `console.html` |
| 数字孪生三级 | 装备级 / 产线级 / 工厂级 孪生与数据来源 | `twin.html` `line-twin.html` `fab-twin.html` |
| 对话 Agent | 零成本检索 MES/ERP，教学问答与引导 | `agent.html` |

---

## 模块 1 · 晶圆厂概览（Wafer Fab Overview）

| 实验 | 名称 | 引擎 / 页面 | 调用端点 |
|------|------|-------------|----------|
| 1.1 | 认识产线与重入工艺 | 拓扑 + 在制快照 | `GET /api/topo` `GET /api/wip` `GET /api/meta` |
| 1.2 | 设备资产盘点 | 设备状态统计 | `GET /api/tools` |

> 判据：能从 `/api/wip` 读出 N2/A16 在制数、`/api/tools` 读出 6 模块 192 台分布。

---

## 模块 2 · SPC 质量管控（Statistical Process Control）⭐内置实验 A

| 实验 | 名称 | 引擎 / 页面 | 调用端点 |
|------|------|-------------|----------|
| 2.1 | **用 SPC 拦截 CD 漂移**（完整内置） | SPC 判异闭环 + 装备级孪生 | `POST /api/spc/inject` → `GET /api/spc` → `GET /api/tools`（确认 hold） |
| 2.2 | 观察控制图与规格限 | SPC 监控组 | `GET /api/spc` |

> 实验 A 引导：① 观察 CD 规格限 USL/LSL ② 注入超 USL 的 CD 量测值 ③ 查 `/api/spc` 是否触发 alarm ④ 在 `twin.html` 确认设备被 hold。
> 判据（真实调用）：`inject` 后 `GET /api/spc` 返回的 `alarms` 中存在 `tool===注入tool` 且 `param==='CD'` 的报警记录。

---

## 模块 3 · 排程与产能（APS & Capacity）⭐内置实验 B

| 实验 | 名称 | 引擎 / 页面 | 调用端点 |
|------|------|-------------|----------|
| 3.1 | **用 APS 缓解产能瓶颈**（完整内置） | APS what-if 无状态仿真 | `GET /api/wip` → `POST /api/aps/sim` |
| 3.2 | 工单前推与交期 | APS 排程 | `GET /api/aps?horizon=24` |

> 实验 B 引导：① 查当前瓶颈模块（APS `bottleneck[0]`）② 模拟该模块 DOWN 若干台（downTools）③ 运行 what-if 看负荷变化（modules[].delta）④ 加派工单（extraWos）看冲击（simKpi.lateWos）。
> 判据（真实调用）：sim 返回 `modules` 中对应模块 `simLoad > baseLoad`，或 `simKpi.lateWos` 随 extraWos 增加。

---

## 模块 4 · 设备维护与成本（E10 / FDC / ERP）

| 实验 | 名称 | 引擎 / 页面 | 调用端点 |
|------|------|-------------|----------|
| 4.1 | 设备状态机与 PM | E10 状态模型 | `GET /api/e10` |
| 4.2 | 性能退化报警 | FDC | `GET /api/fdc` |
| 4.3 | 制造成本看板 | ERP | `GET /api/erp/cost`（如启用） |

---

## 实验台使用说明（lab.html）

- 顶部：实验选择器，从内置列表（实验 A / B 等）选择。
- 左侧：分步 checklist（目标 / 操作 / 判据），实时标记通过态。
- 右侧：参数表单（调用 `inject` / `sim`）+ 实时结果区（轮询 `/api/spc` 或展示 sim 返回）。
- 底部：导师提示区，调用 `POST /api/agent/chat`（教学意图）获取引导性讲解。
- 导航：返回门户（`/`）/ 打开孪生页（`twin.html` `fab-twin.html`）。

> 合规红线：实验台仅做 **GET 只读** 与 **POST 已授权的注入/仿真**（inject/sim 为演示闭环动作）。
> 绝不直写 `fab-mes.db`，所有状态变更经 `emitEv` 统一事件总线。
