// ============================================================
//  仿真引擎 · 腔室级状态模型（逐腔室真实遥测）
//  每台设备的每个工艺腔室维护独立的物理状态：
//    - temp   腔温(°C)       等离子模块加工时升温至工艺设定点，待机时回落至环境
//    - rf     RF 功率(W)      仅等离子模块(LITHO 无 / DEP·ETCH 有)；非等离子恒为 0（真实工况）
//    - gas    工艺气体流量(sccm)  加工时升至工艺流量，待机时归零
//    - press  腔室压力(Torr)  等离子模块加工时抽真空，待机时破真空回大气
//  状态随整机 RUN/IDLE 实时演进（一阶惯性 + 随机扰动），供装备级孪生逐腔室真遥测。
// ============================================================

// 环境基准（待机/破真空目标）
const AMBIENT = 22;

// 各模块工艺腔室运行设定点（逐腔室在此基础上加 ± 偏移，体现同机多腔差异）
//  rf>0 表示该模块为等离子工艺；rf=0 的模块真实无 RF（光刻/量测/CMP/注入）
const PROFILES = {
  LITHO: { label: '涂胶/显影', temp: 23,   tempTol: 1.5, rf: 0,    rfTol: 0,   gas: 3,   gasTol: 1,   press: 760,   plasma: false },
  DEP:   { label: '薄膜沉积',   temp: 450,  tempTol: 25,  rf: 1500, rfTol: 120, gas: 220, gasTol: 25,  press: 3,     plasma: true  },
  ETCH:  { label: '等离子刻蚀', temp: 65,   tempTol: 6,   rf: 2500, rfTol: 180, gas: 160, gasTol: 18,  press: 0.06,  plasma: true  },
  IMPL:  { label: '离子注入',   temp: 35,   tempTol: 3,   rf: 0,    rfTol: 0,   gas: 6,   gasTol: 2,   press: 0.0008,plasma: false },
  CMP:   { label: '化学机械研磨',temp: 25,   tempTol: 2,   rf: 0,    rfTol: 0,   gas: 0,   gasTol: 0,   press: 760,   plasma: false },
  METRO: { label: '量测/检测',  temp: 22,   tempTol: 1,   rf: 0,    rfTol: 0,   gas: 0,   gasTol: 0,   press: 1,     plasma: false },
};

// 一阶惯性趋近：cur 以时间常数 tau 向 target 收敛
function approach(cur, target, dt, tau) {
  if (tau <= 0) return target;
  const k = 1 - Math.exp(-dt / tau);
  return cur + (target - cur) * k;
}
// 近似标准正态（Irwin-Hall 3）
const randn = () => (Math.random() + Math.random() + Math.random()) / 3 * 2 - 1;

class ChamberModel {
  // tool: {id, module, chambers}
  constructor(tool) {
    this.toolId = tool.id;
    this.module = tool.module;
    this.profile = PROFILES[tool.module] || PROFILES.METRO;
    this.n = Math.max(1, Math.min(8, tool.chambers || 1));
    this.ch = [];
    for (let i = 0; i < this.n; i++) {
      // 同机多腔室微小工艺差异（±30%~40% 容差内）
      this.ch.push({
        idx: i,
        label: 'CH-' + String.fromCharCode(65 + i),     // CH-A / CH-B ...
        temp: AMBIENT + randn() * 0.5,
        rf: 0,
        gas: 0,
        press: this.profile.plasma ? 760 : this.profile.press,
        state: 'IDLE',
        fault: 0,                                       // 退化等级 0 正常 / 1 轻微 / 2 明显 / 3 严重
        faultTtl: 0,                                    // 退化剩余持续(秒)
        offTemp: randn() * this.profile.tempTol * 0.4,
        offRf: randn() * this.profile.rfTol * 0.4,
        offGas: randn() * this.profile.gasTol * 0.4,
        phase: Math.random() * Math.PI * 2,             // RF 纹波相位
      });
    }
  }

