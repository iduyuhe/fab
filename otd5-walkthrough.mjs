#!/usr/bin/env node
'use strict';
/**
 * OTD-5 式「人工走查」演示脚本
 * --------------------------------------------------------------
 * 模拟一个用户在控制台里一步步操作，证明 OTD 与 NPI 两条主流「好做易做」：
 *   1) 打开控制台 (console.html)        —— 接单建 SO
 *   2) 订单驱动生产自动投料              —— 批次出现在 MES 控制台
 *   3) 订单沿主轴流转 → 发运 → 回款闭环  —— SO 状态 OPEN→…→CLOSED + AR 发票
 *   4) 打开 NPI 管理台 (npi-ops.html)    —— 选设计档案 → 一键投放工程批
 *   5) 工程批沿同一条 MES 主轴推进至完工  —— 孪生/控制台实时可见
 *
 * 与控制台/孪生页完全同源：所有 /api/* 走门户 8123，WS 总线订阅门户 8123（与孪生页同一条源）。
 * 运行：node otd5-walkthrough.mjs
 */
import { WebSocket } from 'ws';
import net from 'net';
import fs from 'fs';

const PORTAL = '127.0.0.1';
const PORT   = 8123;
const BASE   = `http://${PORTAL}:${PORT}`;
const WSURL  = `ws://${PORTAL}:${PORT}`;
const sleep  = ms => new Promise(r => setTimeout(r, ms));

// ---------- 结果收集 ----------
const R = [];
function step(name, ok, detail) {
  R.push({ name, ok, detail });
  const t = ok ? '\x1b[32m✅\x1b[0m' : '\x1b[31m❌\x1b[0m';
  console.log(`${t} [${name}] ${detail}`);
}

// ---------- HTTP ----------
async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch (_) { try { data = await r.text(); } catch (_) {} }
  return { status: r.status, data };
}
async function getPage(path) {
  const r = await fetch(BASE + path);
  return r.status;
}

// ---------- 事件总线（与孪生页同源 8123）----------
const tracked = new Set();      // 我们这次走查涉及的 lot id
const busLog  = [];             // 总线里属于我们 lot 的事件
let ws;
function connectBus() {
  ws = new WebSocket(WSURL);
  ws.on('message', d => {
    try {
      const e = JSON.parse(d);
      const key = e.lot || e.id || null;
      if (key && tracked.has(key)) busLog.push({ ts: Date.now(), e });
    } catch (_) {}
  });
}
function busTypes() {
  const s = new Set(busLog.map(b => b.e.type));
  return [...s];
}

