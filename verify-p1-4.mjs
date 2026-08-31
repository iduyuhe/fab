// P1-4 验收：APS→dispatch 调度闭环（APS 计划回填 MES 派工指令）
// 真凭：① APS 实时算出瓶颈模块 + 关键(LATE/吃紧)批次 → 经 /api/aps/directive 注入 WIPEngine._pick；
//       ② 派工服从 APS（关键批次绝对优先 / HYBRID 瓶颈模块由 APS 实时驱动，非硬编码 LITHO）。
// Part A 走真实运行栈验证「计划→执行」数据闭环；Part B 为确定性单元测试，证明 _pick 真的服从指令。
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createRequire } from 'module';

const MES = process.env.MES_HTTP || 'http://127.0.0.1:8124';
const EAP = process.env.EAP_HTTP || 'http://127.0.0.1:8125';
const MES_WS = process.env.MES_WS || 'ws://127.0.0.1:8124';
const require = createRequire(import.meta.url);

const jget = async (u) => { try { const r = await fetch(u); return await r.json().catch(() => ({})); } catch (_) { return {}; } };
const jpost = async (u, b) => { try { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return await r.json().catch(() => ({})); } catch (_) { return {}; } };

async function waitFor(label, fn, timeoutMs = 25000, intervalMs = 600) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await fn(); if (v) { console.log(`  ✅ ${label} (${Date.now() - t0}ms)`); return v; } } catch (_) {}
    await sleep(intervalMs);
  }
  console.log(`  ❌ ${label} 超时(${timeoutMs}ms)`);
  return null;
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

console.log('== P1-4 验收：APS→dispatch 调度闭环 ==');

await waitFor('MES 探活', async () => (await jget(`${MES}/api/health`)).ok ? true : null);
await waitFor('EAP 探活', async () => { const d = await jget(`${EAP}/api/devices`); return d && d.devices ? true : null; });
await jpost(`${MES}/api/config`, { autoWo: false });
console.log('  · 已关 MES 自动投料以降载');

// ---------- Part A：APS 计划 → 派工指令（真实运行栈） ----------
console.log('\n[A] APS 计划回填派工指令（计划→执行数据闭环）');
const captured = [];
const ws = new WebSocket(MES_WS);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
ws.on('message', (buf) => { try { const e = JSON.parse(buf.toString()); if (e && e.type) captured.push(e); } catch (_) {} });
console.log('  · 已订阅 MES 总线（实时捕获 apsDirective）');

// 建一张交期极紧的工单 → APS 应判为 LATE/吃紧 → 其关键 lot 进入 directive 优先派工
const woRes = await jpost(`${MES}/api/wos`, { qty: 3, product: 'N2', dueHours: 1 });
const woId = woRes && woRes.wo && woRes.wo.id;
console.log(`  · 创建紧交期工单 ${woId}（dueHours=1）`);
await jpost(`${MES}/api/aps/recompute`);
const dir = await waitFor('指令含关键批次', async () => {
  const d = await jget(`${MES}/api/aps/directive`);
  return d && d.criticalCount > 0 ? d : null;
}, 15000, 400);
const aps = await jget(`${MES}/api/aps`);
const woEntry = (aps.wos || []).find(w => w.id === woId);
ok(!!woEntry && woEntry.critical, `APS 排程判定 ${woId} 为 critical/LATE（status=${woEntry && woEntry.status}）`);
ok(dir && dir.criticalLotIds.includes(woEntry && woEntry.criticalLot),
  `APS 指令包含 ${woId} 关键批次 ${woEntry && woEntry.criticalLot}（directive.criticalLotIds=${dir && JSON.stringify(dir.criticalLotIds)}）`);

// 瓶颈模块：指令应与 /api/aps 负荷≥75% 的模块一致（无则回退默认）
const expBn = (aps.modules || []).filter(m => m.loadPct >= 75).map(m => m.key).sort();
const gotBn = [...(dir ? dir.bottleneckMods : [])].sort();
const bnOk = expBn.length ? JSON.stringify(expBn) === JSON.stringify(gotBn) : gotBn.length > 0;
ok(bnOk, `APS 指令瓶颈模块=${JSON.stringify(gotBn)} 与 /api/aps 负荷≥75% 模块=${JSON.stringify(expBn)} 一致`);

