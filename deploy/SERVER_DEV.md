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
