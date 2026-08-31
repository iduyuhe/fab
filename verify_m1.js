// M1 端到端验证：WS 收事件 + REST 查历史（SQLite 落库确认）
const http = require('http');
const WebSocket = require('E:/Fab/fab-mes/node_modules/ws');

const ws = new WebSocket('ws://127.0.0.1:8124');
const counts = {}; const samples = [];
const t0 = Date.now();
let done = false;

ws.on('message', d => {
  const ev = JSON.parse(d.toString());
  counts[ev.type] = (counts[ev.type] || 0) + 1;
  if (samples.length < 4) samples.push(ev);
  if (!done && Date.now() - t0 > 3000) {
    done = true;
    ws.close();
    console.log('WS 事件分布(3s):', JSON.stringify(counts));
    console.log('事件样例:', JSON.stringify(samples, null, 1));
    // REST 历史查询（SQLite）
    http.get('http://127.0.0.1:8124/api/events?limit=5', r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => {
        const d2 = JSON.parse(b);
        console.log('REST /api/events: count=' + d2.count);
        d2.events.forEach(e => console.log('  seq=' + e.seq, e.type, e.id || e.from || ''));
        // 类型覆盖断言
        const ok = counts.toolStatus > 0 || counts.toolMetric > 0;
        console.log(ok ? 'PASS: WS 事件流正常' : 'FAIL: 无设备事件');
        console.log(d2.count > 0 ? 'PASS: SQLite 事件已落库' : 'FAIL: 事件未落库');
        process.exit(ok && d2.count > 0 ? 0 : 1);
      });
    });
  }
});
ws.on('error', e => { console.error('WS ERROR', e.message); process.exit(1); });
