#!/usr/bin/env bash
# ============================================================
#  L1 社区级启动编排：MES(8124) + 门户(8123) + ERP(8126) + Agent(8127) + WMS(8128)
#  用法： bash bin/start-community.sh   (在 fab-mes/ 目录下)
#  依赖：NODE 指向 Node 22（含 node:sqlite 与原生 fetch）
# ============================================================
set -e
cd "$(dirname "$0")/.."

NODE="${NODE:-C:/Users/35657/.workbuddy/binaries/node/versions/22.22.2/node.exe}"
MES_WS="${MES_WS:-ws://127.0.0.1:8124}"
MES_HTTP="${MES_HTTP:-http://127.0.0.1:8124}"
ERP_HTTP="${ERP_HTTP:-http://127.0.0.1:8126}"
AGENT_PORT="${AGENT_PORT:-8127}"
WMS_PORT="${WMS_PORT:-8128}"
ADAPTER_MODE="${ADAPTER_MODE:-all}"

echo ">>> 启动 MES 主进程 :${PORT:-8124} (APC_ENABLED=1 执行级闭环已点亮；ADAPTER_MODE=$ADAPTER_MODE 真实协议适配器已接主轴)"
APC_ENABLED=1 ADAPTER_MODE="$ADAPTER_MODE" MES_WS="$MES_WS" MES_HTTP="$MES_HTTP" "$NODE" server.js &
MES_PID=$!

# 等待 MES 就绪（健康检查通过）再拉起依赖进程——否则 ERP/WMS 会与 MES 抢共享配置库锁，
# 出现 "database is locked" 崩溃（2026-09-01 真机实测 WMS 启动竞态）。最多等 60s，不阻塞。
MES_HEALTH="${MES_HTTP:-http://127.0.0.1:8124}/api/health"
echo ">>> 等待 MES 就绪 (${MES_HEALTH}) ..."
for i in $(seq 1 30); do
  if curl -sf --max-time 2 "$MES_HEALTH" >/dev/null 2>&1; then
    echo ">>> MES 就绪 (${i}x2s)"
    break
  fi
  sleep 2
done

echo ">>> 启动 门户静态进程 :8123"
MES_WS="$MES_WS" MES_HTTP="$MES_HTTP" PORTAL_PORT="${PORTAL_PORT:-8123}" "$NODE" portal.js &
PORTAL_PID=$!

echo ">>> 启动 ERP 进程 :8126"
MES_WS="$MES_WS" MES_HTTP="$MES_HTTP" ERP_PORT="${ERP_PORT:-8126}" "$NODE" fab-erp.js &
ERP_PID=$!

echo ">>> 启动 对话式 Agent 进程 :$AGENT_PORT"
MES_HTTP="$MES_HTTP" ERP_HTTP="$ERP_HTTP" AGENT_PORT="$AGENT_PORT" "$NODE" agent/chat-server.js &
AGENT_PID=$!

echo ">>> 启动 EAP 协议网关 :8125"
MES_WS="$MES_WS" MES_HTTP="$MES_HTTP" EAP_PORT="${EAP_PORT:-8125}" "$NODE" eap-host.js &
EAP_PID=$!

echo ">>> 启动 WMS 仓储执行域 :$WMS_PORT"
MES_WS="$MES_WS" MES_HTTP="$MES_HTTP" WMS_PORT="$WMS_PORT" "$NODE" fab-wms.js &
WMS_PID=$!

# 3D 数字孪生已并入 fab-mes/twin3d/，由 portal(:8123) 统一托管，无需独立进程
# 访问： http://127.0.0.1:8123/twin3d/

echo ">>> 进程已启动 (MES=$MES_PID PORTAL=$PORTAL_PID ERP=$ERP_PID AGENT=$AGENT_PID EAP=$EAP_PID WMS=$WMS_PID)"
echo "    对话页 : http://127.0.0.1:${PORTAL_PORT:-8123}/agent.html"
echo "    3D孪生 : http://127.0.0.1:${PORTAL_PORT:-8123}/twin3d/"
echo "    WMS    : http://127.0.0.1:${PORTAL_PORT:-8123}/wms-ops.html"
echo "    停止： kill $MES_PID $PORTAL_PID $ERP_PID $AGENT_PID $EAP_PID $WMS_PID"

trap "kill $MES_PID $PORTAL_PID $ERP_PID $AGENT_PID $EAP_PID $WMS_PID 2>/dev/null" EXIT INT TERM
wait
