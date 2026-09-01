// ============================================================
//  OPC-UA 客户端适配器骨架（L3 专业级设备接入）
//  ------------------------------------------------------------
//  设计目标：把真实产线级 OPC-UA server 的设备数据/事件，
//  映射为本平台事件总线 emitEv 的标准格式（契约见 docs/CONTRACT.md §1.2）。
//
//  默认模式：本地 Node stub 模拟 OPC-UA server（不安装 node-opcua 重型包）。
//  真实模式：env OPCUA_REAL=1 且已 `npm i node-opcua` 时，改用真实客户端（见下方注释）。
//
//  契约红线：适配器产出事件必须经注入的 emitEv 汇出，
//            不得绕开 emitEv 直 broadcast / 直写 events 表；
//            不得删除/重命名现有事件字段（见 CONTRACT.md §1.3）。
// ============================================================
//  ⚠️ 蓝图态(BLUEPRINT)：L3 OPC-UA 接入适配器骨架。默认 demo stub 空转，ADAPTER_MODE=opcua 才启真实客户端；当前"数字主线 spine"不经此路径（未被主进程 startAdapters 调用）。按"串主轴不推翻"策略保持蓝图态占位。
const { EventEmitter } = require('events');

// OPC-UA 状态 → 平台 toolStatus.status 映射（E10 语义对齐）
//  OPC-UA 常见状态码（简化）：RUNNING / IDLE / MAINTENANCE / FAILURE
const OPCUA_STATUS_MAP = {
  RUNNING:    'RUN',
  IDLE:       'IDLE',
  MAINTENANCE:'PM',
  FAILURE:    'DOWN',
};

// 平台设备 id 命名空间与 server.js 同构（LITHO-001 … METRO-192）
// stub 周期采集的节点（nodeId → 语义）
const DEFAULT_NODES = [
  { nodeId: 'ns=2;s=LITHO-001.Status',   id: 'LITHO-001', kind: 'status' },
  { nodeId: 'ns=2;s=ETCH-015.Status',    id: 'ETCH-015',  kind: 'status' },
  { nodeId: 'ns=2;s=DEP-060.Status',     id: 'DEP-060',   kind: 'status' },
  { nodeId: 'ns=2;s=DEP-060.Util',       id: 'DEP-060',   kind: 'metric', field: 'util' },
  { nodeId: 'ns=2;s=DEP-060.Wafers',     id: 'DEP-060',   kind: 'metric', field: 'wafers' },
  { nodeId: 'ns=2;s=DEP-060.WPH',        id: 'DEP-060',   kind: 'metric', field: 'wph' },
  { nodeId: 'ns=2;s=METRO-080.MetroCD',  id: 'METRO-080', kind: 'metro', param: 'CD', unit: 'nm', target: 18, usl: 20, lsl: 16 },
];

class OpcuaAdapter extends EventEmitter {
  /**
   * @param {object} opts
   * @param {Function} opts.emitEv   平台事件总线出口（必填）
   * @param {string}   opts.endpoint OPC-UA server endpoint（真实模式用）
   * @param {Array}    opts.nodes    订阅节点列表（默认 DEFAULT_NODES）
   */
  constructor({ emitEv, endpoint, nodes } = {}) {
    super();
    if (typeof emitEv !== 'function') throw new Error('OpcuaAdapter: emitEv 必填');
    this.emitEv = emitEv;
    this.endpoint = endpoint || 'opc.tcp://localhost:4840';
    this.nodes = nodes || DEFAULT_NODES;
    this.real = process.env.OPCUA_REAL === '1';
    this._timer = null;
    this._session = null;     // 真实模式：ua.Session
    this._client = null;      // 真实模式：ua.OPCUAClient
    this._prevStatus = new Map();
    this.stats = {};          // 事件计数：证明适配器事件经 emitEv 流入总线
    this._bump = (t) => { this.stats[t] = (this.stats[t] || 0) + 1; };
  }

  // 连接：stub 模式仅打印；真实模式建立 node-opcua 会话
  async connect(endpoint) {
    if (endpoint) this.endpoint = endpoint;
    if (this.real) {
      // —— 真实路径（需 npm i node-opcua，未默认安装）——
      // const ua = require('node-opcua');
      // this._client = ua.OPCUAClient.create({ endpointMustExist: false });
      // await this._client.connect(this.endpoint);
      // this._session = await this._client.createSession();
      // this.emit('connected', { real: true, endpoint: this.endpoint });
      // return;
      this.emit('error', new Error('OPCUA_REAL=1 但 node-opcua 未安装，回退 stub'));
      this.real = false;
    }
    this.emit('connected', { real: false, endpoint: this.endpoint });
  }

