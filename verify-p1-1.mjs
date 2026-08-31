// P1-1 验收：FDC 判异(fdcAlarm 上主轴) → 自动响应(fdcAutoResp + 跨引擎 pdmAlert)
// 注意：/api/events 忽略 type 参数，故用 after=baseSeq 隔离本次注入，再按 type/tool 客户端过滤。
const MES = 'http://127.0.0.1:8124';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(u, n = 30) { for (let i = 0; i < n; i++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch (e) { if (i === n - 1) return { _err: e.message }; } await sleep(400); } return { _err: 'timeout' }; }
async function post(u, b) { try { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return r.ok ? await r.json() : { _err: r.status }; } catch (e) { return { _err: e.message }; } }

(async () => {
  const h = await get(MES + '/api/health');
  if (h._err) { console.log('MES 未就绪', h); process.exit(1); }
  console.log('health ok, tools=', h.tools);
  await post(MES + '/api/config', { autoWo: false, speed: 600 });
  await sleep(800);

  // 取当前最大 seq 作为基线
  const base = await get(MES + '/api/events?limit=1');
  const baseSeq = (base.events && base.events[0] && base.events[0].seq) || 0;
  console.log('baseSeq=', baseSeq);

  console.log('— 注入 fdcAlarm（等价于真实 FDC 源经单一事件出口上主轴）—');
  const inj = await post(MES + '/api/mes/emit', {
    type: 'fdcAlarm', tool: 'TOOL-P1TEST', module: 'LITHO',
    below60: true, score: 1.7, mvThreshold: 1.2, contrib: [{ var: 'wph', weight: 1.7 }]
  });
  console.log('  inject:', JSON.stringify(inj));

  // 轮询新增事件，按 type/tool 过滤
  let fa = null, pa = null;
  for (let i = 0; i < 12; i++) {
    const r = await get(MES + `/api/events?after=${baseSeq}&limit=500`);
    const evs = r.events || [];
    fa = evs.find(e => e.type === 'fdcAutoResp' && e.tool === 'TOOL-P1TEST');
    pa = evs.find(e => e.type === 'pdmAlert' && e.tool === 'TOOL-P1TEST');
    if (fa && pa) break;
    await sleep(400);
  }
  console.log('  fdcAutoResp:', JSON.stringify(fa));
  console.log('  pdmAlert:', JSON.stringify(pa));
  const pass = !!fa && !!pa;
  console.log(pass ? '  ✅ P1-1 FDC→自动响应闭环通过（fdcAlarm → fdcAutoResp + pdmAlert 均落主轴）' : '  ⚠️ P1-1 未贯通');
  process.exit(pass ? 0 : 2);
})().catch(e => { console.error('P1-1 验证异常:', e); process.exit(1); });
