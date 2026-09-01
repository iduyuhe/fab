// ============================================================
//  EDA(E4/E5/E37 SECS-II) 事件订阅适配器骨架（L3 专业级设备接入）
//  ------------------------------------------------------------
//  EDA（Equipment Data Acquisition，SEMI EDA / Interface E4+E5+E37）
//    E4  : SESF 消息格式（SECS-II 数据项编码）
//    E5  : SESF 消息定义（Equipment Status / Process Data / Alarm 等）
//    E37 : HSMS 传输（已存在于 server.js 的 SecsGemGateway，此处偏「EDA 事件订阅」语义层）
//
//  本适配器：订阅设备 EDA 事件流（Equipment Status / Process Data / Alarm），
//  映射为平台事件总线 emitEv 的标准格式（CONTRACT.md §1.2）。
//
//  默认模式：本地 stub 模拟 EDA 事件流（不依赖真实 SECS 设备）。
//  真实模式：env EDA_REAL=1 且已接 HSMS 会话时，改用真实 E37 消息解析（见注释）。
//
//  契约红线：产出事件必须经 emitEv 汇出，不得绕开；不得改名/删字段。
// ============================================================
//  ⚠️ 蓝图态(BLUEPRINT)：L3 EDA(E4/E5/E37) 接入适配器骨架。默认 demo stub 空转，ADAPTER_MODE=eda 才启真实解析；当前"数字主线 spine"不经此路径（未被主进程 startAdapters 调用）。按"串主轴不推翻"策略保持蓝图态占位。
const { EventEmitter } = require('events');

// EDA / E37 设备状态（S1F1 / S6F11 等价语义）→ 平台 toolStatus.status
const EDA_STATUS_MAP = {
  'EQP_RUN':      'RUN',
  'EQP_IDLE':     'IDLE',
  'EQP_PM':       'PM',
  'EQP_DOWN':     'DOWN',
};

// EDA Alarm 等级 → 平台报警类型
//  - 严重(process/equipment fault) → fdcAlarm（设备退化/故障）
//  - 工艺判异(process variable OOS) → spcAlarm（对接 SPC 自动停线）
const EDA_ALARM_MAP = {
  'ALARM_EQUIP_FAULT': 'fdcAlarm',
  'ALARM_PROCESS_OOS': 'spcAlarm',
};

// 平台演示设备（id 与 server.js 同构）
const DEFAULT_MACHINES = ['LITHO-001', 'ETCH-015', 'DEP-060', 'METRO-080', 'CMP-030'];

class EdaAdapter extends EventEmitter {
  /**
   * @param {object} opts
   * @param {Function} opts.emitEv  平台事件总线出口（必填）
   * @param {Array}    opts.machines 订阅设备列表（默认 DEFAULT_MACHINES）
   */
  constructor({ emitEv, machines } = {}) {
    super();
    if (typeof emitEv !== 'function') throw new Error('EdaAdapter: emitEv 必填');
    this.emitEv = emitEv;
    this.machines = machines || DEFAULT_MACHINES;
    this.real = process.env.EDA_REAL === '1';
    this._timer = null;
    this._prevStatus = new Map();
    this._hsms = null;        // 真实模式：HSMS 会话（复用 server.js SecsGemGateway 语义）
    this.stats = {};          // 事件计数：证明适配器事件经 emitEv 流入总线
    this._bump = (t) => { this.stats[t] = (this.stats[t] || 0) + 1; };
  }

  // 连接：stub 仅标记；真实模式绑定 HSMS 会话
  async connect(hsms) {
    if (this.real && hsms) {
      // this._hsms = hsms;
      // hsms.on('S6F11', (dev, report) => this._onE37(dev, report));
    }
    this.emit('connected', { real: this.real });
  }

  // 订阅：stub 记录设备；真实模式注册 E37 事件报告（S6F11）
  subscribeNodes(machines) {
    if (machines) this.machines = machines;
    return this.machines;
  }

