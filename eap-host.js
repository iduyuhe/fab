// ============================================================
//  自研 EAP Host —— SECS/GEM 协议消费方（Host 侧）
//  连接 fab-mes 的 HSMS 设备模拟网关(:5000)，扮演真实 EAP 角色：
//    Select 会话协商 · S1F1 周期轮询 · S2F17 对时 · 订阅 S6F11 事件
//  → 把设备事件翻译为标准事件（toolStatus 等），REST :8125 暴露 EAP 视角
//  将来接真实机台：只需把 HSMS_HOST/HSMS_PORT 指向机台地址，代码零改动
//  启动：node eap-host.js
// ============================================================
const net = require('net');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { enc, dec } = require('./secs-gem');

const HSMS_HOST = process.env.HSMS_HOST || '127.0.0.1';
const HSMS_PORT = +(process.env.HSMS_PORT || 5000);
const REST_PORT = +(process.env.EAP_PORT || 8125);
const POLL_MS = 5000;                          // S1F1 轮询周期
const RECONNECT_MS = 5000;
const DEVICES = [1, 2, 3];                     // 网关的 deviceId
const DEV_NAME = { 1: 'LITHO-001', 2: 'ETCH-015', 3: 'DEP-060' };
const DEV_ID_BY_NAME = {}; Object.entries(DEV_NAME).forEach(([id, n]) => { DEV_ID_BY_NAME[n] = +id; }); // tool→deviceId 反查（P1-2）
const CEID_MAP = { 1001: 'RUN', 1002: 'IDLE', 1003: 'PM', 1004: 'DOWN', 2001: 'LOT_START', 2002: 'LOT_DONE' };

const log = m => console.log(`[${new Date().toTimeString().slice(0, 8)}][EAP] ${m}`);

