// ============================================================
//  fab-erp — 原生 ERP 服务（独立进程入口）
//  ------------------------------------------------------------
//  逻辑已迁入 services/erp-service.js（MES 底座与独立进程共用）。
//  本文件仅作 standalone 入口：bash bin/start-*.sh 默认仍独立拉起，
//  保留"原生 ERP 可独立交付"的产品能力。
//  若需 in-proc 并入 MES 底座，由 server.js require erp-service 完成。
// ============================================================
'use strict';
const { createErpService } = require('./services/erp-service');

const PORT = process.env.ERP_PORT || 8126;
const svc = createErpService({ inProc: false });
svc.listen(PORT);
