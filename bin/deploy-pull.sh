#!/usr/bin/env bash
# deploy-pull.sh — 开发机 push 到 GitHub 后，在服务器上一步拉取并重启 fab-mes
# 用法（在服务器或经 SSH 执行）： bash /opt/fab-mes/bin/deploy-pull.sh
set -e
cd /opt/fab-mes
echo ">>> git pull (ff-only, main)"
git pull --ff-only origin main
echo ">>> restart fab-mes"
systemctl restart fab-mes
echo ">>> waiting for ports (8s)..."
sleep 8
echo ">>> listening 82xx ports:"
ss -ltnp 2>/dev/null | grep -E '82(0[0-9]|1[0-9])' | awk '{print $4}' | sort
echo ">>> MES health:"
curl -s http://127.0.0.1:8204/api/health || echo "(mes not ready yet)"
echo
echo ">>> done. 公网: https://fab.weomnitech.com.cn/"
