#!/usr/bin/env bash
# ============================================================
#  阶段0 启动编排（§6.4）：MES(8124) + 门户(8123) + ERP(8126)
#  APS 阶段0 仍内置于 MES，可选独立进程注释于末尾。
#  用法： bash bin/start-all.sh   (在 fab-mes/ 目录下)
#  依赖：NODE 指向 Node 22（含 node:sqlite）
# ============================================================
set -e
cd "$(dirname "$0")/.."

NODE="${NODE:-C:/Users/35657/.workbuddy/binaries/node/versions/22.22.2/node.exe}"
MES_WS="${MES_WS:-ws://127.0.0.1:8124}"
MES_HTTP="${MES_HTTP:-http://127.0.0.1:8124}"

echo ">>> 启动 MES 主进程 :8124"
MES_WS="$MES_WS" MES_HTTP="$MES_HTTP" "$NODE" server.js &
MES_PID=$!

echo ">>> 启动 门户静态进程 :8123"
MES_WS="$MES_WS" MES_HTTP="$MES_HTTP" PORTAL_PORT="${PORTAL_PORT:-8123}" "$NODE" portal.js &
PORTAL_PID=$!

echo ">>> 启动 ERP 进程 :8126"
MES_WS="$MES_WS" MES_HTTP="$MES_HTTP" ERP_PORT="${ERP_PORT:-8126}" "$NODE" fab-erp.js &
ERP_PID=$!

echo ">>> 启动 EAP 协议网关 :8125"
MES_WS="$MES_WS" MES_HTTP="$MES_HTTP" EAP_PORT="${EAP_PORT:-8125}" "$NODE" eap-host.js &
EAP_PID=$!

# 3D 数字孪生已并入 fab-mes/twin3d/，由 portal(:8123) 统一托管，无需独立进程
# 访问： http://127.0.0.1:8123/twin3d/

echo ">>> 进程已启动 (MES=$MES_PID PORTAL=$PORTAL_PID ERP=$ERP_PID EAP=$EAP_PID)"
echo "    对话页 : http://127.0.0.1:${PORTAL_PORT:-8123}/agent.html"
echo "    3D孪生 : http://127.0.0.1:${PORTAL_PORT:-8123}/twin3d/"
echo "    停止： kill $MES_PID $PORTAL_PID $ERP_PID $EAP_PID"

trap "kill $MES_PID $PORTAL_PID $ERP_PID $EAP_PID 2>/dev/null" EXIT INT TERM
wait
