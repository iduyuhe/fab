# fab-mes 服务器开发手册（与 LDA 同机协同）

> 目标：把 fab-mes 的**开发 + 运行**都放在服务器 `115.191.20.92` 上，与 LDA（`lda.weomnitech.com.cn`，本机 `127.0.0.1:3006`）同机，便于上下游协同（LDA 设计 → fab-mes 流片）。

## 1. 从另一台电脑接入

- **推荐**：在另一台电脑的 VS Code 装 **Remote-SSH** 插件 → 连接 `root@115.191.20.92`（端口 22）→ 打开 `/opt/fab-mes`。直接在服务器上编辑、运行、调试，体验最佳。
- **备选**：任意终端 `ssh root@115.191.20.92`，用 `vim` / `nano` 编辑。
- **前提**：该电脑能访问 `115.191.20.92:22`（云安全组放行 SSH）。

## 2. 服务器关键事实

- **代码**：`/opt/fab-mes`（git 仓库，分支 `main`，远端 `origin` = GitHub `iduyuhe/fab-mes`）。
- **Node**：**必须用 `/opt/node22/bin/node`（v22.22.2，带 `node:sqlite`）**。系统自带 node 是 v20，**不能用**，否则 `node:sqlite` 报错。
- **服务**：`systemctl status fab-mes`（已 enable，开机自启）。重启：`systemctl restart fab-mes`。
- **端口**（已全部 env 可配，避开 weomnitech-saas 的 812x 基址）：
  - `8200` HSMS（SECS/GEM 裸 TCP）
  - `8203` 门户 Portal
  - `8204` MES（含 HSMS 网关、事件总线 WS）
  - `8205` EAP
  - `8206` ERP
  - `8207` Agent（问答副驾）
  - `8208` WMS
- **公网访问**：`https://fab.weomnitech.com.cn/`（nginx :443 → 8203，certbot 自动续期）。IP 直访 `http://115.191.20.92:8888/`（未加密）。
- **登录**：默认 `admin / admin123`（**建议改**）。

## 3. 日常开发循环

1. 在 `/opt/fab-mes` 编辑源码（`server.js` / `core.js` / `storage/*` / `agent/*` / `services/*` / `deploy/*`）。
2. 提交：`git add -A && git commit -m "..." && git push`。
3. 生效：`systemctl restart fab-mes`，等约 10 秒。
4. 验证：
   - 端口：`ss -ltnp | grep 82` 应看到 8200 / 8203–8208。
   - 健康：`curl -s 127.0.0.1:8204/api/health` 应返回 `{"ok":true,...}`。
   - 日志：`journalctl -u fab-mes -f`。

## 4. 与 LDA 协同（上下游）

- LDA 本机地址：`http://127.0.0.1:3006`，子域 `https://lda.weomnitech.com.cn/`。
- **桥接端点**：`POST /api/npi/import-lda`（在 MES `8204`），把 LDA 设计包导入为 fab-mes 设计档案 + 光罩 + NPI 流片批；**以 LDA 设计包的 `verification.passed` 为唯一放行门**（未通过 → 422 拒绝"不进入流片"）。
- **便捷脚本**：`/opt/fab-mes/bin/lda_fab_bridge.py <shelfId> [tapeout|engineering|volume]`。
- 示例：`python3 /opt/fab-mes/bin/lda_fab_bridge.py IM-CPO-WDM5 tapeout`。

## 5. 排错要点

- 改完重启后某进程没起来：先看 `journalctl -u fab-mes --since '5 min ago'`。常见坑：
  - `DatabaseSync` 的 options **不能传 `undefined`**（Node22 严格），打开库时务必传对象或省略第二参数。
  - 多进程同开 `fab-config.db` / `fab-mes.db`：需 `busy_timeout`（已设 5000）。
  - 杀进程只用 `pkill -f '/opt/node22/bin/node'`，**不要杀 PID 22982（weomnitech-saas，合法业务占 8124）**。
- WMS 久跑可能卡死：彻底 `pkill` 后干净重启即可。

## 6. 安全（部署后必做）

- 服务器 root 密码、`GitHub token` 曾在对话中明文出现，**稳定后请改密 + 吊销旧 token**，并在服务器上执行：
  `git remote set-url origin git@github.com:iduyuhe/fab-mes.git`（改用 SSH 部署密钥，移除明文 token）。

---

## 7. 资源治理（锁死上限，防整机卡死）—— 重要

> **背景**：此前把服务器（4 核 / 3.7GB，与 LDA/A-GEO/工作台 同机）整机跑死，根因不是"性能差"，是"**没有上限**"：
> autoWo 每 8s 无脑造工单、`engine.lots/wos` 从无上限 → 内存无限增长；APS 每 5s 全量重算（随 lot 增多越来越慢）；
> LDA 看门狗每 20s 全量拉货架 + 逐货架拉包；WMS 经 WS 消费 MES 事件慢 → MES 侧 TCP Send-Q 积压；日志无节流刷屏。
> 设计原则（见《CPU 优化需求说明书》）：**写"上限"不写"优化"**——每个指标可测量、可验收、可追责。

