// P1-3 验收：VM 虚拟量测预测经主轴事件驱动 APC 控制步（VM→APC 量测→控制子闭环）
// 真凭：注入一条 vmPrediction 事件 → APC 自动反应 → apcSetpoint（主轴上）→ EAP S2F41 → 设备参数被改写。
// 与 P1-2 不同，此处 APC 触发源是 vmPrediction（总线事件）而非手动 /api/apc/advise，证明 VM→APC 为总线驱动。
// 第3条断言改用 MES WebSocket 总线实时捕获 apcSetpoint（权威，不受 /api/events 滚动窗口挤出影响）。
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';

const MES = process.env.MES_HTTP || 'http://127.0.0.1:8124';
const EAP = process.env.EAP_HTTP || 'http://127.0.0.1:8125';
const MES_WS = process.env.MES_WS || 'ws://127.0.0.1:8124';
const jget = async (u) => { try { const r = await fetch(u); return await r.json().catch(() => ({})); } catch (_) { return {}; } };
const jpost = async (u, b) => { try { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return await r.json().catch(() => ({})); } catch (_) { return {}; } };
const num = (x) => (typeof x === 'number' ? x : parseFloat(x));
const numEq = (a, b, eps = 0.01) => Math.abs(num(a) - num(b)) <= eps;

async function waitFor(label, fn, timeoutMs = 25000, intervalMs = 700) {
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

console.log('== P1-3 验收：VM→APC 总线驱动闭环 ==');

await waitFor('MES 探活', async () => (await jget(`${MES}/api/health`)).ok ? true : null);
await waitFor('EAP 探活', async () => { const d = await jget(`${EAP}/api/devices`); return d && d.devices ? true : null; });

// 降载：关 MES 自动投料，避免事件风暴淹没 EAP WS 处理
await jpost(`${MES}/api/config`, { autoWo: false });
console.log('  · 已关 MES 自动投料以降载');

// 订阅 MES 事件总线（实时捕获 apcSetpoint，权威证据）
const captured = [];
const ws = new WebSocket(MES_WS);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
ws.on('message', (buf) => { try { const e = JSON.parse(buf.toString()); if (e && e.type) captured.push(e); } catch (_) {} });
console.log('  · 已订阅 MES 总线（实时捕获 apcSetpoint）');

// 注入一条 VM 预测：LITHO-001(设备1) 参数 P13CHK，pred=230 / target=200 → 相对残差 0.15 远超 deadband(0.05)
// → adjust=-0.5*(230-200)=-15 → setpoint=200-15=185
// 注意：用 210/200 会落在 deadband 边界(rel=0.05=deadband)导致 inDeadband 不动作，故取明显超阈的 230。
const PRED = 230, TGT = 200, EXPECT = 185;
console.log(`\n[VM→APC] 注入 vmPrediction(LITHO-001, P13CHK, pred=${PRED}, target=${TGT}) → 期望设备 setpoint=${EXPECT}`);
const inj = await jpost(`${MES}/api/mes/emit`, { type: 'vmPrediction', tool: 'LITHO-001', param: 'P13CHK', pred: PRED, target: TGT, product: 'N2', lot: 'TEST-P13', cold: false });
console.log('  emit 返回:', JSON.stringify(inj));

// 断言1：MES 设备参数被改写（VM→APC→apcSetpoint→EAP→S2F41→设备）
const set = await waitFor('设备1(P13CHK)被 S2F41 改写', async () => {
  const s = await jget(`${MES}/api/secs`);
  const dp = (s.deviceParams && (s.deviceParams['1'] || s.deviceParams[1]));
  return dp && dp.P13CHK && numEq(dp.P13CHK.value, EXPECT) ? dp.P13CHK : null;
});
ok(!!set, `MES /api/secs deviceParams[1].P13CHK.value === ${EXPECT}（VM预测经总线驱动 APC→设备回灌，实测 ${set && set.value}）`);

// 断言2：EAP 记录了该 setpoint（证明 EAP 收到 apcSetpoint 并真发 S2F41）
const eap = await waitFor('EAP 记录 LITHO-001 setpoint', async () => {
  const d = await jget(`${EAP}/api/devices`);
  const dev = (d.devices || []).find(x => x.deviceId === 1);
  return dev && dev.lastSetpoint && numEq(dev.lastSetpoint.setpoint, EXPECT) && dev.lastSetpoint.ack === 0 ? dev.lastSetpoint : null;
});
ok(!!eap, `EAP /api/devices 设备1 lastSetpoint={param:${eap && eap.param}, setpoint:${eap && eap.setpoint}, ack:${eap && eap.ack}}（EAP 真发 S2F41）`);

// 断言3：APC 确实由 vmPrediction 触发——实时总线捕获到 apcSetpoint(P13CHK)（权威证据，不依赖滚动窗口）
const apcSet = await waitFor('总线实时捕获 apcSetpoint(P13CHK)', async () => {
  const hit = captured.find(e => e.type === 'apcSetpoint' && e.param === 'P13CHK');
  return hit || null;
}, 15000, 300);
ok(!!apcSet, `MES 总线实时捕获 apcSetpoint(P13CHK)：setpoint=${apcSet && apcSet.setpoint}，source=${apcSet && apcSet.source}（VM→APC 总线驱动闭环成立）`);

ws.close();
console.log(`\n== P1-3 结果：通过 ${pass} / 失败 ${fail} ==`);
console.log('  · 结论：VM 虚拟量测预测以 vmPrediction 事件上主轴，直接驱动 APC 控制步→setpoint 回灌设备，量测→控制子闭环贯通。');
process.exit(fail === 0 ? 0 : 1);