// ---- HSMS 客户端（Host 侧，每设备一个会话） ----
class HsmsClient {
  constructor(deviceId) {
    this.deviceId = deviceId; this.name = DEV_NAME[deviceId];
    this.sock = null; this.buf = Buffer.alloc(0); this.sys = 0x2000;
    this.connected = false; this.online = false;
    this.lastS1F1 = 0; this.lastEvent = null; this.events = [];
    this.traffic = [];                                  // 协议交互记录（控制台展示）
    this.lastSetpoint = null;                           // P1-2：最近一次经 S2F41 回灌的 setpoint
    this._pollTimer = null; this._closed = false;
  }
  pushTraffic(dir, label, detail) {
    this.traffic.push({ t: Date.now(), dir, label, detail });
    if (this.traffic.length > 100) this.traffic.shift();
  }
  start() { this.connect(); }
  connect() {
    this.sock = net.connect(HSMS_PORT, HSMS_HOST, () => {
      log(`${this.name}: TCP 已连接 → Select.req`);
      this.sendControl(0x01, ++this.sys);
    });
    this.sock.on('data', d => this._onData(d));
    this.sock.on('close', () => {
      this.connected = false; this.online = false;
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
      log(`${this.name}: 连接断开，${RECONNECT_MS / 1000}s 后重连`);
      if (!this._closed) setTimeout(() => this.connect(), RECONNECT_MS);
    });
    this.sock.on('error', e => log(`${this.name}: 连接错误 ${e.message}`));
  }
  stop() { this._closed = true; if (this.sock) this.sock.destroy(); }
  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      const frame = this.buf.slice(4, 4 + len); this.buf = this.buf.slice(4 + len);
      this._onFrame(frame);
    }
  }
  _onFrame(f) {
    const sType = f[5], sys = f.readUInt32BE(6);
    if (sType === 0x02) {                                     // Select.rsp
      let code = -1; try { code = dec(f.slice(10)).item.v[0]; } catch (_) {}
      this.connected = code === 0; this.online = code === 0;
      log(`${this.name}: Select.rsp ${code === 0 ? '成功 ✓' : '失败(' + code + ')'}`);
      this.pushTraffic('RX', 'Select.rsp', code === 0 ? '会话建立成功' : 'ACK=' + code);
      if (code === 0) { this.pollS1F1(); this.pollTime(); this._pollTimer = setInterval(() => this.pollS1F1(), POLL_MS); }
    } else if (sType === 0x00) {
      const stream = f[2] & 0x7F, fn = f[3];
      if (stream === 6 && fn === 11) this._onS6F11(f);
      else if (stream === 1 && fn === 2) { this.lastS1F1 = Date.now(); this.pushTraffic('RX', 'S1F2', this._fmt(f)); }
      else if (stream === 2 && fn === 18) { this.pushTraffic('RX', 'S2F18', this._fmt(f)); }
      else if (stream === 2 && fn === 42) {                 // S2F42 Remote Command ACK
        let ack = -1; try { const b = dec(f.slice(10)).item.v[0].v; ack = Buffer.isBuffer(b) ? b[0] : +b; } catch (_) {}
        this.pushTraffic('RX', 'S2F42', 'ACK=' + ack);
        log(`${this.name}: S2F42 ACK=${ack}`);
        if (this._pendingCmd) { const r = this._pendingCmd.resolve; this._pendingCmd = null; r(ack); }
      }
    } else if (sType === 0x0A) { this.pushTraffic('RX', 'Linktest.rsp', ''); log(`${this.name}: Linktest.rsp`); }
  }
  _onS6F11(f) {
    try {
      const msg = dec(f.slice(10)).item;                       // L[3]{U4 CEID, A DTID, L[...]}
      const ceid = msg.v[0].v;
      const mapped = CEID_MAP[ceid] || ('CEID' + ceid);
      const isLot = mapped === 'LOT_START' || mapped === 'LOT_DONE';
      // lot 生命周期事件用独立 type 上主线（避免被 toolStatus 状态枚举拒绝）；其余归 toolStatus
      const ev = { t: Date.now(), id: this.name, ceid,
        type: isLot ? (mapped === 'LOT_START' ? 'lotStart' : 'lotDone') : 'toolStatus',
        status: isLot ? 'RUN' : mapped };
      this.lastEvent = ev; this.events.push(ev);
      if (this.events.length > 200) this.events.shift();   // 背压：事件缓冲封顶 200，避免无界增长
      this.pushTraffic('RX', 'S6F11', `CEID=${ceid} → ${ev.type}/${ev.status}`);
      log(`${this.name}: S6F11 CEID=${ceid} → ${ev.type}/${ev.status}`);
      forwardToMES(ev);
    } catch (e) { log(`${this.name}: S6F11 解析失败 ${e.message}`); }
  }
  sendControl(sType, sys) { this.pushTraffic('TX', sType === 0x01 ? 'Select.req' : 'Control(' + sType + ')', ''); this._send(sType, sys, Buffer.alloc(0), 0, 0); }
  // S2F41 远程控制：发命令并等待 S2F42 ACK
  sendRemoteCommand(rcmd, params = []) {
    return new Promise((resolve, reject) => {
      const sys = ++this.sys;
      this._pendingCmd = { sys, resolve };
      const body = enc({ t: 'L', v: [{ t: 'A', v: String(rcmd) }, { t: 'L', v: params.map(p => ({ t: 'A', v: String(p) })) }] });
      this._send(0x00, sys, body, 2, 41);
      this.pushTraffic('TX', 'S2F41', `RCMD=${rcmd}`);
      log(`${this.name}: S2F41 RCMD=${rcmd} 已发送`);
      setTimeout(() => { if (this._pendingCmd && this._pendingCmd.sys === sys) { this._pendingCmd = null; reject(new Error('S2F42 超时')); } }, 5000);
    });
  }
  pollS1F1() { if (this.connected) { this.pushTraffic('TX', 'S1F1', 'Are You There'); this._send(0x00, ++this.sys, enc({ t: 'L', v: [] }), 1, 1); } }
  pollTime() { if (this.connected) { this.pushTraffic('TX', 'S2F17', 'Date/Time'); this._send(0x00, ++this.sys, enc({ t: 'L', v: [] }), 2, 17); } }
  _send(sType, sys, body, stream, fn) {
    if (!this.sock || !this.sock.writable) return;
    const h = Buffer.alloc(10);
    h.writeUInt16BE(this.deviceId, 0);
    h[2] = stream & 0x7F; h[3] = fn; h[4] = 0; h[5] = sType;
    h.writeUInt32BE(sys, 6);
    const m = Buffer.concat([h, body || Buffer.alloc(0)]);
    const l = Buffer.alloc(4); l.writeUInt32BE(m.length, 0);
    this.sock.write(Buffer.concat([l, m]));
  }
  _fmt(f) { try { return JSON.stringify(dec(f.slice(10)).item); } catch (_) { return '?'; } }
}

