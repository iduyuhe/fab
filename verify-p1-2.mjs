// P1-2 验收：APC setpoint 经 EAP S2F41 真实回灌设备（修正版）
// 真凭：MES /api/secs 的 deviceParams 被改写（证明 S2F41 真到达设备并应用）
//      + EAP /api/devices 的 lastSetpoint（证明 EAP 在收到 apcSetpoint 后真发命令）
// 注：S2F41 参数为 ASCII 字符串，设备存为字符串，比较需按 Number 解析。
import { setTimeout as sleep } from 'node:timers/promises';

const MES = process.env.MES_HTTP || 'http://127.0.0.1:8124';
const EAP = process.env.EAP_HTTP || 'http://127.0.0.1:8125';
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

console.log('== P1-2 验收：APC setpoint 真实回灌设备 ==');

// 0) 健康检查（EAP 在事件风暴下 HTTP 偶发饥饿，用 /api/devices 探活更稳）
await waitFor('MES 探活', async () => (await jget(`${MES}/api/health`)).ok ? true : null);
await waitFor('EAP 探活', async () => { const d = await jget(`${EAP}/api/devices`); return d && d.devices ? true : null; });

// 0.5) 降低 EAP 事件总线负荷：关 MES 自动投料（与 P0 温和验证一致），避免 EAP WS 处理函数被淹没
const cfg = await jpost(`${MES}/api/config`, { autoWo: false });
console.log(`  · MES 自动投料切换: ${JSON.stringify(cfg).slice(0, 80)}`);

// 1) 全链路 Test A：APC 自动收敛 → bus apcSetpoint → EAP S2F41 → 设备 LITHO-001(设备1) 参数 CD=95
console.log('\n[Test A] APC advise(target=100, predicted=110 → setpoint 应=95) → EAP→S2F41→设备');
const adv = await jpost(`${MES}/api/apc/advise`, { tool: 'LITHO-001', param: 'CD', target: 100, predicted: 110 });
console.log('  APC 返回:', JSON.stringify(adv).slice(0, 200));
ok(adv && numEq(adv.adjust, -5), `APC 计算 adjust=-5 (实际 ${adv && adv.adjust})`);

const aSet = await waitFor('设备1(CD)被 S2F41 改写', async () => {
  const s = await jget(`${MES}/api/secs`);
  const dp = (s.deviceParams && (s.deviceParams['1'] || s.deviceParams[1]));
  return dp && dp.CD && numEq(dp.CD.value, 95) ? dp.CD : null;
});
ok(!!aSet, `MES /api/secs deviceParams[1].CD.value === 95（S2F41 真到达设备并应用，实测 ${aSet && aSet.value}）`);

const aEap = await waitFor('EAP 记录 LITHO-001 setpoint', async () => {
  const d = await jget(`${EAP}/api/devices`);
  const dev = (d.devices || []).find(x => x.deviceId === 1);
  return dev && dev.lastSetpoint && numEq(dev.lastSetpoint.setpoint, 95) && dev.lastSetpoint.ack === 0 ? dev.lastSetpoint : null;
});
ok(!!aEap, `EAP /api/devices 设备1 lastSetpoint={param:${aEap && aEap.param}, setpoint:${aEap && aEap.setpoint}, ack:${aEap && aEap.ack}}（EAP 真发 S2F41）`);

// 2) 交付腿 Test B：直接经主轴 /api/mes/emit 注入 apcSetpoint → ETCH-015(设备2) THK=123.4
console.log('\n[Test B] 直接注入 apcSetpoint(ETCH-015, THK=123.4) → EAP→S2F41→设备2');
const inj = await jpost(`${MES}/api/mes/emit`, { type: 'apcSetpoint', tool: 'ETCH-015', param: 'THK', setpoint: 123.4, source: 'test' });
console.log('  emit 返回:', JSON.stringify(inj));

const bSet = await waitFor('设备2(THK)被 S2F41 改写', async () => {
  const s = await jget(`${MES}/api/secs`);
  const dp = (s.deviceParams && (s.deviceParams['2'] || s.deviceParams[2]));
  return dp && dp.THK && numEq(dp.THK.value, 123.4) ? dp.THK : null;
});
ok(!!bSet, `MES /api/secs deviceParams[2].THK.value === 123.4（交付腿 S2F41 生效，实测 ${bSet && bSet.value}）`);

const bEap = await waitFor('EAP 记录 ETCH-015 setpoint', async () => {
  const d = await jget(`${EAP}/api/devices`);
  const dev = (d.devices || []).find(x => x.deviceId === 2);
  return dev && dev.lastSetpoint && numEq(dev.lastSetpoint.setpoint, 123.4) && dev.lastSetpoint.ack === 0 ? dev.lastSetpoint : null;
});
ok(!!bEap, `EAP /api/devices 设备2 lastSetpoint={param:${bEap && bEap.param}, setpoint:${bEap && bEap.setpoint}, ack:${bEap && bEap.ack}}`);

// 3) 主轴 setpointApplied 事件（佐证闭环回发，best-effort：高频风暴下可能被 200 行窗口挤出）
console.log('\n[Test C] 主轴 setpointApplied 事件存在性（best-effort）');
const evs = await jget(`${MES}/api/events?limit=500`);
const all = (evs.events || []);
const applied = all.filter(e => e.type === 'setpointApplied');
console.log(`  最近 ${all.length} 条事件中 setpointApplied ×${applied.length}（样本: ${JSON.stringify(applied.slice(0, 2)).slice(0, 160)}）`);
console.log(`  · 注：高频风暴下事件可能被滚动窗口挤出，deviceParams+lastSetpoint 已为权威证据`);

console.log(`\n== P1-2 结果：通过 ${pass} / 失败 ${fail} ==`);
process.exit(fail === 0 ? 0 : 1);
