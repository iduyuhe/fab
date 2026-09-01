'use strict';
// ============================================================
//  采集频率配置（telemetry-config）—— 演示系统"科学合理采集"核心
// ------------------------------------------------------------
//  设计原则（用户定稿 2026-09-01）：
//   1. 自动化【关】→ 不做任何数据采集（采集循环全停，仅保留系统自保）。
//   2. 自动化【开】→ 以【最低】采集频率起步（默认值全部低频，够演示即可）。
//   3. 采集频率【由客户设置】→ 门户"主数据台 → 采集频率"面板可改，
//      存 fab-mes.db 的 telemetry_config 表，重启不丢，保存即生效。
//   4. 所有项默认值均可被 env 覆盖（部署层兜底）。
// ============================================================
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// ---- 默认采集频率（用户定稿 2026-09-01：默认采集时间统一 ≥30s，演示更稳更省资源） ----
const _env = (a, b, def) => +(process.env[a] ?? process.env[b] ?? def);
const DEFAULTS = {
  tickMs:        _env('TELE_TICK_MS', 'TICK_MS', 1000),        // 仿真心跳（产线动感引擎，非采集；客户可调）
  flushMs:       _env('TELE_FLUSH_MS', 'EVT_FLUSH_MS', 30000), // 事件批量落库
  autoWoMs:      _env('TELE_AUTOWO_MS', 'AUTO_WO_MS', 30000),  // 自动投料节奏
  predScanMs:    _env('TELE_PREDSCAN_MS', 'PRED_SCAN_MS', 60000), // 预测扫描
  apsMs:         _env('TELE_APS_MS', 'APS_RECOMPUTE_MS', 30000),  // APS 计划重算
  ldaMs:         _env('TELE_LDA_MS', 'LDA_WATCH_MS', 60000),   // LDA 设计导入轮询
  eapPollMs:     _env('TELE_EAP_POLL_MS', 'EAP_POLL_MS', 30000),  // EAP 设备轮询
  opcuaMs:       _env('TELE_OPCUA_MS', 'ADAPTER_OPCUA_MS', 30000), // OPC-UA 设备数据采集
  edaMs:         _env('TELE_EDA_MS', 'ADAPTER_EDA_MS', 30000),     // EDA 设备数据采集
  erpReplayMs:   _env('TELE_ERP_REPLAY_MS', 'ERP_REPLAY_MS', 30000), // ERP 事件重放
  wmsReplayMs:   _env('TELE_WMS_REPLAY_MS', 'WMS_REPLAY_MS', 30000), // WMS 事件重放
  wmsReplenishMs: _env('TELE_WMS_REPLENISH_MS', 'WMS_REPLENISH_MS', 60000), // WMS 补货巡检
};
const LABELS = {
  tickMs: '仿真心跳（产线动感）',
  flushMs: '事件批量落库',
  autoWoMs: '自动投料节奏',
  predScanMs: '预测扫描',
  apsMs: 'APS 计划重算',
  ldaMs: 'LDA 设计导入轮询',
  eapPollMs: 'EAP 设备轮询',
  opcuaMs: 'OPC-UA 设备数据采集',
  edaMs: 'EDA 设备数据采集',
  erpReplayMs: 'ERP 事件重放',
  wmsReplayMs: 'WMS 事件重放',
  wmsReplenishMs: 'WMS 补货巡检',
};
const NOTE = '单位：毫秒。默认采集时间统一不低于 30 秒（演示省资源、更稳定）；自动化关闭时不采集（这些项不生效）。客户可按演示需要调高/调低，保存即生效。';

const DB_PATH = process.env.FAB_DB_PATH || path.join(__dirname, '..', 'fab-mes.db');
let _overrides = {};        // DB 覆盖（客户设置）
let _storage = null;        // 由 server.js 注入（避免循环依赖）
const _listeners = new Set();

function loadFromDb() {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    db.exec('PRAGMA busy_timeout=3000;');
    try {
      const rows = db.prepare('SELECT key, value_ms FROM telemetry_config').all();
      for (const r of rows) { if (DEFAULTS[r.key] != null) _overrides[r.key] = r.value_ms; }
    } catch (_) { /* 表不存在则全默认 */ }
    db.close();
  } catch (_) { /* 库不可用时全默认 */ }
}

function get(key) { return _overrides[key] != null ? _overrides[key] : DEFAULTS[key]; }
function all() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    out[k] = { ms: get(k), defMs: DEFAULTS[k], label: LABELS[k] || k };
  }
  return out;
}

// 保存客户设置（白名单校验；写入 fab-mes.db telemetry_config 表并即时生效）
// 兼容两种入参：{ tickMs:{ms:500}, ... } 或 { items: { tickMs:{ms:500}, ... } }
function setAll(obj) {
  const src = (obj && obj.items && typeof obj.items === 'object') ? obj.items : obj;
  const accepted = {};
  for (const k of Object.keys(DEFAULTS)) {
    const v = src && src[k];
    const ms = Math.floor(+(v && v.ms != null ? v.ms : v));
    if (Number.isFinite(ms) && ms >= 100 && ms <= 3600000) accepted[k] = ms;
  }
  if (!Object.keys(accepted).length) return { ok: false, error: 'no valid keys' };
  _overrides = Object.assign({}, _overrides, accepted);
  try {
    const db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    db.exec('CREATE TABLE IF NOT EXISTS telemetry_config(key TEXT PRIMARY KEY, value_ms INTEGER, updated TEXT)');
    const upsert = db.prepare('INSERT OR REPLACE INTO telemetry_config(key,value_ms,updated) VALUES(?,?,?)');
    for (const [k, ms] of Object.entries(accepted)) upsert.run(k, ms, new Date().toISOString());
    db.close();
  } catch (_) { /* 落库失败仅本次不持久化，内存已生效 */ }
  for (const cb of _listeners) { try { cb(accepted); } catch (_) {} }
  return { ok: true, changed: accepted };
}

function onConfigChange(cb) { if (typeof cb === 'function') { _listeners.add(cb); return () => _listeners.delete(cb); } return () => {}; }
function defaults() { return Object.assign({}, DEFAULTS); }

module.exports = { DEFAULTS, get, all, setAll, loadFromDb, onConfigChange, defaults, LABELS, NOTE };
