// ============================================================
//  fab-wms — 仓储执行域服务（独立进程入口）
//  ------------------------------------------------------------
//  逻辑已迁入 services/wms-service.js（与未来 in-proc 并入共用）。
//  本文件仅作 standalone 入口：bash bin/start-community.sh 默认仍独立拉起，
//  保留"WMS 可独立交付、与 ERP 财务台账域隔离"的产品能力。
//  若需 in-proc 并入 MES 底座，由 server.js require wms-service 完成。
// ============================================================
'use strict';
const { createWmsService } = require('./services/wms-service');

const PORT = process.env.WMS_PORT || 8128;
const svc = createWmsService({ inProc: false });
svc.listen(PORT);