// ---- EAP 服务：REST + WS ----
const MES_INGEST = process.env.MES_INGEST || 'http://127.0.0.1:8124/api/ingest';
// EAP→MES 事件桥：把翻译后的标准事件推入 MES（真实接机时的事件入口）
function forwardToMES(ev) {
  try {
    const data = JSON.stringify({ type: ev.type, id: ev.id, status: ev.status });
    const u = new URL(MES_INGEST);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, r => r.resume());
    req.on('error', () => {});
    req.end(data);
    log(`→ MES ingest: ${ev.id} → ${ev.status}`);
  } catch (e) { log(`MES 转发失败: ${e.message}`); }
}
const clients = DEVICES.map(d => new HsmsClient(d));
const wss = new WebSocketServer({ noServer: true });
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };
const handler = (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  // EAP 控制台（静态页面）
  if (u.pathname === '/' || u.pathname === '/eap-console.html') {
    const fs = require('fs');
    fs.readFile(path.join(__dirname, 'eap-console.html'), (err, data) => {
      if (err) return json(res, 500, { error: 'eap-console.html missing' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  if (u.pathname === '/api/health') return json(res, 200, {
    service: 'eap-host', version: 'M3-EAP', host: `${HSMS_HOST}:${HSMS_PORT}`,
    online: clients.filter(c => c.online).length, total: clients.length,
    pollMs: POLL_MS, uptime: +process.uptime().toFixed(1) });
  if (u.pathname === '/api/devices') return json(res, 200, {
    devices: clients.map(c => ({ deviceId: c.deviceId, name: c.name, online: c.online,
      connected: c.connected, lastS1F1: c.lastS1F1 ? new Date(c.lastS1F1).toISOString() : null,
      lastEvent: c.lastEvent ? { ...c.lastEvent, t: new Date(c.lastEvent.t).toISOString() } : null,
      lastSetpoint: c.lastSetpoint })) });
  if (u.pathname === '/api/events') {
    const limit = Math.min(200, +(u.searchParams.get('limit') || 50));
    const all = clients.flatMap(c => c.events.map(e => ({ device: c.name, ...e }))).sort((a, b) => b.t - a.t).slice(0, limit);
    return json(res, 200, { count: all.length, events: all });
  }
  // 协议交互流（控制台）
  if (u.pathname === '/api/traffic') {
    const limit = Math.min(300, +(u.searchParams.get('limit') || 120));
    const all = clients.flatMap(c => c.traffic.map(t => ({ device: c.name, ...t }))).sort((a, b) => b.t - a.t).slice(0, limit);
    return json(res, 200, { count: all.length, traffic: all });
  }
  // 控制面：EAP 下发远程命令（S2F41）
  if (/^\/api\/devices\/\d+\/control$/.test(u.pathname) && req.method === 'POST') {
    const deviceId = +u.pathname.split('/')[3];
    const c = clients.find(x => x.deviceId === deviceId);
    if (!c) return json(res, 404, { error: 'no device ' + deviceId });
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let cfg = {}; try { cfg = body ? JSON.parse(body) : {}; } catch (_) {}
      const rcmd = cfg.rcmd || 'ABORT';
      c.sendRemoteCommand(rcmd, cfg.params || []).then(ack =>
        json(res, 200, { device: c.name, rcmd, ack, ackOk: ack === 0 })).catch(e =>
        json(res, 500, { error: e.message }));
    });
    return;
  }
  return json(res, 404, { error: 'not found' });
};
const server = http.createServer(handler);
server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)));
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'hello', service: 'eap-host' }));
  const push = ev => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'eapEvent', ...ev })); };
  clients.forEach(c => { c.events.slice(-20).forEach(push); });
  const iv = setInterval(() => { clients.forEach(c => { if (c.lastEvent) push(c.lastEvent); }); }, 2000);
  ws.on('close', () => clearInterval(iv));
});

server.listen(REST_PORT, () => {
  log(`EAP Host 已启动（SECS/GEM 消费方）`);
  log(`  网关  : ${HSMS_HOST}:${HSMS_PORT}（设备模拟器，将来换真实机台地址）`);
  log(`  REST  : http://127.0.0.1:${REST_PORT}/api/{health,devices,events}`);
  log(`  WS    : ws://127.0.0.1:${REST_PORT} (EAP 视角事件流)`);
  log(`  设备  : ${DEVICES.map(d => DEV_NAME[d]).join(', ')}`);
});
clients.forEach(c => c.start());

// P1-2：订阅 MES 事件总线，消费 APC 收敛后的 setpoint，经 S2F41 SET_PARAM 真实回灌设备
// （串主轴：APC→总线 apcSetpoint→EAP→S2F41→设备参数模型，而非仅展示）
const MES_WS = process.env.MES_WS || 'ws://127.0.0.1:8124';
let mesWs = null;
function connectMesBus() {
  try {
    mesWs = new WebSocket(MES_WS);
    mesWs.on('open', () => log(`已订阅 MES 事件总线 ${MES_WS}（消费 apcSetpoint → S2F41 SET_PARAM）`));
    mesWs.on('message', (data) => {
      let ev; try { ev = JSON.parse(data); } catch (_) { return; }
      if (!ev || ev.type !== 'apcSetpoint') return;        // 仅响应 APC setpoint，避免误动作/回环
      const did = DEV_ID_BY_NAME[ev.tool]; if (did == null) return;
      const c = clients.find(x => x.deviceId === did); if (!c) return;
      c.sendRemoteCommand('SET_PARAM', [String(ev.param), String(ev.setpoint)])
        .then(ack => {
          c.lastSetpoint = { param: ev.param, setpoint: ev.setpoint, ack, ts: Date.now() };
          log(`S2F41 SET_PARAM → ${c.name}: ${ev.param}=${ev.setpoint} ACK=${ack}`);
        })
        .catch(e => log(`SET_PARAM 失败 ${c.name}: ${e.message}`));
    });
    mesWs.on('close', () => { log('MES 总线断开，5s 后重连'); setTimeout(connectMesBus, 5000); });
    mesWs.on('error', () => {});
  } catch (e) { setTimeout(connectMesBus, 5000); }
}
connectMesBus();