  start(intervalMs = +(process.env.ADAPTER_EDA_MS || 15000)) {
    if (this._timer) return;
    const { isAutomationEnabled } = require('../automation-flag');
    this._timer = setInterval(() => { if (isAutomationEnabled()) this._pollStub(); }, intervalMs);
  }

  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  // ---- stub：模拟 EDA 事件流（E4/E5/E37 语义） ----
  _pollStub() {
    const machine = this.machines[Math.floor(Math.random() * this.machines.length)];
    const r = Math.random();
    if (r < 0.55) {
      // Equipment Status 事件（S6F11 EquipState）
      const states = ['EQP_RUN', 'EQP_IDLE', 'EQP_PM', 'EQP_DOWN'];
      const status = states[Math.floor(Math.random() * states.length)];
      const ev = this._mkEda('EQUIP_STATUS', machine, { status });
      this.emit('data', ev);
      this._onEdaEvent(ev);
    } else if (r < 0.85) {
      // Process Data（量测/工艺变量）→ metrology / toolMetric
      const kind = Math.random() < 0.5 ? 'metro' : 'metric';
      const ev = kind === 'metro'
        ? this._mkEda('PROCESS_DATA', machine, { param: 'CD', unit: 'nm', target: 18, usl: 20, lsl: 16, value: +(18 + (Math.random() - 0.5) * 3).toFixed(2) })
        : this._mkEda('PROCESS_DATA', machine, { metric: 'util', value: Math.round(40 + Math.random() * 55) });
      this.emit('data', ev);
      this._onEdaEvent(ev);
    } else {
      // Alarm（S5F1）→ fdcAlarm / spcAlarm
      const alarms = ['ALARM_EQUIP_FAULT', 'ALARM_PROCESS_OOS'];
      const code = alarms[Math.floor(Math.random() * alarms.length)];
      const ev = this._mkEda('ALARM', machine, { code, text: code });
      this.emit('data', ev);
      this._onEdaEvent(ev);
    }
  }

  _mkEda(event, machine, body) {
    return {
      stream: event,                  // E4/E5 事件类别
      equipment: machine,             // 设备 id
      body,                           // 载荷
      sourceTimestamp: new Date().toISOString(),
    };
  }

  // ---- EDA 事件 → 平台事件 ----
  _onEdaEvent(evt) {
    this.mapToEvent(evt);
  }

  /**
   * 将 EDA(E4/E5/E37) 事件映射为平台事件，经 emitEv 汇出。
   * @param {object} evt { stream, equipment, body, sourceTimestamp }
   */
  mapToEvent(evt) {
    const { stream, equipment, body } = evt;
    if (stream === 'EQUIP_STATUS') {
      const mapped = EDA_STATUS_MAP[body.status] || 'IDLE';
      const prev = this._prevStatus.get(equipment);
      if (prev === mapped) return;
      this._prevStatus.set(equipment, mapped);
      this._bump('toolStatus');
      this.emitEv({ type: 'toolStatus', id: equipment, status: mapped, src: 'eap' });
    } else if (stream === 'PROCESS_DATA') {
      if (body.param) {
        const result = body.value >= body.lsl && body.value <= body.usl ? 'OK' : 'OOR';
        this._bump('metrology');
        this.emitEv({
          type: 'metrology',
          lot: null, product: null, tool: equipment, step: null,
          param: body.param, unit: body.unit, value: body.value,
          target: body.target, usl: body.usl, lsl: body.lsl, result,
        });
      } else if (body.metric === 'util') {
        this._bump('toolMetric');
        this.emitEv({ type: 'toolMetric', id: equipment, util: body.value });
      }
    } else if (stream === 'ALARM') {
      const target = EDA_ALARM_MAP[body.code] || 'fdcAlarm';
      if (target === 'fdcAlarm') {
        this._bump('fdcAlarm');
        this.emitEv({ type: 'fdcAlarm', ts: Date.now(), tool: equipment, module: (equipment.split('-')[0]),
          wph: 0, avgWph: 120, util: 0 });
      } else if (target === 'spcAlarm') {
        this._bump('spcAlarm');
        this.emitEv({ type: 'spcAlarm', product: null, param: body.param || 'CD', tool: equipment,
          value: body.value || 0, mean: 18, ucl: 20, lcl: 16, rules: [body.text] });
      }
    }
  }
}

module.exports = { EdaAdapter, EDA_STATUS_MAP, EDA_ALARM_MAP, DEFAULT_MACHINES };
