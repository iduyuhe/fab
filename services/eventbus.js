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

  function broadcast(ev) {
    const data = JSON.stringify(ev);
    for (const c of wss.clients) if (c.readyState === 1) c.send(data);
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
    registerMQ: (fn) => { mqPublish = typeof fn === 'function' ? fn : mqPublish; },
  };
}

module.exports = { createEventBus };
