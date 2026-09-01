// 本地资源压力实测（轮询版，不 spawn 子进程）：
// 假定 server 已由外部在 PORT(默认8401) 启动。用 /api/governor 增量 CPU 换算单核占用率。
// 阶段 A：连 WS（模拟用户盯看板）→ tick 保持高频；阶段 B：断 WS + 停轮询 90s → tick 降频。
// 安全熔断：任一样本单核占用 >120%（≈1.2 核）立即退出，绝不真把风扇点着。
'use strict';
const http = require('http');
const WebSocket = require('ws');
const PORT = +(process.env.PORT || 8401);

function getGov() {
  return new Promise(res => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/api/governor', timeout: 4000 }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } });
    }).on('error', () => res(null)).on('timeout', () => { try { r.destroy(); } catch (_) {} res(null); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (g, win) => ((g.cpu.userMs + g.cpu.systemMs) / win * 100);

(async () => {
  let ok = false;
  for (let i = 0; i < 40; i++) { const g = await getGov(); if (g && g.memRssMb) { ok = true; break; } await sleep(1000); }
  if (!ok) { console.log('SERVER NOT UP on :' + PORT); process.exit(1); }
  console.log('=== SERVER UP (assumed external) ===');

  const ws = new WebSocket('ws://127.0.0.1:' + PORT);
  await new Promise(r => { ws.on('open', r); ws.on('error', r); });
  console.log('=== PHASE A：BUSY（WS 已连，模拟用户盯看板，tick 高频） ===');
  let maxBusy = 0, sumBusy = 0, nBusy = 0, maxRss = 0;
  for (let i = 0; i < 20; i++) {
    const g = await getGov();
    if (g) {
      const cpuPct = pct(g, 3000);
      maxBusy = Math.max(maxBusy, cpuPct); sumBusy += cpuPct; nBusy++;
      maxRss = Math.max(maxRss, g.memRssMb);
      console.log(`A t=${i * 3}s cpu=${cpuPct.toFixed(1)}% rss=${g.memRssMb}MB heap=${g.memHeapMb}MB wip=${g.wip ? g.wip.wip : '?'} autoWoPaused=${g.autoWo ? g.autoWo.paused : '?'} atCap=${g.autoWo ? g.autoWo.atCap : '?'}`);
      if (cpuPct > 120) { console.log('!! 安全熔断：CPU 单核>120%，退出'); ws.close(); process.exit(2); }
    }
    await sleep(3000);
  }
  ws.close();
  await sleep(1000);

  console.log('=== PHASE B：IDLE（断 WS、停轮询 90s，tick 应降频） ===');
  await sleep(90000);
  const g2 = await getGov();
  let idlePct = null;
  if (g2) {
    idlePct = pct(g2, 90000);
    console.log(`B idleWindow cpu=${idlePct.toFixed(2)}% rss=${g2.memRssMb}MB heap=${g2.memHeapMb}MB wip=${g2.wip ? g2.wip.wip : '?'} idleForMs=${g2.idleForMs} idle=${g2.idle}`);
  }

  const avgBusy = nBusy ? sumBusy / nBusy : 0;
  console.log('=== SUMMARY ===');
  console.log(`BUSY  avg=${avgBusy.toFixed(1)}%  max=${maxBusy.toFixed(1)}%  (单核占用率)`);
  console.log(`IDLE  ${idlePct == null ? '?' : idlePct.toFixed(2) + '%'}  (单核占用率, 90s 窗口)`);
  console.log(`RSS   max=${maxRss}MB`);
  const busyOk = maxBusy < 120;
  const idleOk = idlePct == null ? false : idlePct < 40;
  console.log(busyOk && idleOk ? 'VERDICT: CPU 已封顶 —— 风扇不应再狂转' : 'VERDICT: CPU 仍偏高 —— 需继续排查');
  process.exit(0);
})();
