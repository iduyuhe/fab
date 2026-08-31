#!/usr/bin/env bash
# 统一回归套件启动器：依次运行 P0 + P1-1..P1-5 验收脚本并汇总。
# 用法：
#   bash bin/regress.sh            # 跑全部
#   bash bin/regress.sh --skip-p0  # 只跑 P1 组（快速）
#   bash bin/regress.sh --only=P1-3
set -u
NODE="C:/Users/35657/.workbuddy/binaries/node/versions/22.22.2/node.exe"
# 切到仓库根目录后以相对路径调用 verify-all.mjs，规避 MSYS 对绝对路径的二次转换
# （曾导致 E:\e\Fab 这类错误路径）。verify-all.mjs 自身用 __dirname 解析子脚本，与 cwd 无关。
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
exec "$NODE" verify-all.mjs "$@"
