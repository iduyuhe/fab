// ============================================================
//  MES 对接适配骨架（L4 工厂级 · 真实 MES 集成适配层）
//  ------------------------------------------------------------
//  设计目标：将现有演示版 server.js(:8124) 与「真实 MES」
//  （SAP ME / 用友 MES / 真实产线 MES）包装为标准集成适配器，
//  抹平 REST/事件端点差异，对外暴露统一的端点映射与
//  canonical 事件翻译接口，供上层（门户 / agent / 孪生）消费。
//
//  模式（MES_MODE，默认 demo）：
//    demo  —— 指向本地 server.js(:8124)，即现有演示闭环，零影响
//    sap   —— SAP ME（REST + IDoc/WebService 语义），读 env 配置，不实际连
//    real  —— 真实产线 MES（REST + WS/MQ），读 env 配置，不实际连
//
//  契约红线：适配器只做「端点映射 + 事件翻译 + 配置读取」，
//            不新造事件类型（仅翻译为平台已有 canonical 事件），
//            不改动 server.js / fab-erp.js / portal.js / agent 业务逻辑。
//            与 L3 设备适配层(adapters/) 同范式：适配层 + env 切换 + 默认 demo。
// ============================================================
//  ⚠️ 蓝图态(BLUEPRINT)：L4 MES 对接适配器骨架。当前"数字主线 spine"由 server.js(:8124) 直接承载，不经过此适配器（默认 demo、未被 require 接活）；按"串主轴不推翻"策略保持蓝图态。
'use strict';

// 平台 canonical 事件类型（来自 docs/CONTRACT.md §1.2，适配器不得新造）：
//   toolStatus / toolMetric / amhs / lotRelease / lotStart /
//   lotStepDone / lotDone / lotHold / toolHold / toolRelease /
//   lotReleaseHold / spcAlarm / metrology / vmPrediction /
//   vmResult / fdcAlarm

// 默认本地演示端点（与现有进程地址严格一致：server.js :8124）
const DEMO = {
  rest:  'http://127.0.0.1:8124',
  ws:    'ws://127.0.0.1:8124',
};

/**
 * MES 对接适配器
 * @param {object} opts
 * @param {string} opts.mode  'demo' | 'sap' | 'real'（默认 demo）
 */
class MesAdapter {
  constructor({ mode } = {}) {
    this.mode = (mode || process.env.MES_MODE || 'demo').toLowerCase();
    // 真实模式配置（仅读取，不建立连接，避免引入重型依赖）
    this.real = this.mode === 'sap' || this.mode === 'real';
    this.config = this._readConfig();
  }

  // 读取真实 MES 连接配置（env），不实际连接
  _readConfig() {
    if (!this.real) return {};
    return {
      url:   process.env.MES_REAL_URL  || '',
      token: process.env.MES_REAL_TOKEN || '',
      wsUrl: process.env.MES_REAL_WS   || '',
      idoc:  process.env.MES_REAL_IDOC || '',   // SAP 专用：IDoc/WebService 端点
      system: this.mode,                          // 'sap' | 'real'
    };
  }

  /**
   * 返回当前 MES 的 REST/事件端点映射。
   * demo → 本地 server.js；real → env 指定的真实 MES。
   * 上层（ERP 进程 / 门户）据此决定消费哪个地址，无需感知模式差异。
   */
  getEndpoints() {
    if (this.mode === 'demo') {
      return {
        mode: 'demo',
        system: 'fab-mes-demo',
        rest: DEMO.rest,
        ws:   DEMO.ws,
        health: `${DEMO.rest}/api/health`,
        // 关键只读端点（ERP/门户消费依据，CONTRACT §3）
        routes: {
          wos:   `${DEMO.rest}/api/wos`,
          lots:  `${DEMO.rest}/api/lots`,
          lotById: `${DEMO.rest}/api/lots/{id}`,   // {id} 占位
          tools: `${DEMO.rest}/api/tools`,
          wip:   `${DEMO.rest}/api/wip`,
          topo:  `${DEMO.rest}/api/topo`,
          meta:  `${DEMO.rest}/api/meta`,
          spc:   `${DEMO.rest}/api/spc`,
          metrology: `${DEMO.rest}/api/metrology`,
          fdc:   `${DEMO.rest}/api/fdc`,
          vm:    `${DEMO.rest}/api/vm`,
          pdm:   `${DEMO.rest}/api/pdm`,
          events:`${DEMO.rest}/api/events`,
          // 事件订阅（WS 源唯一，8124）
          subscribeWs: DEMO.ws,
        },
      };
    }
    // real / sap：指向 env（这里仅声明，不连接）
    const base = (this.config.url || '').replace(/\/$/, '');
    return {
      mode: this.mode,
      system: this.mode === 'sap' ? 'sap-me' : 'real-mes',
      rest: this.config.url || null,
      ws:   this.config.wsUrl || null,
      idoc: this.config.idoc || null,
      health: base ? `${base}/health` : null,
      // 真实 MES 端点名各异，这里给出语义占位，由具体对接实现填充
      routes: {
        wos:   base ? `${base}/wos`   : null,
        lots:  base ? `${base}/lots`  : null,
        lotById: base ? `${base}/lots/{id}` : null,
        subscribeWs: this.config.wsUrl || null,
      },
      credential: this.config.token ? '***configured***' : 'missing',
    };
  }

