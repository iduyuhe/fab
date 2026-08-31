// EAP Host 验证：Select 在线 / S1F1 轮询 / S6F11 事件翻译
const http = require('http');
const get = p => new Promise(res => http.get('http://127.0.0.1:8125' + p, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res({ code: r.statusCode, body: JSON.parse(b) })); }));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let ok = true;
  const check = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra ? '  ' + extra : '')); if (!c) ok = false; };

  // 等待 EAP 全部设备上线（MES/网关重启后 EAP 有 5s 重连窗口）
  let online = 0;
  for (let i = 0; i < 12; i++) {
    const hh = await get('/api/health');
    online = hh.body.online || 0;
    if (online === 3) break;
    await sleep(1000);
  }
  check('3 台设备全部在线(Select)', online === 3, `online=${online}/3`);

  await sleep(2000);
  const d = await get('/api/devices');
  const devs = d.body.devices;
  check('设备视图 3 条', devs.length === 3);
  const allS1F1 = devs.every(x => x.lastS1F1);
  check('S1F1 轮询已收到应答', allS1F1, devs.map(x => `${x.name}:${x.lastS1F1 ? '✓' : '—'}`).join(' '));

  console.log('  等待 S6F11 设备事件（LITHO-001/ETCH-015/DEP-030 状态变化频繁）…');
  await sleep(8000);
  const e = await get('/api/events?limit=50');
  const statusEvts = e.body.events.filter(x => x.type === 'toolStatus');
  check('S6F11 事件已翻译为 toolStatus', statusEvts.length > 0, `收到 ${e.body.count} 条，其中状态事件 ${statusEvts.length} 条`);
  if (statusEvts[0]) {
    const s = statusEvts[0];
    check('事件含设备与状态', !!s.id && !!s.status && s.ceid >= 1000, `${s.id} → ${s.status} (CEID ${s.ceid})`);
  }

  console.log(ok ? '\n=== 全部通过 ===' : '\n=== 存在失败 ===');
  process.exitCode = ok ? 0 : 1;
})();