### 7.1 四大护栏的代码落点

| 护栏 | 落地位置 | 行为 |
|---|---|---|
| **① 事件驱动 + 空闲降频** | `server.js` `scheduleAps` / `schedulePredScan` / `scheduleTick` / autoWo | APS 改为**事件驱动**（仅当 WIP 指纹变化才重算），空闲(>3min 无操作)拉长到 60s；predScan 空闲跳过；tick 空闲(>1min)放慢到 5s；autoWo 空闲暂停 **且** 在制达 `WIP_CAP` 即停 |
| **② 队列封顶 + 背压** | `core.js _pruneDone` / `storage/sqlite.js enqueueEvent` / `eap-host.js` / `services/eventbus.js broadcast` | 在制/历史 `lots` 封顶 `maxLots=2000`、`wos` 封顶 `maxWos=500`（仅回收已完工，在制/HOLD 绝不删）；事件落库缓冲封顶 20000（满丢最旧+计数）；EAP `events` 封顶 200；**WS 背压**：单客户端 `bufferedAmount>100KB` 丢弃本次发送、>`1MB` 直接断开 |
| **③ 并发闸 + 时间预算** | `governance.js TaskGate` | 重型任务（predScan）进统一并发闸，同时运行 ≤ `GOV_MAX_CONCURRENT`(默认 2)，单任务超 `GOV_TASK_BUDGET_MS`(默认 30s) 返回降级值并释放槽位 |
| **④ 增量 + 缓存 + 退避** | `server.js` LDA 看门狗（`gov.fetch`） | 货架列表走 `expBackoffFetch`（指数退避 + 超时 + 断连吞异常不刷堆栈）+ TTL 缓存；仅**候选货架**才拉包（非全量逐拉）；空闲拉长轮询到 60s |

### 7.2 自监控端点

- `GET /api/governor`：实时返回 并发数/队列长度/任务耗时/各周期任务开关(idle/autoWo)/CPU 增量(MHz)/内存/空闲时长/LDA 看门狗状态/事件背压丢弃数。验收与排障首查它。

### 7.3 可调环境变量（禁止硬编码）

| 变量 | 默认 | 含义 |
|---|---|---|
| `GOV_MAX_CONCURRENT` | 2 | 并发闸门最大同时运行数 |
| `GOV_TASK_BUDGET_MS` | 30000 | 单任务时间预算（超时降级） |
| `GOV_QUEUE_MAX` | 1000 | 背压队列默认上限 |
| `GOV_IDLE_MS` | 180000 | 空闲降频阈值（无操作超此值降频/暂停） |
| `GOV_LOG_LPM` | 100 | 日志行/分钟上限（超出采样降级） |
| `WIP_CAP` | 240 | 在制上限：达到即暂停自动投料 |
| `APS_RECOMPUTE_MS` / `APS_IDLE_MS` | 5000 / 60000 | APS 重算间隔 / 空闲间隔 |
| `PRED_SCAN_MS` / `PRED_IDLE_MS` | 30000 / 60000 | 预测扫描间隔 / 空闲间隔 |
| `LDA_WATCH_MS` / `LDA_CACHE_TTL_MS` | 20000 / 10000 | LDA 轮询周期 / 货架列表缓存 TTL |
| `EV_BP_BYTES` / `EV_BP_KILL_BYTES` | 100KB / 1MB | WS 单客户端背压/断开阈值 |

### 7.4 系统层兜底（随仓库提供，需手动安装，**未自动应用**）

- `deploy/fab-mes.resource.conf`：systemd drop-in，`CPUQuota=200%` + `MemoryMax=1800M` + `TasksMax=512`。
  安装：`mkdir -p /etc/systemd/system/fab-mes.service.d && cp deploy/fab-mes.resource.conf /etc/systemd/system/fab-mes.service.d/resource.conf && systemctl daemon-reload && systemctl restart fab-mes`
- `deploy/fab-mes.logrotate`：20MB 轮转保留 3 份。journald 建议同时设 `SystemMaxUse=200M`。

### 7.5 验收 / 压测方法（不依赖生产）

- **纯逻辑自测（本地即可跑，已随仓库）**：
  - `node governor-selfcheck.cjs` —— 并发闸封顶、超时降级、背压队列、空闲判定、退避不抛错、日志节流（19 项）。
  - `node core-selfcheck.cjs` —— 内存护栏裁剪、在制/HOLD 保留（8 项）。
- **集成自测**：本地 `PORT=8399 LDA_WATCHER=0 node server.js` 起服务，循环 `curl /api/governor` 观察并发/队列/idle；静置 5min 看 `idle` 变 true、autoWo 暂停。
- **SLO 验收**（来自需求书，一票否决项）：稳态空闲 CPU≤10%、峰值≤150%、并发≤2、队列不单调上升、曲线锯齿、日志≤100 行/分、无未捕获异常刷屏。

### 7.6 ⛔ 红线

**未经用户明确许可，禁止 `systemctl restart fab-mes` 把改动部署到生产服务器（115.191.20.92）。** 任何上线必须先本地跑通 §7.5 自测，再申请部署。

