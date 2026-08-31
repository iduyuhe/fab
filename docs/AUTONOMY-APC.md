# L4 自治闭环 + APC 先进过程控制 设计说明

> 数智晶圆厂平台 · L4 工厂级升级。在 L3「协作副驾」(只出分析与建议、绝不代执行) 之上，
> 把副驾升级为「自治闭环」：副驾建议经**人审(confirm)** 后**自动执行**真实 MES 写端点；
> 并新增 **APC 先进过程控制**（基于 VM 预测 + 反馈闭环自动微调参数）。
> 零外部 LLM 成本：全部为本地规则引擎。

---

## 1. 人审闭环流程（L4 Autonomy）

```
副驾建议(只读 GET) ──记录 lastSuggestion──▶ 用户回复"确认执行"
        │                                          │
        ▼                                          ▼
  [autonomy_confirm 意图] ──▶ executor.executeAction({action, payload, confirmed:true})
        │                                          │
        ▼                                          ▼
   安全护栏(guard) ──白名单+参数校验──▶ 人审闸门(needsConfirm)
        │                                  │
   ❌ 拦截(非白名单/参数非法)        ❌ 未 confirm → 拒绝并提示
        │                                  │
        ▼                                  ▼
   审计(audit) 记录              ✅ 通过 → fetch POST 真实 MES 写端点
                                       │
                                       ▼
                                  MES 写库 / 事件总线(emitEv)
```

- **默认安全**：`requireExplicitConsent=true`，任何写操作必须 confirm；executor 只接受白名单动作。
- **审计**：优先 `POST /api/audit/log`（当前 server 无此端点，回退 `console` 输出 `[autonomy-audit]`）。

## 2. 安全护栏白名单（autonomy/safeguard.js）

| 动作 | 真实 MES 端点 | 说明 |
|------|--------------|------|
| `spc.inject` | `POST /api/spc/inject` | 注入量测点，触发判异/停线闭环 |
| `aps.sim` | `POST /api/aps/sim` | what-if 情景推演 |
| `spc.release` | `POST /api/spc/release` | 释放停线/批次 |
| `wo.create` | `POST /api/wos` | 派工单写库 |

> 注：`/api/lots/:id/release` 在 server.js 中**不存在**，未纳入白名单。
> 护栏导出：`ALLOWED_AUTO_ACTIONS` / `needsConfirm(action)` / `guard(action,payload)` /
> `requireExplicitConsent`（默认 true，仅 `AUTONOMY_CONSENT=0` 可显式关闭人审）。

## 3. APC 先进过程控制（apc/controller.js）

- **控制律**：偏移补偿（offset-compensate P 控制），`adjust = -kp * residual`，含**死区**
  (`deadband`，相对残差 < 阈值不调，防过调)。`apcAdvise(tool, predicted, target)` 返回修正量。
- **闭环**：`createApc({mesh, emitEv})` 读 `GET /api/vm` 取最新预测，计算残差→修正量；
  经 `emitEv`（事件总线唯一出口）上报；仅在 `APC_ENABLED=1` 且超死区时经白名单
  `spc.inject` 真实闭环微调。
- **默认关**：`APC_ENABLED=0`，仅输出建议修正量，不真调（避免无人值守副作用）。

## 4. 默认安全策略

- 自治人审：**默认开启**（必须 confirm），`AUTONOMY_CONSENT=0` 方可无人值守。
- APC：**默认关闭**，仅建议不真调；`APC_ENABLED=1` 才闭环微调。
- 红线：WS 源唯一(:8124)；执行一律走真实 MES POST 端点；不直写 DB、不绕开事件总线。
- executor 绝不绕过 `guard`；任何写动作都过白名单 + 参数校验 + 人审闸门。

## 5. 与现有副驾的衔接

- L3 副驾处理函数（copilot_rootcause_sp / copilot_bottleneck / copilot_action / copilot_deep）
  末尾均追加 `CONFIRM_HINT`（"可回复'确认执行'以自动执行"），并写入 `lastSuggestion`
  （记录该条建议的可执行动作与参数）。
- 新增意图 `autonomy_confirm`（识别"执行/确认/同意/apply/confirm/照做"等）调用 executor；
  `autonomy_status` 返回当前护栏状态与白名单。
- 未改动 server.js / portal.js / fab-erp.js / aps.js / core.js / 引擎文件；APC 未新增
  `/api/apc/adjust` 端点（避免副作用，默认关、仅模拟建议）。

## 6. 文件清单

- 新增 `autonomy/safeguard.js`：护栏（白名单/needsConfirm/guard/requireExplicitConsent）
- 新增 `autonomy/executor.js`：自治执行器（guard + 人审 + 真实 POST + 审计）
- 新增 `apc/controller.js`：APC 控制律与闭环（默认关）
- 修改 `agent/chat-server.js`：新增 `autonomy_confirm` / `autonomy_status` 意图与处理函数，
  副驾建议附加确认提示并记录 lastSuggestion
- 新增 `docs/AUTONOMY-APC.md`：本说明
