# OTD-5 式人工走查演示（OTD 接单→交付 × NPI 设计→流片）

> 目标：用最贴近真人操作控制台的方式，证明 **OTD 接单→交付** 与 **NPI 设计→流片** 两条主流「好做易做」，且孪生/控制台**实时可见**。
> 全部请求经门户 `http://127.0.0.1:8123`（与孪生页同源），事件走唯一 WS 总线 `ws://127.0.0.1:8123`（孪生页订阅同一源）。

## 一、一键自动走查（推荐）

```bash
node otd5-walkthrough.mjs          # 托管运行时：C:/Users/35657/.workbuddy/binaries/node/versions/22.22.2/node.exe
```

脚本会按下面的 12 步自动走完并生成 `otd5-walkthrough-report.html`（控制台也有彩色逐步输出）。
最近一次运行：**14/14 通过**。

## 二、人工走查步骤（对应控制台点击）

### 0. 前提
- 六进程栈已起：`bash bin/start-community.sh`（MES:8124 / 门户:8123 / ERP:8126 / Agent:8127 / EAP:8125 / WMS:8128 + HSMS:5000）。
- 浏览器打开 `http://127.0.0.1:8123/`（MES 控制台）。

### 1. OTD 主线：接单 → 投料 → 流转 → 发运 → 回款
1. 在控制台「销售订单」区点 **新建 SO**，填 `客户=CUS-WALK / 产品=N2 / 数量=25 / 交期=12h` → 提交。
   - 等价于 `POST /api/erp/so`。系统**自动向 MES 投料**（订单驱动生产，P0-1）。
2. 切到 **MES 批次**视图（`/console.html` 或 `/fab-twin.html`），可见该 SO 的批次 `status=WIP` 实时推进（step 递增）。
3. 事件总线（孪生页）实时显示 `lotRelease → lotStart → lotStepDone → lotDone`。
4. SO 状态机自动推进：`OPEN → IN_TRANSIT`（发运）→ `DELIVERED`（签收）→ `CLOSED`（回款）。
5. ERP「应收」自动生成 AR 发票（金额=数量×单价）。

### 2. NPI 主线：设计档案 → 工程批 → 流片批
1. 打开 `http://127.0.0.1:8123/npi-ops.html`（NPI 管理台）。
2. 设计档案区可见种子设计（如 `DES-002 / CIS 图像传感器`）。
3. 点 **投放工程批(engineering)** → 等价于 `POST /api/npi/launch {designId,type:'engineering'}`。
   - 系统按 `设计层数→重入次数（design→route 派生）` 自动生成 WO 与路线。
4. NPI 批次列表出现该工程批，`status=WIP` 沿**同一条 MES 主轴**推进。
5. 遇质量判异会 `HOLD`（SPC 停线）→ 控制台点 **解除停线(PQE 复核)**（等价于 `POST /api/spc/release {lot}`）→ 批次继续至 `DONE`。
6. 点 **投放流片批(tapeout)** 演示资格验证重入（`qualification=true`，路线更长）。

### 3. 实时可见性佐证
- 孪生三件套 `/fab-twin.html`、`/line-twin.html`、`/twin3d/index.html` 与控制台 `/console.html`、`/npi-ops.html` 均经门户 8123 返回 200。
- 它们订阅的 WS 总线与走查脚本订阅的是**同一源 8123**，故走查期间产生的 `lotStart/lotStepDone/lotDone/lotHold/lotReleaseHold/metrology/vmPrediction/apcSetpoint/amhs` 等事件，孪生页**实时可见**。

## 三、根因修复（本轮附带的脊柱 bug 修复）
- **现象**：批次偶发卡在 `HOLD` 永久不动，OTD 无法交付、NPI 无法完工。
- **根因**（server.js SPC onAlarm）：SPC 停线后，per-tool 看门狗 `completeTool` 仍会触发，把 HOLD 批次移出 `_processing`；但 12s 自动放行的反查 `cur = 当前在该设备上的批次` 已找不到它 → `releaseLot` 永不调用 → 永久卡死。
- **修复**：onAlarm 记住本次被停线的 `heldLotId`，定时器显式 `releaseLot(heldLotId)`（走 `byLot` 查，不依赖 `_processing`），并兜底扫描该设备仍 HOLD 的在制批次一并放行。保留「判异演示但贯通产线」的设计意图。

## 四、结论
OTD 接单→交付 与 NPI 设计→流片 两条主流在统一数字主线下贯通，且孪生/控制台实时可视 —— **好做、易做、看得见**。
