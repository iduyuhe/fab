// ============================================================
//  M3 — SECS/GEM 协议层 (SEMI E4/E5/E30/E37 子集)
//  HSMS 服务器（E37，默认端口 5000）+ SECS-II 编解码（E5）+ GEM 事件报告（E30）
//  角色：模拟设备侧（被 EAP Host 连接）。
//  将来对接真实机台：网关把 SECS 消息翻译为内部事件，上层语义不变。
//  支持消息：Select 协商 / S1F1→S1F2 / S2F17→S2F18 / S6F11 事件报告 / Linktest
// ============================================================
const net = require('net');

// ---- SECS-II 格式码（SEMI E5 标准：低 6 位类型码，高 2 位 = 长度字节数 00/01/10/11） ----
// 修正：标准表（与 secsgem 等实现一致）List=0x00/Binary=0x08/Boolean=0x09/ASCII=0x10/...
const T = { L: 0x00, B: 0x08, BOOLEAN: 0x09, A: 0x10, J8: 0x11, I8: 0x18, I1: 0x19, I2: 0x1A, I4: 0x1B,
  F8: 0x1C, F4: 0x1D, U8: 0x20, U1: 0x21, U2: 0x22, U4: 0x23 };
const WIDTH = { 0x18: 8, 0x19: 1, 0x1A: 2, 0x1B: 4, 0x1C: 8, 0x1D: 4, 0x20: 8, 0x21: 1, 0x22: 2, 0x23: 4 };
const SIG = { 0x18: true, 0x19: true, 0x1A: true, 0x1B: true, 0x1C: true, 0x1D: true };

// item: { t:'L', v:[items] } | { t:'A'|'B', v:string/Buffer } | { t:'U4', v:num } | { t:'I4', v:num } ...
function enc(item) {
  const fmt = T[item.t];
  if (fmt === undefined) throw new Error('unknown type ' + item.t);
  let body;
  if (item.t === 'L') { body = Buffer.concat(item.v.map(enc)); }
  else if (item.t === 'A') { body = Buffer.from(String(item.v), 'ascii'); }
  else if (item.t === 'B') { body = Buffer.isBuffer(item.v) ? item.v : Buffer.from(item.v); }
  else {
    const w = WIDTH[fmt];
    body = Buffer.alloc(w);
    if (SIG[fmt]) { if (w === 8) body.writeBigInt64BE(BigInt(Math.round(item.v)), 0); else body.writeIntBE(Math.round(item.v), 0, w); }
    else { if (w === 8) body.writeBigUInt64BE(BigInt(Math.round(item.v)), 0); else body.writeUIntBE(Math.round(item.v), 0, w); }
  }
  // 长度头（1~4 字节）
  let h;
  if (body.length <= 255) { h = Buffer.from([fmt, body.length]); }
  else if (body.length <= 65535) { h = Buffer.from([fmt | 0x40, body.length >> 8, body.length & 0xff]); }
  else { h = Buffer.from([fmt | 0x80, body.length >> 16 & 0xff, body.length >> 8 & 0xff, body.length & 0xff]); }
  return Buffer.concat([h, body]);
}
function dec(buf, off = 0) {
  const fmt = buf[off]; const type = fmt & 0x3F; const lenMode = fmt >> 6;
  let len, hlen;
  if (lenMode === 0) { len = buf[off + 1]; hlen = 2; }
  else if (lenMode === 1) { len = buf.readUInt16BE(off + 1); hlen = 3; }
  else if (lenMode === 2) { len = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]; hlen = 4; }
  else { len = buf.readUInt32BE(off + 1); hlen = 5; }
  const start = off + hlen;
  if (type === T.L) {
    const v = []; let p = start; const end = start + len;
    while (p < end) { const r = dec(buf, p); v.push(r.item); p = r.next; }
    return { item: { t: 'L', v }, next: end };
  }
  if (type === T.A) return { item: { t: 'A', v: buf.slice(start, start + len).toString('ascii') }, next: start + len };
  if (type === T.B) return { item: { t: 'B', v: Buffer.from(buf.slice(start, start + len)) }, next: start + len };
  const w = WIDTH[type]; let v;
  if (w === 8) { v = SIG[type] ? Number(buf.readBigInt64BE(start)) : Number(buf.readBigUInt64BE(start)); }
  else { v = SIG[type] ? buf.readIntBE(start, w) : buf.readUIntBE(start, w); }
  return { item: { t: Object.keys(T).find(k => T[k] === type), v }, next: start + w };
}
// HSMS Data 消息 body = 纯 SECS-II（stream/function 在 10 字节 header 的 byte2/3，不在 body 里）
const encMsg = (stream, fn, w, body) => enc({ t: 'L', v: body });