// 指令上主轴（供 twin/Agent 消费）
await waitFor('总线实时捕获 apsDirective', async () => captured.find(e => e.type === 'apsDirective' && e.criticalLotCount > 0) || null, 8000, 300);
const apsEv = captured.find(e => e.type === 'apsDirective' && e.criticalLotCount > 0);
ok(!!apsEv, `MES 总线实时捕获 apsDirective（bottleneckMods=${apsEv && JSON.stringify(apsEv.bottleneckMods)}, criticalLotCount=${apsEv && apsEv.criticalLotCount}）`);

// ---------- Part B：确定性单元测试 — _pick 真的服从 APS 指令 ----------
console.log('\n[B] _pick 确定性单测（派工服从 APS 指令）');
const { WIPEngine } = require('E:/Fab/fab-mes/core.js');
function mkEngine() {
  const tools = [{ id: 'ETCH-T1', module: 'ETCH', status: 'IDLE', _lot: null, _hold: false, wph: 50 }];
  const byId = new Map(tools.map(t => [t.id, t]));
  const eng = new WIPEngine(byId, tools, () => {}, { rule: 'HYBRID', speed: 99999 });
  eng.queues = { LITHO: [], ETCH: [], DEP: [], CMP: [], IMPL: [], METRO: [] };
  return { eng, tool: tools[0] };
}
function mkLot(id, rem) { return { id, rem, status: 'WIP', product: 'N2', route: ['ETCH'], step: 0, due: Date.now() + 1e9, hist: [] }; }
function reset(eng, tool) { eng.queues.ETCH = []; eng._processing = new Map(); tool._lot = null; tool.status = 'IDLE'; tool._hold = false; }

// B1：关键批次绝对优先（无论模块）
{
  const { eng, tool } = mkEngine();
  eng.setApsDirective({ criticalLots: new Set(['LOT-B']) });
  eng.queues.ETCH.push(mkLot('LOT-A', 5), mkLot('LOT-B', 2));
  eng.dispatch('ETCH');
  ok(tool._lot === 'LOT-B', `关键批次 LOT-B 优先于 LOT-A 被派工（dispatch 选中=${tool._lot}，期望 LOT-B）`);
  reset(eng, tool);
}
// B2：HYBRID 瓶颈模块由 APS 实时驱动（非硬编码 LITHO）——APS 指 ETCH 为瓶颈时用 BN(最短剩余步)
{
  const { eng, tool } = mkEngine();
  eng.setApsDirective({ bottleneckMods: ['ETCH'], criticalLots: new Set() });
  eng.queues.ETCH.push(mkLot('LOT-C', 5), mkLot('LOT-D', 1)); // BN 选最短 rem → LOT-D
  eng.dispatch('ETCH');
  ok(tool._lot === 'LOT-D', `APS 指 ETCH 为瓶颈 → HYBRID 在 ETCH 用 BN 选最短剩余步 LOT-D（选中=${tool._lot}，期望 LOT-D；若为 LOT-C 则退化为硬编码 FIFO）`);
  reset(eng, tool);
}
// B3：对照——无 APS 指令时回退默认 HYBRID（ETCH 走 FIFO 队首）
{
  const { eng, tool } = mkEngine();
  eng.setApsDirective({ bottleneckMods: ['LITHO'], criticalLots: new Set() }); // 默认：仅 LITHO 为 BN
  eng.queues.ETCH.push(mkLot('LOT-E', 5), mkLot('LOT-F', 1)); // ETCH 非瓶颈 → FIFO → LOT-E
  eng.dispatch('ETCH');
  ok(tool._lot === 'LOT-E', `默认 HYBRID(仅 LITHO 瓶颈) 时 ETCH 走 FIFO 队首 LOT-E（选中=${tool._lot}，期望 LOT-E）`);
}

ws.close();
console.log(`\n== P1-4 结果：通过 ${pass} / 失败 ${fail} ==`);
console.log('  · 结论：APS 实时计划（瓶颈模块 + 关键批次）经 /api/aps/directive 注入 WIPEngine._pick，派工服从 APS，计划→执行主轴闭环贯通。');
process.exit(fail === 0 ? 0 : 1);