// ---------- 端口探活 ----------
function probe(ports) {
  return Promise.all(ports.map(p => new Promise(res => {
    const s = net.connect(p, PORTAL);
    s.setTimeout(600);
    s.on('connect', () => { s.destroy(); res([p, true]); });
    s.on('timeout', () => { s.destroy(); res([p, false]); });
    s.on('error', () => res([p, false]));
  })));
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  OTD-5 式人工走查演示：OTD 接单→交付  ×  NPI 设计→流片');
  console.log('  全部经门户 8123（与控制台/孪生页同源），证明「好做易做」');
  console.log('══════════════════════════════════════════════════════════════\n');

  // 0. 端口探活
  const ports = [5000, 8123, 8124, 8125, 8126, 8127, 8128];
  const up = await probe(ports);
  const down = up.filter(([, o]) => !o).map(([p]) => p);
  step('0.栈探活', down.length === 0, down.length ? `未起: ${down.join(',')}` : `7/7 端口 UP (${ports.join(',')})`);
  if (down.length) { finish(); return; }

  // 降噪：关闭自动投料洪流 + 适度加速，便于干净走查（运行时开关，结束恢复）
  await req('POST', '/api/config', { autoWo: false, speed: 1200 });
  connectBus();
  await sleep(300);

  // 1. 打开控制台
  const consoleStatus = await getPage('/');
  step('1.打开控制台', consoleStatus === 200, `GET / (console.html) → ${consoleStatus}`);

  // ───────────────────────── OTD 主流 ─────────────────────────
  console.log('\n── OTD 主线：接单 → 投料 → 流转 → 发运 → 回款 ──');

  // 2. 在控制台「新建销售订单」
  const so = await req('POST', '/api/erp/so', { customer: 'CUS-WALK', product: 'N2', qty: 25, dueHours: 12 });
  const soId = so.data && so.data.id;
  step('2.建单 SO', !!soId && so.status === 200, `POST /api/erp/so → ${soId}` + (soId ? ` · 自动投料 ${so.data.lots} 批` : ''));
  if (!soId) { finish(); return; }

  // 3. 自动投料：批次出现在 MES 控制台
  let otdLot = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const lots = await req('GET', '/api/lots');
    const mine = (lots.data.lots || []).filter(l => l.soId === soId);
    if (mine.length) { otdLot = mine[0].id; break; }
  }
  step('3.自动投料可见', !!otdLot, otdLot ? `批次 ${otdLot} 已出现在 MES 控制台 (soId=${soId})` : '未找到归属该 SO 的批次');
  if (otdLot) tracked.add(otdLot);

  // 4. 实时观察 + SO 状态机推进
  console.log('   实时订阅事件总线 (ws://8123) 并轮询 SO 状态…');
  let lastStatus = '';
  let arrived = { IN_TRANSIT: false, DELIVERED: false, CLOSED: false };
  let arAmount = null;
  for (let i = 0; i < 80; i++) {
    await sleep(1500);
    const list = await req('GET', '/api/erp/so');
    const found = (list.data.sos || []).find(x => x.id === soId);
    const st = found ? found.status : '(未找到)';
    if (st !== lastStatus) {
      console.log(`     t≈${((i + 1) * 1.5).toFixed(1)}s  SO 状态 = ${st}`);
      lastStatus = st;
    }
    if (otdLot && i % 6 === 0) {
      const lv = await req('GET', '/api/lots/' + encodeURIComponent(otdLot));
      if (lv.data && lv.data.status) {
        console.log(`         ↳ 批次 ${otdLot} status=${lv.data.status} step=${lv.data.step}/${lv.data.rem != null ? lv.data.step + lv.data.rem : '?'} (实时推进中)`);
        if (lv.data.status === 'HOLD') { await req('POST', '/api/spc/release', { lot: otdLot }); console.log(`         ↳ 解除 SPC 停线（PQE 复核放行）${otdLot}`); }
      }
    }
    if (st === 'IN_TRANSIT') arrived.IN_TRANSIT = true;
    if (st === 'DELIVERED')  arrived.DELIVERED = true;
    if (st === 'CLOSED')     { arrived.CLOSED = true; break; }
    if (i % 4 === 0) {
      const ar = await req('GET', '/api/erp/ar?status=ALL');
      const inv = (ar.data.invoices || []).filter(x => x.so_id === soId);
      if (inv.length) arAmount = inv[0];
    }
  }
  step('4.OTD 状态机贯通', arrived.CLOSED,
    `SO ${soId}: IN_TRANSIT=${arrived.IN_TRANSIT} DELIVERED=${arrived.DELIVERED} CLOSED=${arrived.CLOSED}`);
  step('4b.回款闭环', !!arAmount,
    arAmount ? `AR 发票 ${arAmount.id} 金额=${arAmount.amount} 状态=${arAmount.status}` : '未生成 AR 发票');

  // ───────────────────────── NPI 主流 ─────────────────────────
  console.log('\n── NPI 主线：设计档案 → 工程批 → 流片批（同一条 MES 主轴）──');

  // 5. 打开 NPI 管理台
  const npiStatus = await getPage('/npi-ops.html');
  step('5.打开 NPI 管理台', npiStatus === 200, `GET /npi-ops.html → ${npiStatus}`);

  // 6. 选设计档案
  const des = await req('GET', '/api/designs');
  const designs = des.data.designs || [];
  step('6.设计档案', designs.length > 0, `GET /api/designs → ${designs.length} 个 (${designs.map(d => d.id + '/' + d.product).join(', ')})`);
  const d0 = designs.find(d => d.id === 'DES-002') || designs[0];
  if (!d0) { finish(); return; }

  // 7. 一键投放工程批
  const eng = await req('POST', '/api/npi/launch', { designId: d0.id, type: 'engineering', qty: 1 });
  const engWo = eng.data && eng.data.wo;
  const engRoute = (eng.data && eng.data.route) || [];
  step('7.投放工程批', !!engWo && eng.status === 201,
    `POST /api/npi/launch {${d0.id},engineering} → WO ${engWo && engWo.id} · 路线 ${engRoute.length} 步`);

  // 8. 工程批出现在 NPI 列表并沿主轴推进
  let engLot = null;
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    const ls = await req('GET', '/api/npi/lots');
    const mine = (ls.data.lots || []).filter(l => l.design_id === d0.id && l.product_type === 'engineering');
    if (mine.length) { engLot = mine[0].id; break; }
  }
  step('8.工程批可见', !!engLot, engLot ? `工程批 ${engLot} 已出现在 NPI 列表 (design=${d0.id})` : '未在 NPI 列表找到工程批');
  if (engLot) tracked.add(engLot);

  // 9. 工程批推进至完工（实时）
  let engDone = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const ls = await req('GET', '/api/npi/lots');
    const mine = (ls.data.lots || []).filter(l => l.design_id === d0.id && l.product_type === 'engineering');
    const lot = mine.find(l => l.id === engLot) || mine[0];
    if (lot) {
      if (i % 3 === 0 || lot.status === 'DONE')
        console.log(`     t≈${((i + 1) * 1.5).toFixed(1)}s  工程批 ${lot.id} status=${lot.status} step=${lot.step}/${lot.routeLen}`);
      if (lot.status === 'HOLD') { await req('POST', '/api/spc/release', { lot: lot.id }); console.log(`     ↳ 解除 SPC 停线（PQE 复核放行）${lot.id}`); }
      if (lot.status === 'DONE') { engDone = true; break; }
    }
  }
  step('9.工程批完工', engDone, engDone ? `工程批 ${engLot} 已沿 MES 主轴流转至 DONE` : `工程批 ${engLot} 仍在推进（实时可见，未达 DONE）`);

  // 10. 一键投放流片批（含资格验证重入，证明 NPI→流片闭环）
  const tap = await req('POST', '/api/npi/launch', { designId: d0.id, type: 'tapeout', qty: 1 });
  const tapWo = tap.data && tap.data.wo;
  step('10.投放流片批', !!tapWo && tap.status === 201,
    `POST /api/npi/launch {${d0.id},tapeout} → WO ${tapWo && tapWo.id} (qualification 重入)`);
  if (tapWo) {
    const ls = await req('GET', '/api/npi/lots');
    const tapLot = (ls.data.lots || []).find(l => l.design_id === d0.id && l.product_type === 'tapeout');
    if (tapLot) tracked.add(tapLot.id);
  }

  // ───────────────── 实时可见性证明 ─────────────────
  console.log('\n── 孪生 / 控制台实时可见性证明 ──');
  const pages = [
    ['/fab-twin.html', '装备级孪生'],
    ['/line-twin.html', '产线孪生'],
    ['/twin3d/index.html', '3D 数字孪生'],
    ['/console.html', 'MES 控制台'],
    ['/npi-ops.html', 'NPI 管理台'],
  ];
  let allPages = true;
  for (const [p, label] of pages) {
    const s = await getPage(p);
    if (s !== 200) allPages = false;
    console.log(`     ${label.padEnd(8)} GET ${p} → ${s}`);
  }
  step('11.孪生/控制台可加载', allPages, '五大实时页均经门户 8123 返回 200');
  step('12.事件总线实时贯通', busLog.length > 0,
    `总线捕获到本次走查批次事件 ${busLog.length} 条，类型=[${busTypes().join(', ')}]（孪生页订阅同一总线即实时可见）`);

  // 汇总
  finish();
}

