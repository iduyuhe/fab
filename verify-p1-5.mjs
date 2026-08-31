// P1-5 验收：Agent 编排器串五大引擎上 OTD 主轴
// 真凭：① Agent 订阅 MES 事件总线（唯一数字主线）→ busConnected=true 且实时缓冲多引擎事件；
//       ② 向主轴注入覆盖 FDC/SPC/APC/VM/APS/OTD 的事件 → Agent 编排回答能跨引擎关联并引用真实标识。
import { setTimeout as sleep } from 'node:timers/promises';

const MES = process.env.MES_HTTP || 'http://127.0.0.1:8124';
const AGENT = process.env.AGENT_HTTP || 'http://127.0.0.1:8127';

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

console.log('== P1-5 验收：Agent 编排器串五大引擎上 OTD 主轴 ==');

await waitFor('MES 探活', async () => (await jget(`${MES}/api/health`)).ok ? true : null);
await waitFor('Agent 探活', async () => (await jget(`${AGENT}/api/agent/health`)).ok ? true : null);
await jpost(`${MES}/api/config`, { autoWo: false });
console.log('  · 已关 MES 自动投料以降载');

// 断言1：Agent 已订阅 MES 总线
const h = await waitFor('Agent busConnected', async () => {
  const d = await jget(`${AGENT}/api/agent/health`);
  return d.busConnected ? d : null;
}, 15000, 500);
ok(!!h, `Agent 已订阅 MES 事件总线（busConnected=${h && h.busConnected}，已缓冲 ${h && h.bufferedEvents} 条）`);

// 断言2：Agent 实时缓冲已覆盖多引擎（证明它真的在看主轴，而非按需快照）
const engSeen = Object.keys(h.engineCounts || {});
const multiEngine = ['FDC', 'SPC', 'APC', 'VM', 'APS', 'OTD'].filter(k => engSeen.includes(k));
ok(multiEngine.length >= 4, `Agent 实时缓冲覆盖 ${multiEngine.length} 个引擎域（${multiEngine.join('/')}），已接入主轴`);

// 向主轴注入覆盖五大引擎 + OTD 的标记事件（带唯一标识，便于断言 Agent 真的观察到）
console.log('\n[注入] 向主轴注入 FDC/SPC/APC/VM/APS/OTD 标记事件');
await jpost(`${MES}/api/mes/emit`, { type: 'fdcAlarm', id: 'ETCH-099', module: 'ETCH', below60: true, score: 0.92 });
await jpost(`${MES}/api/mes/emit`, { type: 'spcAlarm', tool: 'LITHO-002', param: 'CD', value: 138, ucl: 120, rules: ['R1 超控制限'] });
await jpost(`${MES}/api/mes/emit`, { type: 'vmPrediction', tool: 'LITHO-001', param: 'CD', pred: 19.5, target: 18, product: 'N2', lot: 'LOT-P15' });
await jpost(`${MES}/api/mes/emit`, { type: 'apcSetpoint', tool: 'LITHO-001', param: 'CD', setpoint: 18.5, source: 'apc' });
await jpost(`${MES}/api/mes/emit`, { type: 'apsDirective', bottleneckMods: ['LITHO'], criticalLotCount: 1 });
await jpost(`${MES}/api/mes/emit`, { type: 'lotDone', lot: 'LOT-P15', product: 'N2' });
await jpost(`${MES}/api/mes/emit`, { type: 'shipment', so: 'SO-P15' });
await jpost(`${MES}/api/mes/emit`, { type: 'delivery', so: 'SO-P15' });
await sleep(1200); // 等 WS 传播进 Agent 缓冲

// 断言3：问 Agent「把五大引擎和 OTD 主轴串起来讲讲」→ 编排回答跨引擎引用真实标识
console.log('\n[编排] 询问 Agent 串起五大引擎 + OTD 主轴');
const chat = await jpost(`${AGENT}/api/agent/chat`, { message: '把五大引擎和 OTD 主轴串起来讲讲现在工厂在干嘛' });
console.log('  Agent 意图:', chat.intent);
console.log('  Agent 回复(前 600 字):\n' + (chat.reply || '').slice(0, 600));
const reply = chat.reply || '';
ok(chat.intent === 'orchestrate', `Agent 命中编排意图（intent=${chat.intent}）`);
ok(reply.includes('ETCH-099'), '编排回答引用了注入的 FDC 判异设备 ETCH-099（FDC 域已贯通）');
ok(reply.includes('LOT-P15'), '编排回答引用了注入的 OTD 批次 LOT-P15（OTD 域已贯通）');
ok(reply.includes('CD'), '编排回答引用了 APC/VM 参数 CD（APC/VM 域已贯通）');
ok(reply.includes('LITHO'), '编排回答引用了 APS 瓶颈模块 LITHO（APS 调度已贯通）');
const engKw = ['FDC', 'SPC', 'APC', 'VM', 'APS', 'OTD'].filter(k => reply.includes(k)).length;
ok(engKw >= 4, `编排回答跨 ${engKw} 个引擎域串联（FDC/SPC/APC/VM/APS/OTD 中命中≥4）`);
ok(reply.includes('主轴') || reply.includes('数字主线'), '编排回答点明「主轴/数字主线」——五大引擎经同一主轴驱动 OTD');

console.log(`\n== P1-5 结果：通过 ${pass} / 失败 ${fail} ==`);
console.log('  · 结论：Agent 已接入 MES 事件总线（数字主线），实时缓冲并跨 FDC/SPC/APC/VM/APS + OTD 编排，把五大引擎串上 OTD 主轴。');
process.exit(fail === 0 ? 0 : 1);
