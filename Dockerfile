# 数智晶圆厂平台 — L1 社区级一键部署镜像
# 单容器多进程架构，匹配现有 bin/start-all.sh 编排
# WS 唯一事件源在 MES(:8124)，门户/ERP 均为订阅方
FROM node:22-slim

WORKDIR /app

# 复制全部项目文件（含 node_modules 与唯一运行时依赖 ws）
COPY . .

# 暴露端口：门户 8123 / MES 8124 / ERP 8126
EXPOSE 8123 8124 8126

# 环境变量（均可被 docker run -e 覆盖）
ENV PORT=8124 \
    PORTAL_PORT=8123 \
    ERP_PORT=8126 \
    MES_WS=ws://127.0.0.1:8124 \
    MES_HTTP=http://127.0.0.1:8124

# 容器内三个进程均在本机，MES_WS/MES_HTTP 指向容器回环即可
# 若需外部覆盖，可传入 MES_WS/MES_HTTP 指向 MES 端口映射地址
CMD ["bash", "bin/start-community.sh"]
