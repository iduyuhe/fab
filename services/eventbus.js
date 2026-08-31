// ============================================================
//  EventBus — 全局事件唯一出口（§6.3 / C7）
//  封装：wss(WebSocketServer, noServer) + broadcast + emitEv。
//  emitEv 职责（与原 server.js 等价）：
//    1) WS broadcast JSON(ev)
//    2) 事件入队，由 storage.flushEvents() 批写落库
//    3) 调用已注册的业务订阅回调（E10/量测/VM/SPC/FDC/SECS 等）
//    4) 可选 MQ publish 钩子（默认 no-op，便于将来接 NATS）
//  红线：任何代码不得绕开 emitEv 直 broadcast 或直写 events 表。
// ============================================================
const { WebSocketServer } = require('ws');

function createEventBus({ storage }) {
  const wss = new WebSocketServer({ noServer: true });

  // WS 背压（护栏②）：单客户端发送缓冲超阈值即丢弃本次发送，不堆积；
  //   极端慢客户端（缓冲 >1MB）直接断开，避免把 MES 主进程拖死（对应 Send-Q ≤100KB 验收线）。
  let backpressureDrops = 0;
  const BP_BYTES = process.env.EV_BP_BYTES ? +process.env.EV_BP_BYTES : 100 * 1024;
  const BP_KILL_BYTES = process.env.EV_BP_KILL_BYTES ? +process.env.EV_BP_KILL_BYTES : 1024 * 1024;
  function broadcast(ev) {
    const data = JSON.stringify(ev);
    for (const c of wss.clients) {
      if (c.readyState !== 1) continue;
      const buffered = c.bufferedAmount || 0;
      if (buffered > BP_KILL_BYTES) { try { c.terminate(); } catch (_) {} backpressureDrops++; continue; }
      if (buffered > BP_BYTES) { backpressureDrops++; continue; }
      try { c.send(data); } catch (_) { backpressureDrops++; }
    }
  }

  // 可选 MQ 发布钩子（阶段0 默认 no-op）
  let mqPublish = () => {};

  // 业务订阅回调表（由 server.js 注册；保持 emitEv 出口唯一且逻辑可追踪）
  const subscribers = new Set();
  function onEmit(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

  const nowISO = () => new Date().toISOString();
  const emitEv = ev => {
    broadcast(ev);
    storage.enqueueEvent(nowISO(), ev.type, JSON.stringify(ev));
    // 可选 MQ 钩子（如将来接 NATS：fab.events.<type>）
    try { mqPublish(ev); } catch (_) {}
    for (const fn of subscribers) { try { fn(ev); } catch (e) { /* 订阅异常隔离 */ } }
  };

  return {
    wss,
    broadcast,
    emitEv,
    onEmit,
    backpressureStats: () => ({ drops: backpressureDrops, thresholdBytes: BP_BYTES, killBytes: BP_KILL_BYTES }),
    registerMQ: (fn) => { mqPublish = typeof fn === 'function' ? fn : mqPublish; },
  };
}

module.exports = { createEventBus };