function finish() {
  const pass = R.filter(r => r.ok).length;
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  走查结论：${pass}/${R.length} 通过`);
  const fails = R.filter(r => !r.ok);
  if (fails.length) {
    console.log('  未通过：');
    fails.forEach(f => console.log(`    - [${f.name}] ${f.detail}`));
  } else {
    console.log('  全部通过 —— OTD 接单→交付 与 NPI 设计→流片 两条主流均「好做易做」✅');
  }
  console.log('══════════════════════════════════════════════════════════════\n');

  // 恢复现场（运行期开关，不影响落盘）
  try { req('POST', '/api/config', { autoWo: true, speed: 180 }); } catch (_) {}
  try { if (ws) ws.close(); } catch (_) {}

  // 生成 HTML 报告
  try { writeReport(pass, R, busTypes()); } catch (e) { console.log('报告生成失败:', e.message); }
  process.exit(fails.length ? 1 : 0);
}

function writeReport(pass, results, busTypes) {
  const rows = results.map(r =>
    `<tr class="${r.ok ? 'ok' : 'bad'}"><td>${r.name}</td><td>${r.ok ? '✅' : '❌'}</td><td>${esc(r.detail)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>OTD-5 人工走查报告</title>
<style>body{font-family:system-ui,'Microsoft YaHei',sans-serif;background:#f5f7fa;margin:0;padding:24px;color:#1f2937}
h1{font-size:22px}table{border-collapse:collapse;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)}
th,td{padding:10px 12px;border-bottom:1px solid #eee;text-align:left;font-size:14px}
th{background:#1e3a8a;color:#fff}.ok{color:#16a34a}.bad{color:#dc2626}
.sum{margin:16px 0;font-size:18px;font-weight:700}
.flow{background:#fff;padding:16px;border-radius:8px;margin-bottom:16px;line-height:1.9;font-size:14px}.flow b{color:#1e3a8a}</style></head><body>
<h1>fab-mes OTD-5 式人工走查报告</h1>
<div class="flow"><b>走查路径：</b>打开控制台 → 建销售订单(SO)→ 自动投料 → 主轴流转 → 发运 → 回款(CLOSED) ｜ 打开 NPI 管理台 → 选设计档案 → 投放工程批 → 沿同主轴推进至 DONE → 投放流片批(资格验证)。全程事件经门户 8123 同一 WS 总线，孪生/控制台实时可见。</div>
<div class="sum">结果：${pass}/${results.length} 通过</div>
<table><thead><tr><th>步骤</th><th>结果</th><th>证据</th></tr></thead><tbody>${rows}</tbody></table>
<div style="margin-top:16px;font-size:14px">事件总线本次走查捕获类型：<b>${busTypes.join(', ') || '（无）'}</b></div>
</body></html>`;
  fs.writeFileSync('otd5-walkthrough-report.html', html);
  console.log('报告已生成: otd5-walkthrough-report.html');
}
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

main().catch(e => { console.error('走查异常:', e); process.exit(1); });