// ---- HSMS (E37) 服务器 ----
class SecsGemGateway {
  constructor(opts = {}) {
    this.port = opts.port || 5000;
    this.devices = opts.devices || { 1: 'LITHO-001', 2: 'ETCH-015', 3: 'DEP-030' }; // deviceId -> toolId
    this.sessions = new Map();          // socket -> deviceId
    this.sys = 0x1000;
    this.onLog = opts.onLog || (() => {});
    this.onControl = opts.onControl || null;   // (deviceId, rcmd, params) => ack
    this.deviceParams = {};                     // deviceId -> { param: { value, ts } } 设备工艺参数模型（P1-2 setpoint 回灌落点）
    this.server = null;
  }
  start() {
    this.server = net.createServer(sock => this._onConn(sock));
    this.server.listen(this.port, () => this.onLog(`HSMS 监听 :${this.port}（E37 子集：Select/S1F1/S2F17/S6F11）`));
  }
  _onConn(sock) {
    let buf = Buffer.alloc(0);
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const frame = buf.slice(4, 4 + len); buf = buf.slice(4 + len);
        this._onFrame(sock, frame);
      }
    });
    sock.on('close', () => { this.sessions.delete(sock); });
    sock.on('error', () => { this.sessions.delete(sock); });
  }
  _send(sock, sessionId, sType, sys, body, stream = 0, fn = 0, w = false) {
    const header = Buffer.alloc(10);
    header.writeUInt16BE(sessionId, 0);
    header[2] = (w ? 0x80 : 0) | (stream & 0x7F);
    header[3] = fn;
    header[4] = 0;                       // PType
    header[5] = sType;
    header.writeUInt32BE(sys, 6);
    const msg = Buffer.concat([header, body || Buffer.alloc(0)]);
    const len = Buffer.alloc(4); len.writeUInt32BE(msg.length, 0);
    sock.write(Buffer.concat([len, msg]));
  }
  _onFrame(sock, frame) {
    const sessionId = frame.readUInt16BE(0) & 0x7FFF;
    const sType = frame[5];
    const sys = frame.readUInt32BE(6);
    const body = frame.slice(10);
    if (sType === 0x01) {                                   // Select.req（控制消息 sessionId 标准为 0xFFFF）
      this.sessions.set(sock, sessionId);
      this._send(sock, 0xFFFF, 0x02, sys, enc({ t: 'B', v: [0] }));
      this.onLog(`设备 ${this.devices[sessionId] || sessionId} 已建立 HSMS 会话`);
    } else if (sType === 0x00) {                            // Data message
      const stream = frame[2] & 0x7F, fn = frame[3], wbit = !!(frame[2] & 0x80);
      this.sessions.set(sock, sessionId);                  // 数据阶段才确定真实设备 ID（Select 时为 0xFFFF）
      this._onData(sock, sessionId, sys, stream, fn, wbit, body);
    } else if (sType === 0x09) {                            // Linktest.req
      this._send(sock, sessionId, 0x0A, sys, Buffer.alloc(0));
    }
  }
  _onData(sock, sessionId, sys, stream, fn, wbit, body) {
    try {
      const msg = body.length ? dec(body) : { item: { t: 'L', v: [] } };   // 标准允许部分消息空 body
      const list = msg.item.v || [];
      if (stream === 1 && fn === 1) {                       // S1F1 Are You There
        const r = encMsg(1, 2, false, [
          { t: 'A', v: 'FAB-MES-GW' }, { t: 'A', v: 'M3.0' }, { t: 'L', v: [] },
        ]);
        this._send(sock, sessionId, 0x00, sys, r, 1, 2);
        // 轮询应答高频日志已降噪（EAP traffic 仍在展示）
      } else if (stream === 1 && fn === 13) {               // S1F13 Establish Communication（GEM 必备）
        const r = encMsg(1, 14, false, [{ t: 'B', v: [0] }, { t: 'L', v: [] }]);  // COMMACK=0 接受
        this._send(sock, sessionId, 0x00, sys, r, 1, 14);
        this.onLog(`S1F13 → S1F14 通信建立 (${this.devices[sessionId] || sessionId})`);
      } else if (stream === 2 && fn === 17) {               // S2F17 Date/Time
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        this._send(sock, sessionId, 0x00, sys, encMsg(2, 18, false, [{ t: 'A', v: ts }]), 2, 18);
      } else if (stream === 2 && fn === 41) {               // S2F41 Remote Command（EAP 控制面）
        const rcmd = list[0] ? String(list[0].v) : '';
        const params = list[1] && list[1].v ? list[1].v.map(x => (x.v !== undefined ? String(x.v) : '')) : [];
        const ack = this.onControl ? this.onControl(sessionId, rcmd, params) : 1;
        const r = encMsg(2, 42, false, [{ t: 'B', v: [ack] }, { t: 'L', v: [] }]);
        this._send(sock, sessionId, 0x00, sys, r, 2, 42);
        this.onLog(`S2F41 RCMD=${rcmd} → S2F42 ACK=${ack} (${this.devices[sessionId] || sessionId})`);
      } else if (stream === 14 && fn === 1) {               // E87 S14F1 载具信息查询
        const r = encMsg(14, 2, false, [
          { t: 'L', v: [{ t: 'A', v: 'FOUP-1024' }, { t: 'A', v: 'AVAILABLE' }] },
          { t: 'L', v: [{ t: 'A', v: 'FOUP-2048' }, { t: 'A', v: 'IN_USE' }] },
        ]);
        this._send(sock, sessionId, 0x00, sys, r, 14, 2);
        this.onLog(`S14F1 载具查询 → S14F2 (E87, ${this.devices[sessionId] || sessionId})`);
      } else if (stream === 18 && fn === 1) {               // E90 S18F1 过程跟踪查询
        const r = encMsg(18, 2, false, [
          { t: 'A', v: 'LOT-0001' }, { t: 'A', v: 'PROCESSING' }, { t: 'A', v: 'LITHO' },
        ]);
        this._send(sock, sessionId, 0x00, sys, r, 18, 2);
        this.onLog(`S18F1 过程跟踪 → S18F2 (E90, ${this.devices[sessionId] || sessionId})`);
      } else {
        this.onLog(`未处理 S${stream}F${fn} (sys=${sys})`);
        this._send(sock, sessionId, 0x00, sys, encMsg(stream, fn + 1, false, [{ t: 'L', v: [] }]), stream, fn + 1);
      }
    } catch (e) { this.onLog('SECS-II 解码失败: ' + e.message); }
  }
  // 事件 → S6F11（推送给所有已 select 该设备的 Host 会话，支持多监控端）
  pushEvent(deviceId, ev) {
    // 设备开始加工 → 模拟设备处理时延后自动报 LOT_DONE，使 EAP 真正驱动 lot 生命周期（MES 只投料派工，设备报完工）
    if (ev.type === 'lotStart') {
      const delay = 7000 + Math.floor(Math.random() * 6000);   // 7~13s 设备加工时延
      setTimeout(() => this._emitLotDone(deviceId), delay);
    }
    let sent = 0;
    for (const [sock, sid] of this.sessions) {
      if (sid === deviceId) {
        const ceid = ev.type === 'toolStatus' ? ({ RUN: 1001, IDLE: 1002, PM: 1003, DOWN: 1004 }[ev.status] || 1000) : (ev.type === 'lotStart' ? 2001 : (ev.type === 'lotDone' ? 2002 : 3000));
        const body = encMsg(6, 11, false, [
          { t: 'U4', v: ceid },
          { t: 'A', v: 'EVT' },
          { t: 'L', v: [{ t: 'L', v: [{ t: 'A', v: `${ev.id || ev.lot} ${ev.status || ev.mod || ''}`.trim() }] }] },
        ]);
        this._send(sock, deviceId, 0x00, ++this.sys, body, 6, 11);
        sent++;
      }
    }
    if (sent) this.onLog(`S6F11 CEID=${ev.type === 'toolStatus' ? ({ RUN: 1001, IDLE: 1002, PM: 1003, DOWN: 1004 }[ev.status] || 1000) : (ev.type === 'lotStart' ? 2001 : 2000)} → ${this.devices[deviceId]} (${sent} 会话)`);
  }
  // 设备完工上报（LOT_DONE）：仅当该设备存在已连接 Host 会话时下发，使 EAP 回灌的 lotDone 真正驱动 WIP
  _emitLotDone(deviceId) {
    let sent = 0;
    for (const [sock, sid] of this.sessions) {
      if (sid === deviceId) {
        const body = encMsg(6, 11, false, [
          { t: 'U4', v: 2002 },
          { t: 'A', v: 'EVT' },
          { t: 'L', v: [{ t: 'L', v: [{ t: 'A', v: `${this.devices[deviceId]} LOT_DONE` }] }] },
        ]);
        this._send(sock, deviceId, 0x00, ++this.sys, body, 6, 11);
        sent++;
      }
    }
    if (sent) this.onLog(`S6F11 CEID=2002(LOT_DONE) → ${this.devices[deviceId]} (${sent} 会话)`);
  }
}

module.exports = { SecsGemGateway, enc, dec, T };
