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
const { syncFromMes } = require('./automation-flag');

const PORT = process.env.ERP_PORT || 8126;
const MES_HTTP = process.env.MES_HTTP || 'http://127.0.0.1:8124';
// 跨进程开关同步：ERP 独立进程跟随 MES 的自动化总开关（轻量 GET，默认 10s），
// 使"演示开闸/关闸"对 ERP 的自动接单/事件重放一致生效。
syncFromMes(MES_HTTP, +(process.env.AUTO_SYNC_MS || 10000));
const svc = createErpService({ inProc: false });
svc.listen(PORT);