  // dt: 秒；active: 整机是否 RUN（加工中）
  tick(dt, active) {
    const p = this.profile;
    const now = Date.now();
    for (const c of this.ch) {
      // —— 退化/故障注入（仅 RUN 时偶发，自动恢复）——
      if (active && c.fault === 0 && Math.random() < 0.0012) {
        // 1 轻微 / 2 明显 / 3 严重（约 40% 轻微、40% 明显、20% 严重）
        const r = Math.random();
        c.fault = r < 0.4 ? 1 : (r < 0.8 ? 2 : 3);
        c.faultTtl = 18 + Math.random() * 26;          // 持续 18~44s 后自恢复
      }
      if (c.fault > 0) {
        c.faultTtl -= dt;
        if (c.faultTtl <= 0) { c.fault = 0; c.faultTtl = 0; }
      }
      const sev = c.fault;                              // 0..3

      // 目标设定点（含同机多腔偏移）
      let tgtTemp = active ? p.temp + c.offTemp : AMBIENT;
      let tgtRf = (p.rf > 0) ? (active ? p.rf + c.offRf : 0) : 0;
      let tgtGas = active ? p.gas + c.offGas : 0;
      let tgtPress = active ? p.press : (p.plasma ? 760 : p.press);

      // 退化时偏离设定点
      if (sev > 0) {
        tgtTemp += sev * 11 + randn() * 3;                                  // 腔体超温
        if (p.rf > 0) tgtRf = Math.max(0, tgtRf * (1 - 0.11 * sev) + randn() * (p.rfTol * 0.25)); // RF 衰减+不稳
        tgtGas += randn() * (p.gas * 0.18 + 1.2);                          // 气流量失控
        if (p.plasma) tgtPress = p.press + p.press * (sev * 1.6) + Math.abs(randn()) * p.press * 0.5; // 抽不住真空
        else tgtPress += randn() * (p.press ? p.press * 0.25 : 3) * sev;
      }

      // 腔温：加热快、冷却慢
      const tauT = active ? 8 : 18;
      c.temp = approach(c.temp, tgtTemp, dt, tauT) + randn() * 0.25;

      // RF 功率：仅等离子模块；加工时围绕设定点纹波，待机归零
      if (p.rf > 0) {
        const ripple = Math.sin(now / 350 + c.phase) * p.rfTol * 0.3;
        const tgtRf2 = active ? (sev > 0 ? tgtRf : p.rf + c.offRf + ripple) : 0;
        c.rf = Math.max(0, approach(c.rf, tgtRf2, dt, 2) + randn() * (p.rfTol * 0.12));
      } else {
        c.rf = approach(c.rf, 0, dt, 2);
      }

      // 工艺气体流量
      const tgtGas2 = active ? (sev > 0 ? tgtGas : p.gas + c.offGas) : 0;
      c.gas = Math.max(0, approach(c.gas, tgtGas2, dt, 3) + randn() * (p.gas * 0.01 + 0.08));

      // 腔室压力
      const tgtPress2 = active ? (sev > 0 ? tgtPress : p.press) : (p.plasma ? 760 : p.press);
      c.press = approach(c.press, tgtPress2, dt, 4);

      // 状态
      if (active) c.state = sev > 0 ? 'WARN' : 'RUN';
      else c.state = this._toolDown === true ? 'DOWN' : 'IDLE';
    }
  }

  // 整机故障标记（影响待机腔室着色）
  setToolDown(down) { this._toolDown = !!down; }

  // 单台快照（逐腔室真实读数 + 退化/偏离度）
  snapshot() {
    const p = this.profile;
    return this.ch.map(c => {
      const sp = { temp: p.temp, rf: p.rf, gas: p.gas, press: p.press };
      const devTemp = c.state === 'RUN' ? Math.abs(c.temp - sp.temp) / Math.max(1, sp.temp) * 100 : 0;
      const devRf = (p.rf > 0 && c.state === 'RUN') ? Math.abs(c.rf - sp.rf) / Math.max(1, sp.rf) * 100 : 0;
      const devGas = (p.gas > 0 && c.state === 'RUN') ? Math.abs(c.gas - sp.gas) / Math.max(1, sp.gas) * 100 : 0;
      const devPress = c.state === 'RUN' ? Math.abs(c.press - sp.press) / (sp.press + 1) * 100 : 0;
      const dev = +Math.max(devTemp, devRf, devGas, devPress).toFixed(1);
      return {
        ch: c.label, idx: c.idx,
        temp: +c.temp.toFixed(1),
        rf: +c.rf.toFixed(0),
        gas: +c.gas.toFixed(1),
        press: +c.press.toFixed(c.press < 1 ? 4 : 1),
        state: c.state, fault: c.fault, dev,
      };
    });
  }

  // 当前处于退化(明显及以上)的腔室列表，供 FDC 判异使用
  driftChambers() {
    return this.snapshot().filter(c => c.fault >= 2)
      .map(c => ({ ch: c.ch, fault: c.fault, temp: c.temp, rf: c.rf, gas: c.gas, press: c.press, dev: c.dev }));
  }

  // 全厂概览用的紧凑摘要
  summary() {
    let sumT = 0, maxRf = 0, active = 0, drift = 0;
    for (const c of this.ch) {
      sumT += c.temp;
      if (c.rf > maxRf) maxRf = c.rf;
      if (c.state === 'RUN') active++;
      if (c.fault >= 2) drift++;
    }
    return { n: this.n, active, drift, avgTemp: +(sumT / this.n).toFixed(1), maxRf: +maxRf.toFixed(0) };
  }
}

module.exports = { ChamberModel, PROFILES, AMBIENT };
