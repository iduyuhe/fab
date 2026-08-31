# 数智晶圆厂平台 · L3 专业版引擎说明（ENGINES-L3）

> 本文档说明 L3 阶段五大智能引擎从「演示启发式（L1/L2）」升级为「真实算法内核（L3）」的改动，
> 重点描述新增的真实算法、新增 API 返回字段，以及严格的向后兼容约束。
> 配套引擎文件：`spc.js` `fdc.js` `pdm.js` `vm.js` `aps.js`。

---

## 0. 兼容红线（必须遵守）

- **所有 `/api/*` 端点原有字段一律保留**，仅允许「新增字段」，禁止删除/重命名字段。
- **前端孪生页 / Agent** 依赖的现有字段（如 `aps.kpi`、`aps.bottleneck`、`spc.alarms`、`spc.snapshot().groups` 等）不被破坏，否则 L1/L2 功能退化。
- **WS 事件类型与字段**（`fdcAlarm`、`spcAlarm` 等）保持为唯一事件源，未新增事件类型。
- 不引入未安装的重型包（无真 lp-solver / tensorflow），全部使用原生算法或清晰注释的近似。
- `server.js` 的路由注册与返回包装**未改动**；仅扩展引擎文件内部函数。

---

## 1. SPC 统计过程控制（spc.js）

### L1/L2 演示版
- 控制限 = 规格限 USL/LSL 作为硬基准（不被样本稀释，保证明显超规格必报）；
- 样本 ≥5 后切换为 `mean ± 3σ` 动态限；
- 阶段0 规则：R1 单点超控制限 / R2 连续9点同侧 / R3 连续6点单调。

### L3 真实算法内核（新增）
- 新增**完整 Western Electric 规则集** `SPC.detectWesternElectric(points, mean, sd, opts)`：
  - `WE1` 单点出 ±3σ（含规格硬限）
  - `WE2` 连续9点中心线同侧
  - `WE3` 连续6点单调（递增/递减）
  - `WE4` 连续14点交替上下（周期震荡）
  - `WE5` 连续3点中≥2点超 ±2σ
  - `WE6` 连续5点中≥4点超 ±1σ
- 规则命中后并入报警 `alarm.rules` 数组（原有 R1~R3 文本保留，新增 WE* 文本）。

### 新增/变更字段
- `alarm.rules`：由 `['R1 ...']` 扩展为可含 `['R1 ...','WE5 ...']`，**字段名与位置不变**。
- `spc.snapshot()`、`/api/spc` 返回结构未变。

---

## 2. FDC 故障检测与分类（fdc.js · 新建）

### L1/L2 演示版
- FDC 逻辑内联于 `server.js` 的 `fdcCheck`：单变量阈值（wph < 模块均值 60% → 记录）。
- `/api/fdc` 返回 `{ count, alarms:[{ts,tool,module,wph,avgWph,util}] }`。

### L3 真实算法内核（新增）
- 新建独立引擎 `fdc.js`，导出 `FDC` 类与 `detectMultivariate(samples)`。
- **多变量异常检测（PCA-lite / 马氏距离近似）**：
  1. 对多变量样本矩阵计算均值向量与协方差矩阵（对角正则 λ 防奇异）；
  2. 以马氏距离 `d²=(x-μ)ᵀΣ⁻¹(x-μ)` 作为异常分值 `score`；
  3. `contrib` = 各维度标准化残差 `|z_i|` 排序（top3），近似主成分贡献。
  - 样本不足时退化为单变量 z-score 平方和（加权阈值）。
  - 判异阈值：`χ²(d)` 95% 近似 `d + 2√d`（不依赖统计包）。
- `server.js` 的 `fdcCheck` 改为复用 `FDC.assess()`，**返回包装不变**。

### 新增字段（不删原字段）
- `alarm.score`：多变量异常分值（马氏距离平方）。
- `alarm.contrib`：`[{var, weight}]` top 贡献变量。
- `/api/fdc` 仍返回 `{ count, alarms }`，alarms 元素新增上述两字段。

---

## 3. PdM 预测性维护（pdm.js）

### L1/L2 演示版
- 风险评分 = 0.25×利用率 + 0.25×磨损 + 0.20×故障次数 + 0.15×停机 + 0.15×状态（全局归一化）。

### L3 真实算法内核（新增）
- 新增 `estimateRUL(tool, e10Rec, ctx)` **剩余寿命估算**：
  - `baseLife` = 设备类别设计寿命（演示值字典 `DESIGN_LIFE_H`）；
  - `wearRate = 1 + 0.15×downCount + 0.35×max(0, vibTrend)`（非线性退化）；
  - `degradation = effective / baseLife`，`rulHours = max(0, baseLife - effective)`；
  - `riskLevel` = 退化率映射：`>0.8 HIGH / >0.6 MED / else LOW`。
