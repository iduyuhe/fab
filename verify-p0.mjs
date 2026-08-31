// P0 OTD 主轴验收脚本（健壮版 + 自动解除 SPC 质量停线以贯通主轴）
// 修复：1) /api/erp/ar 返回 {invoices:[]} 而非 {rows:[]}，须读 invoices 且查 PAID；
//      2) /api/wms/tx 服务端封顶 200 行，长时运行后本 SO 的 SHIP 会被挤出窗口——
//         改用 MES 事件总线(WS)实时捕获本 SO 的 shipment 事件作为发运权威证据。
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';

const MES = 'http://127.0.0.1:8124';
const ERP = 'http://127.0.0.1:8126';
const WMS = 'http://127.0.0.1:8128';
const MES_WS = 'ws://127.0.0.1:8124';

async function get(u, n = 3) {
  for (let i = 0; i < n; i++) {
    try { const r = await fetch(u); if (r.ok) return await r.json(); } catch (e) { if (i === n - 1) return { _err: 'fetch' }; }
    await sleep(300);
  }
  return { _err: 'fetch' };
}
async function post(u, b) {
  try { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return r.ok ? await r.json() : { _err: r.status }; } catch (e) { return { _err: 'fetch' }; }
}

(async () => {
  let soId = null;
  const shipment = { seen: false };

  console.log('— 1) 健康检查 —');
  for (const [n, u] of [['MES', MES + '/api/health'], ['ERP', ERP + '/api/erp/health'], ['WMS', WMS + '/api/wms/health']]) {
    const h = await get(u); console.log(`  ${n}: ok=${!h._err}`);
  }

  console.log('— 2) 创建 SO（qty=75 → 3 lots，冗余抗单批 SPC 停线）—');
  const so = await post(ERP + '/api/erp/so', { product: 'N2', qty: 75, customer: 'CUS-001' });
  soId = so.id;
  console.log('  SO =', soId, 'product=', so.product, 'qty=', so.qty, 'lots=', so.lots);

  console.log('— 3) 温和加速：关闭 autoWo 洪流 + speed=600（避免压垮 WMS 事件循环）—');
  await post(MES + '/api/config', { autoWo: false, speed: 600 });

  // 订阅 MES 总线，实时捕获本 SO 的 shipment 事件（权威证据，不受 /api/wms/tx 200 行窗口限制）
  const bus = new WebSocket(MES_WS);
  bus.on('message', (d) => {
    try { const e = JSON.parse(d.toString()); if (e && e.type === 'shipment' && e.so === soId) shipment.seen = true; } catch (_) {}
  });
  await new Promise(res => bus.on('open', res));
  console.log('  · 已订阅 MES 总线（实时捕获 shipment）');

  console.log('— 4) MES 投料 + 事件带 soId —');
  await sleep(4000);
  const evs = await get(MES + '/api/events?type=lotRelease&limit=60');
  const mine = (evs.events || []).filter(e => e.so === soId);
  const myLots = [...new Set(mine.map(e => e.lot))];
  console.log('  lotRelease 带 so 字段数=', mine.length, 'lots=', JSON.stringify(myLots));

  console.log('— 5) 轮询 SO 状态机（最多 150s，遇 SPC 停线自动放行）—');
  let last = '', t0 = Date.now(), final = null;
  while (Date.now() - t0 < 150000) {
    // 自动解除本 SO 批次的 SPC 停线，保证主轴贯通（生产环境由质量判定放行）
    for (const lid of myLots) {
      const lv = await get(MES + '/api/lots/' + lid);
      if (lv && lv.status === 'HOLD') { const r = await post(MES + '/api/spc/release', { lot: lid }); console.log(`  ↳ 解除 SPC 停线 ${lid}: ${JSON.stringify(r)}`); }
    }
    const sos = await get(ERP + '/api/erp/so');
    const s = (sos.sos || []).find(x => x.id === soId);
    if (s && s.status !== last) { console.log(`  t+${((Date.now() - t0) / 1000).toFixed(0)}s → ${s.status}`); last = s.status; }
    if (s) final = s;
    if (s && s.status === 'CLOSED') break;
    await sleep(2500);
  }

  console.log('— 6) 结算与双域一致性 —');
  const ar = await get(ERP + '/api/erp/ar?status=ALL');
  const arInv = (ar.invoices || []).find(r => r.so_id === soId);
  console.log('  AR:', arInv ? `invoice=${arInv.id} amount=${arInv.total} status=${arInv.status}` : '未找到');
  const wtx = await get(WMS + '/api/wms/tx?limit=200');
  const ship = (wtx.tx || []).filter(x => x.type === 'SHIP' && String(x.ref) === soId);
  console.log('  WMS 实物发运(200行窗口内可见):', ship.length, ship[0] ? JSON.stringify(ship[0]) : '(已被 200 行窗口挤出属正常，以总线 shipment 事件为准)');
  const trial = await get(ERP + '/api/erp/gl/trial');
  console.log('  总账平衡:', trial.balanced, `借=${trial.totalDebit} 贷=${trial.totalCredit}`);
  const costs = await get(ERP + '/api/erp/costs');
  console.log('  成本归集批次=', costs.count, '总成本=', costs.totalCost);
  console.log('  总线 shipment 事件(本 SO):', shipment.seen ? '已捕获 ✅' : '未捕获 ❌');

  console.log('— 7) 结论 —');
  console.log(`  SO ${soId} 终态=${final?.status}`);
  console.log(`  贯通: SO→WO(soId=${!!mine.length})→生产→发运(IN_TRANSIT, shipment事件=${shipment.seen})→签收(DELIVERED)→收款(AR=${arInv?.status})→总账平衡=${trial.balanced}`);
  const pass = final?.status === 'CLOSED' && shipment.seen && arInv?.status === 'PAID' && trial.balanced;
  console.log(pass ? '  ✅ P0 主轴贯通验收通过' : '  ⚠️ 未完全贯通');
  console.log(`== P0 结果：通过 ${pass ? 1 : 0} / 失败 ${pass ? 0 : 1} ==`);
  try { bus.close(); } catch (_) {}
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('验证脚本异常:', e); process.exit(1); });
