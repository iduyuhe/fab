// M3 验证：HSMS 会话协商 + S1F1/S2F17 + S6F11 事件报告（字节级）
const net = require('net');
const { enc, dec } = require('E:/Fab/fab-mes/secs-gem');

const L0 = enc({ t: 'L', v: [] });
const sock = net.connect(5000, '127.0.0.1');
let buf = Buffer.alloc(0); const rx = [];
sock.on('data', d => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) { const len = buf.readUInt32BE(0); if (buf.length < 4 + len) break; rx.push(buf.slice(4, 4 + len)); buf = buf.slice(4 + len); }
});
const send = (sType, sys, body, stream = 0, fn = 0, w = false, sessionId = 1) => {
  const h = Buffer.alloc(10);
  h.writeUInt16BE(sessionId, 0); h[2] = (w ? 0x80 : 0) | (stream & 0x7F); h[3] = fn; h[4] = 0; h[5] = sType;
  h.writeUInt32BE(sys, 6);
  const m = Buffer.concat([h, body || Buffer.alloc(0)]);
  const l = Buffer.alloc(4); l.writeUInt32BE(m.length, 0);
  sock.write(Buffer.concat([l, m]));
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const pop = (pred, timeout = 6000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const i = rx.findIndex(pred);
    if (i >= 0) { clearInterval(iv); res(rx.splice(i, 1)[0]); }
    else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('超时等帧')); }
  }, 50);
});

(async () => {
  let ok = true;
  const check = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra ? '  ' + extra : '')); if (!c) ok = false; };

  // 1) Select
  send(0x01, 1);
  const sel = await pop(f => f[5] === 0x02, 5000);
  const selBody = dec(sel.slice(10)).item;
  check('Select.rsp 协商成功', selBody.t === 'B' && selBody.v[0] === 0, `session=${sel.readUInt16BE(0) & 0x7FFF}`);

  // 2) S1F1
  send(0x00, 2, L0, 1, 1);
  const s1f2 = await pop(f => (f[2] & 0x7F) === 1 && f[3] === 2, 5000);
  const s1v = dec(s1f2.slice(10)).item.v;
  check('S1F2 身份应答', s1v && s1v[0] && s1v[0].t === 'A' && s1v[0].v === 'FAB-MES-GW', `MDLN=${s1v[0] ? s1v[0].v : '-'} SOFTREV=${s1v[1] ? s1v[1].v : '-'}`);

  // 3) S2F17
  send(0x00, 3, L0, 2, 17);
  const s2f18 = await pop(f => (f[2] & 0x7F) === 2 && f[3] === 18, 5000);
  const ts = dec(s2f18.slice(10)).item.v[0].v;
  check('S2F18 时间应答', /^\d{14}$/.test(String(ts)), `DT=${ts}`);

  // 4) S6F11 事件（等待 LITHO-001 状态事件，最多 20s）
  console.log('  等待 S6F11 事件（LITHO-001 派工/状态变化）…');
  const s6 = await pop(f => (f[2] & 0x7F) === 6 && f[3] === 11, 20000);
  const ev = dec(s6.slice(10)).item.v;
  const ceid = ev[0].v;
  check('S6F11 事件报告', ceid >= 1000, `CEID=${ceid} 数据=${JSON.stringify(ev[2] ? ev[2].v : [])}`);

  // 5) Linktest
  send(0x09, 9);
  const lt = await pop(f => f[5] === 0x0A, 5000);
  check('Linktest 应答', lt[5] === 0x0A);

  console.log(ok ? '\n=== 全部通过 ===' : '\n=== 存在失败 ===');
  sock.destroy();
  process.exitCode = ok ? 0 : 1;
})().catch(e => { console.error('ERROR', e.message); sock.destroy(); process.exit(1); });