  // 订阅节点：stub 模式记录订阅表；真实模式调用 session.monitor
  async subscribeNodes(nodes) {
    if (nodes) this.nodes = nodes;
    if (this.real && this._session) {
      // for (const n of this.nodes) {
      //   const item = ua.ClientMonitoredItem.create(this._session, ua.resolveNodeId(n.nodeId),
      //     { samplingInterval: 1000 }, ua.TimestampsToReturn.Both);
      //   item.on('changed', (dv) => this._onDataValue(toDataValue(dv), n));
      // }
    }
    return this.nodes;
  }

  // 启动周期采集（stub）；受"自动化总开关"管制：关时不采集（演示闲置零采集）
  start(intervalMs = +(process.env.ADAPTER_OPCUA_MS || 10000)) {
    if (this._timer) return;
    const { isAutomationEnabled } = require('../automation-flag');
    this._timer = setInterval(() => { if (isAutomationEnabled()) this._pollStub(); }, intervalMs);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._client && this._session) {
      this._session.close().catch(() => {});
      this._client.disconnect().catch(() => {});
    }
  }

  // ---- stub：模拟 OPC-UA server 周期吐 DataValue ----
  _pollStub() {
    for (const n of this.nodes) {
      let dv;
      if (n.kind === 'status') {
        const states = ['RUNNING', 'IDLE', 'MAINTENANCE', 'FAILURE'];
        dv = this._mkDv(n.nodeId, states[Math.floor(Math.random() * states.length)], 'Good');
      } else if (n.kind === 'metric') {
        const base = n.field === 'util' ? 70 : n.field === 'wafers' ? 40000 : 120;
        const v = Math.round(base + (Math.random() - 0.5) * base * 0.2);
        dv = this._mkDv(n.nodeId, v, 'Good');
      } else if (n.kind === 'metro') {
        dv = this._mkDv(n.nodeId, +(n.target + (Math.random() - 0.5) * 2).toFixed(2), 'Good');
      }
      this.emit('data', dv);     // 原始 OPC-UA DataValue 流出
      this._onDataValue(dv, n);
    }
  }

  _mkDv(nodeId, value, quality) {
    return {
      nodeId,
      value,
      quality,                         // OPC-UA Quality: Good/Bad/Uncertain
      sourceTimestamp: new Date().toISOString(),
    };
  }

  // ---- OPC-UA DataValue → 平台事件 ----
  _onDataValue(dv, node) {
    this.mapToEvent(dv, node);
  }

  /**
   * 将 OPC-UA DataValue 映射为平台事件，并经 emitEv 汇出。
   * @param {object} dv   { nodeId, value, quality, sourceTimestamp }
   * @param {object} node 订阅节点描述（含 id / kind / field / param ...）
   */
  mapToEvent(dv, node) {
    if (!node) return;
    if (dv.quality && dv.quality !== 'Good') return;   // 坏质量点丢弃（不污染事件流）

    if (node.kind === 'status') {
      const mapped = OPCUA_STATUS_MAP[dv.value] || 'IDLE';
      const prev = this._prevStatus.get(node.id);
      if (prev === mapped) return;                      // 仅状态变化时发事件
      this._prevStatus.set(node.id, mapped);
      // 机台状态变化 → toolStatus（src:'eap' 标识来自设备接入层）
      this._bump('toolStatus');
      this.emitEv({ type: 'toolStatus', id: node.id, status: mapped, src: 'eap' });
    } else if (node.kind === 'metric') {
      // 设备性能采样 → toolMetric（字段与 CONTRACT.md §1.2 一致）
      this._bump('toolMetric');
      this.emitEv({ type: 'toolMetric', id: node.id, [node.field]: dv.value });
    } else if (node.kind === 'metro') {
      // 量测点 → metrology（对接 SPC；字段同 generateMetrology 输出）
      const value = dv.value;
      const result = value >= node.lsl && value <= node.usl ? 'OK' : 'OOR';
      this._bump('metrology');
      this.emitEv({
        type: 'metrology',
        lot: null, product: null, tool: node.id, step: null,
        param: node.param, unit: node.unit, value,
        target: node.target, usl: node.usl, lsl: node.lsl, result,
      });
    }
  }
}

module.exports = { OpcuaAdapter, OPCUA_STATUS_MAP, DEFAULT_NODES };