  /**
   * 将「真实 MES 事件」映射为平台 canonical 事件。
   * 适配器只做字段翻译，输出严格符合 CONTRACT.md §1.2 已有事件，不新造。
   * @param {object} event  真实 MES 原始事件（字段随系统而异）
   * @returns {object|null} 平台 canonical 事件，或 null（无法识别/丢弃）
   */
  translateToCanonical(event) {
    if (!event || !event.type) return null;
    const t = String(event.type).toUpperCase();

    // —— 1. 设备状态变更：真实 MES 状态 → 平台 toolStatus.status ——
    // SAP/真实 MES 常见机台状态 → RUN/IDLE/PM/DOWN
    const STATUS_MAP = {
      RUNNING: 'RUN', RUN: 'RUN', ACTIVE: 'RUN', PRODUCING: 'RUN',
      IDLE: 'IDLE', WAIT: 'IDLE', STANDBY: 'IDLE',
      MAINT: 'PM', PM: 'PM', MAINTENANCE: 'PM', SETUP: 'PM',
      DOWN: 'DOWN', FAIL: 'DOWN', FAULT: 'DOWN', ERROR: 'DOWN',
    };
    if (t === 'TOOLSTATUS' || t === 'EQUIPSTATUS' || t === 'MACHINESTATUS') {
      const status = STATUS_MAP[String(event.status || '').toUpperCase()] || 'IDLE';
      return { type: 'toolStatus', id: String(event.id || event.tool || event.equipment || ''), status, src: 'mes' };
    }

    // —— 2. lot 释放/投料：→ lotRelease（字段 lot/wo/mod）——
    if (t === 'LOTRELEASE' || t === 'LOTSTARTRELEASE' || t === 'RELEASE') {
      return { type: 'lotRelease', lot: String(event.lot || event.lotId || ''), wo: String(event.wo || event.workOrder || ''), mod: String(event.mod || event.module || '') };
    }

    // —— 3. lot 开始加工：→ lotStart（lot/wo/mod/tool）——
    if (t === 'LOTSTART' || t === 'LOTDISPATCH') {
      return { type: 'lotStart', lot: String(event.lot || ''), wo: String(event.wo || ''), mod: String(event.mod || ''), tool: String(event.tool || event.equipment || '') };
    }

    // —— 4. lot 完成：→ lotDone（lot/wo/product/cycleH）——
    if (t === 'LOTDONE' || t === 'LOTCOMPLETE' || t === 'LOTFINISH') {
      return { type: 'lotDone', lot: String(event.lot || ''), wo: String(event.wo || ''),
        product: String(event.product || ''), cycleH: Number(event.cycleH || event.cycleHours || 0) };
    }

    // —— 5. 量测数据：→ metrology（对接 SPC）——
    if (t === 'METROLOGY' || t === 'MEASUREMENT' || t === 'SPCSAMPLE') {
      const value = Number(event.value);
      const lsl = Number(event.lsl), usl = Number(event.usl);
      const result = (value >= lsl && value <= usl) ? 'OK' : 'OOR';
      return { type: 'metrology', lot: String(event.lot || ''), product: String(event.product || ''),
        tool: String(event.tool || event.equipment || null), step: event.step != null ? Number(event.step) : null,
        param: String(event.param || ''), unit: String(event.unit || ''), value,
        target: Number(event.target || 0), usl, lsl, result };
    }

    // —— 6. 设备性能/退化：→ fdcAlarm ——
    if (t === 'EQUIPFAULT' || t === 'FDCFAULT' || t === 'EQUIPALARM') {
      return { type: 'fdcAlarm', ts: Date.now(), tool: String(event.tool || event.equipment || ''),
        module: String(event.module || (String(event.tool || '').split('-')[0] || '')),
        wph: Number(event.wph || 0), avgWph: Number(event.avgWph || 0), util: Number(event.util || 0) };
    }

    // 未识别事件：丢弃，不污染平台事件流（绝不新造 type）
    return null;
  }
}

module.exports = { MesAdapter, DEMO_MES_ENDPOINTS: DEMO };
