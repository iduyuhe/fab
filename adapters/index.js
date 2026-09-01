// ============================================================
//  适配器装配器（L3 专业级设备接入统一入口）
//  ------------------------------------------------------------
//  根据 env ADAPTER_MODE 启动对应适配器，将标准协议（OPC-UA / EDA）
//  设备事件汇入平台事件总线 emitEv。
//
//  ADAPTER_MODE：
//    demo  (默认) —— 不启动任何真实协议适配器，保持现有 server.js 演示闭环
//    opcua        —— 启动 OPC-UA 客户端适配器（默认 stub）
//    eda          —— 启动 EDA(E4/E5/E37) 事件订阅适配器（默认 stub）
//    all          —— 同时启动 opcua + eda
//
//  契约红线：所有适配器事件必须经 emitEv 汇出；不得绕开；
//            不得改名/删字段；不得删除/影响 server.js 现有演示逻辑。
//
//  使用方式（server.js 中，在 emitEv/onEmit 就绪后调用，可选）：
//    const { startAdapters } = require('./adapters');
//    startAdapters({ emitEv, config: { opcuaInterval: 2000, edaInterval: 2500 } });
//  注意：默认 demo 模式下不会启动任何定时器，对现有演示零影响。
// ============================================================
const { OpcuaAdapter } = require('./opcua-client');
const { EdaAdapter } = require('./eda-client');

function startAdapters({ emitEv, config = {} } = {}) {
  if (typeof emitEv !== 'function') throw new Error('startAdapters: emitEv 必填');
  const mode = (process.env.ADAPTER_MODE || 'demo').toLowerCase();
  const started = [];
  const instances = [];

  if (mode === 'demo') {
    // 默认：保持现状，不接管事件，避免误影响演示闭环
    return { mode, started, stats: () => ({}), note: 'demo 模式：未启动真实协议适配器，演示仍用内置模拟' };
  }

  if (mode === 'opcua' || mode === 'all') {
    const opc = new OpcuaAdapter({ emitEv });
    opc.on('connected', info => console.log(`[adapter] OPC-UA ${info.real ? 'REAL' : 'stub'} connected @ ${opc.endpoint}`));
    opc.on('error', e => console.error('[adapter] OPC-UA error:', e.message));
    opc.on('data', dv => { /* 原始 DataValue 钩子（可选：接 MQ / 时序库） */ });
    opc.connect().then(() => opc.subscribeNodes()).then(() => {
      opc.start(config.opcuaInterval || +(process.env.ADAPTER_OPCUA_MS || 10000));   // 默认低频 10s（采集频率客户可配）
    });
    instances.push(opc);
    started.push('opcua');
  }

  if (mode === 'eda' || mode === 'all') {
    const eda = new EdaAdapter({ emitEv });
    eda.on('connected', info => console.log(`[adapter] EDA ${info.real ? 'REAL' : 'stub'} connected`));
    eda.on('data', evt => { /* 原始 EDA 事件钩子（可选：接 MQ / 时序库） */ });
    eda.connect().then(() => eda.subscribeNodes()).then(() => {
      eda.start(config.edaInterval || +(process.env.ADAPTER_EDA_MS || 15000));   // 默认低频 15s
    });
    instances.push(eda);
    started.push('eda');
  }

  const stats = () => {
    const s = {};
    for (const a of instances) {
      for (const [k, v] of Object.entries(a.stats || {})) s[k] = (s[k] || 0) + v;
    }
    return s;
  };
  return { mode, started, stats, note: `已启动适配器：${started.join(', ')}，事件经 emitEv 汇入总线` };
}

function stopAdapters(adapters) {
  // adapters：startAdapters 返回的句柄集合（此处为简单封装）
  if (Array.isArray(adapters)) adapters.forEach(a => a && a.stop && a.stop());
}

module.exports = { startAdapters, stopAdapters };
