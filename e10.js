// ============================================================
//  SEMI E10/E58 — 设备状态时间累计与关键指标
//  E10 状态分类：Production / Standby / PM / Unplanned Down
//  E58 口径：Utilization = Production/Total · Availability = (Total-Down)/Total
//            MTBF = 可运行时间/故障次数 · MTTR = 停机时长/故障次数
// ============================================================
const E10_CAT = { RUN: 'Production', IDLE: 'Standby', PM: 'PM', DOWN: 'Unplanned Down' };

class E10Tracker {
  constructor(tools, startTs = Date.now()) {
    this.startTs = startTs;
    this.dev = new Map();                       // toolId -> {module, lastStatus, lastTs, time:{cat:sec}, downCount, downSec}
    tools.forEach(t => {
      this.dev.set(t.id, { module: t.module, lastStatus: t.status, lastTs: startTs,
        time: { Production: 0, Standby: 0, PM: 0, 'Unplanned Down': 0 }, downCount: 0, downSec: 0 });
    });
  }
  // 状态变化时调用：把上一状态的时间段计入累计（原始状态 → E10 类别）
  record(toolId, newStatus, ts = Date.now()) {
    const d = this.dev.get(toolId);
    if (!d) return;
    const sec = (ts - d.lastTs) / 1000;
    const cat = E10_CAT[d.lastStatus] || d.lastStatus;
    if (sec > 0) d.time[cat] = (d.time[cat] || 0) + sec;
    if (d.lastStatus === 'DOWN') { d.downCount++; d.downSec += sec; }
    d.lastStatus = newStatus; d.lastTs = ts;
  }
  // 最终结算（把当前状态区间也算进去）：必须传设备 id 而非状态名
  settle(ts = Date.now()) {
    for (const [id, d] of this.dev) this.record(id, d.lastStatus, ts);
  }
  _stat(d, now) {
    const total = Math.max(1e-9, (now - this.startTs) / 1000);
    const prod = d.time.Production, down = d.time['Unplanned Down'];
    return {
      utilPct: +(100 * prod / total).toFixed(1),
      availPct: +(100 * (total - down) / total).toFixed(1),
      standbyPct: +(100 * d.time.Standby / total).toFixed(1),
      pmPct: +(100 * d.time.PM / total).toFixed(1),
      downPct: +(100 * down / total).toFixed(1),
      mtbfH: d.downCount ? +( (total - down) / 3600 / d.downCount ).toFixed(2) : 0,
      mttrH: d.downCount ? +( down / 3600 / d.downCount ).toFixed(2) : 0,
    };
  }
  snapshot(now = Date.now()) {
    this.settle(now);
    const all = { time: { Production: 0, Standby: 0, PM: 0, 'Unplanned Down': 0 }, downCount: 0, downSec: 0 };
    const byModule = {};
    for (const [id, d] of this.dev) {
      Object.keys(all.time).forEach(k => all.time[k] += d.time[k]);
      all.downCount += d.downCount; all.downSec += d.downSec;
      if (!byModule[d.module]) byModule[d.module] = { time: { Production: 0, Standby: 0, PM: 0, 'Unplanned Down': 0 }, downCount: 0, downSec: 0, n: 0 };
      const bm = byModule[d.module]; bm.n++;
      Object.keys(bm.time).forEach(k => bm.time[k] += d.time[k]);
      bm.downCount += d.downCount; bm.downSec += d.downSec;
    }
    const modOut = {};
    Object.entries(byModule).forEach(([m, b]) => {
      const total = Math.max(1e-9, b.n * (now - this.startTs) / 1000);
      modOut[m] = {
        utilPct: +(100 * b.time.Production / total).toFixed(1),
        availPct: +(100 * (total - b.time['Unplanned Down']) / total).toFixed(1),
        pmPct: +(100 * b.time.PM / total).toFixed(1),
        downPct: +(100 * b.time['Unplanned Down'] / total).toFixed(1),
        mtbfH: b.downCount ? +((total - b.time['Unplanned Down']) / 3600 / b.downCount).toFixed(2) : 0,
        mttrH: b.downCount ? +(b.time['Unplanned Down'] / 3600 / b.downCount).toFixed(2) : 0,
      };
    });
    const total = Math.max(1e-9, this.dev.size * (now - this.startTs) / 1000);
    const global = {
      utilPct: +(100 * all.time.Production / total).toFixed(1),
      availPct: +(100 * (total - all.time['Unplanned Down']) / total).toFixed(1),
      standbyPct: +(100 * all.time.Standby / total).toFixed(1),
      pmPct: +(100 * all.time.PM / total).toFixed(1),
      downPct: +(100 * all.time['Unplanned Down'] / total).toFixed(1),
      mtbfH: all.downCount ? +((total - all.time['Unplanned Down']) / 3600 / all.downCount).toFixed(2) : 0,
      mttrH: all.downCount ? +(all.time['Unplanned Down'] / 3600 / all.downCount).toFixed(2) : 0,
    };
    // 逐台设备级指标：每台设备独立统计 MTBF/MTTR 与 E10 状态占比
    const byTool = {};
    for (const [id, d] of this.dev) {
      byTool[id] = Object.assign({ toolId: id, module: d.module }, this._stat(d, now));
    }
    return { standard: 'SEMI E10/E58', uptimeH: +((now - this.startTs) / 3600e3).toFixed(2), global, byModule: modOut, byTool };
  }
}

module.exports = { E10Tracker, E10_CAT };