- `assess()` 第三参 `rulCtx`（默认空 `Map`，原调用签名兼容）注入 RUL 结果。

### 新增字段（不删原字段）
- 每行增加 `rulHours`（剩余小时）、`rulRisk`（HIGH/MED/LOW）、`rulDegradation`（0~1）。

---

## 4. VM 虚拟量测（vm.js）

### L1/L2 演示版
- EWMA 历史均值预测（`predict` / `record` / `stats`），冷启动用工艺 target。

### L3 真实算法内核（新增）
- 新增 `predictVirtual(tool, sensors, opts)` **回归虚拟量测**：
  - 纯线性回归 `y = intercept + Σ coef_i × sensor_i`（预置系数 `DEFAULT_REG`，可按 tool|param 在线缓存微调）；
  - 传感器：temp / pressure / power / rate / flow 等易测量；
  - 返回 `predicted`（难测参数估计值）、`residual`（相对 target 残差）。

### 新增字段（不删原字段）
- `/api/vm` 的 `results[]` 不变；`predictVirtual` 作为独立方法对外提供 `predicted/residual`，
  由 Agent / 上层在需要时调用，不强制进入既有 `/api/vm` 列表（避免破坏 stats 口径）。

---

## 5. APS 高级计划与排程（aps.js）

### L1/L2 演示版（启发式，无状态）
- `plan(snap, horizon)`：模块产能模型 → 在制需求累计 → 负荷率/瓶颈 → 工单前推排程 → KPI。
- `/api/aps` 返回 `kpi / modules / lines / lineBottleneck / bottleneck / wos / suggest`。
- `/api/aps/sim` 复用同一无状态内核做 what-if。

### L3 真实算法内核（新增，可选分支）
- 新增 `solveILP(modules, demand, horizon)` **整数规划近似求解**：
  - 建模：决策变量 = 各模块整数加班小时 `x_m` + 虚拟转产批次；目标 `min α·Σx_m + β·Σlate_m`；
  - 约束：`cap24_m + x_m·stepCap ≥ needH_m`，`x_m ≤ horizon`；
  - 解法：**贪心 + 局部搜索**（向 IDLE 模块虚拟转产降低最大负荷），不保证全局最优；
  - 返回 `gapPct`（上界/下界 比值近似最优性间隙）、`objValue`、`bound`、`feasible`。
  - 默认**不依赖外部包**；若未来安装 `javascript-lp-solver` 可在 `solveILP` 内替换求解器。
- `plan()` 默认仍为原启发式（`solver:'heuristic'`）；快照带 `_useILP:true` 时切换 ILP 分支。

### 新增字段（不删原字段）
- `/api/aps` 返回新增 `solver: 'heuristic'|'ilp'` 与 `optimality: {gapPct,objValue,bound,feasible}|null`。
- `kpi`、`bottleneck`、`modules`、`wos` 等原有字段**完全保留**。

### 关于 /api/aps/sim 的说明（重要）
- `/api/aps/sim` 内部两次调用 `plan()`，`base`/`cur` 对象**已包含** `solver`/`optimality` 字段；
- 但 `server.js` 的 sim 返回包装未改动（依据「不擅自改 server 路由/返回包装」约束），
  其顶层响应未显式转发 `solver`。
- **如需在 sim 顶层也显式暴露 `solver`，需 server.js 配合改动**（建议：在 sim 返回加
  `solver: base.solver, optimality: base.optimality`）。此改动按任务约定「先说明但不擅自加」，
  已在此标注，待 PM/架构确认后实施。

---

## 6. 校验

```bash
node --check spc.js fdc.js pdm.js vm.js aps.js
# 全部通过；Grep 确认 aps.kpi / aps.bottleneck / spc.alarms 等字段未被删除。
```

## 7. 与 L1/L2 区别总览

| 引擎 | L1/L2 演示 | L3 专业版 |
|------|-----------|-----------|
| SPC  | R1~R3 + 规格硬限 | + 完整 Western Electric WE1~WE6 |
| FDC  | 单变量 wph 阈值 | + 多变量马氏距离(score/contrib) |
| PdM  | 风险评分 | + RUL 剩余寿命(退化模型) |
| VM   | EWMA 预测 | + 线性回归虚拟量测(predicted/residual) |
| APS  | 启发式 plan | + ILP 近似求解(gap/optimality)，默认 fallback |

> 所有改动对 `/api/*` 端点**向后兼容**：仅新增字段，原有字段、事件契约、WS 事件源均不变。
