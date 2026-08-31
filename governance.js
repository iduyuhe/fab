// ============================================================
//  资源治理层（锁死上限，而非"优化性能"）
//  ------------------------------------------------------------
//  设计原则（来自《fab-mes CPU 优化需求说明书》v1.0 四大护栏）：
//   ① 并发闸门 + 时间预算：重型任务同时运行数封顶，超时返回降级值
//   ② 队列封顶 + 背压：无界缓冲一律有上限，满则丢弃最旧并计数
//   ③ 空闲降频：周期任务在无用户操作超阈值时拉长间隔/暂停
//   ④ 增量 + 缓存 + 退避：外部拉取失败指数退避，禁止重试风暴
//
//  所有阈值均经环境变量可调，禁止硬编码（原则：写"上限"不写"优化"）。
// ============================================================
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 并发闸门 + 时间预算
//   同时运行数 ≤ maxConcurrent；单个任务超过 budgetMs 即返回降级值（释放槽位，
//   不强行 kill 单线程 JS，但过载被并发上限钳制）。可测：实际并发、超时数。
// ---------------------------------------------------------------------------
class TaskGate {
  constructor({ maxConcurrent, budgetMs, name = 'gate' } = {}) {
    this.max = Math.max(1, (maxConcurrent != null ? maxConcurrent : (+(process.env.GOV_MAX_CONCURRENT || 2))) | 0);
    this.budgetMs = budgetMs != null ? budgetMs : +(process.env.GOV_TASK_BUDGET_MS || 30000);
    this.name = name;
    this.running = 0;
    this.queue = [];
    this.metrics = { total: 0, completed: 0, timedOut: 0, rejected: 0, running: 0, queued: 0, totalMs: 0 };
  }
  _pump() {
    while (this.running < this.max && this.queue.length) {
      const job = this.queue.shift();
      this.running++; this.metrics.running = this.running; this.metrics.queued = this.queue.length;
      const start = Date.now();
      let finished = false;
      const finish = (val, timedOut) => {
        if (finished) return; finished = true;
        this.running--; this.metrics.running = this.running;
        if (timedOut) this.metrics.timedOut++; else this.metrics.completed++;
        this.metrics.totalMs += (Date.now() - start);
        this.metrics.queued = this.queue.length;
        job.resolve(val);
        this._pump();
      };
      Promise.resolve().then(job.fn)
        .then((v) => finish(v, false))
        .catch((e) => finish(job.degraded !== undefined ? job.degraded : { error: e.message }, false));
      // 时间预算：超时即释放槽位 + 返回降级值（孤儿任务随后自行结束，受 max 上限钳制）
      setTimeout(() => { if (!finished) finish(job.degraded, true); }, this.budgetMs);
    }
  }
  run(name, fn, degraded) {
    this.metrics.total++;
    return new Promise((resolve) => {
      this.queue.push({ fn, resolve, degraded, name });
      this.metrics.queued = this.queue.length;
      this._pump();
    });
  }
  snapshot() { this.metrics.running = this.running; this.metrics.queued = this.queue.length; return Object.assign({}, this.metrics); }
}

// ---------------------------------------------------------------------------
// 背压队列（有界缓冲）
//   满时策略：drop-oldest（丢弃最旧）/ drop-new（拒绝新入队）。满溢计数可观测。
// ---------------------------------------------------------------------------
class BackpressureQueue {
  constructor({ max, policy = 'drop-oldest', onDrop } = {}) {
    this.max = Math.max(1, max != null ? max : (+(process.env.GOV_QUEUE_MAX || 1000)));
    this.policy = policy;
    this.onDrop = onDrop;
    this.items = [];
    this.dropped = 0;
    this.accepted = 0;
  }
  push(x) {
    if (this.items.length >= this.max) {
      this.dropped++;
      const evicted = this.policy === 'drop-new' ? x : this.items.shift();
      if (this.onDrop) try { this.onDrop(evicted); } catch (_) {}
      if (this.policy === 'drop-new') return false;
    }
    this.items.push(x); this.accepted++;
    return true;
  }
  get length() { return this.items.length; }
  snapshot() { return { length: this.items.length, max: this.max, dropped: this.dropped, accepted: this.accepted, policy: this.policy }; }
}

// ---------------------------------------------------------------------------
// 空闲判定（空闲降频核心）
//   touch() 在有用户操作时调用；isIdle(ms) 判断距上次操作是否超过 ms。
// ---------------------------------------------------------------------------
class IdleGovernor {
  constructor({ idleMs } = {}) {
    this.idleMs = idleMs != null ? idleMs : +(process.env.GOV_IDLE_MS || 180000); // 默认 3 分钟
    this.last = Date.now();
  }
  touch() { this.last = Date.now(); }
  isIdle(ms = this.idleMs) { return (Date.now() - this.last) >= ms; }
  idleFor() { return Date.now() - this.last; }
}

// ---------------------------------------------------------------------------
// 指数退避抓取（护栏④）
//   失败指数退避(1/2/4/8s…封顶 maxTotalMs=5min)，超总时限返回 null。
//   全程吞掉异常与堆栈，调用方据 null 降级，禁止刷屏。
// ---------------------------------------------------------------------------
async function expBackoffFetch(url, {
  method = 'GET', body, headers, base = 1000, max = 300000, timeoutMs = 5000, maxAttempts = 8,
} = {}) {
  const start = Date.now();
  let attempt = 0;
  let wait = base;
  while (true) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method, body, headers, signal: ac.signal });
      clearTimeout(to);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r;
    } catch (e) {
      clearTimeout(to);
      attempt++;
      if (attempt >= maxAttempts || (Date.now() - start) > max) return null; // 放弃，返回 null（调用方降级）
      await sleep(wait);
      wait = Math.min(wait * 2, max); // 指数退避，封顶 5 分钟
    }
  }
}

// ---------------------------------------------------------------------------
// 日志节流（护栏②：日志写入速率封顶）
//   超过 linesPerMin 的行被丢弃，每分钟至多一条降级提示，禁止异常堆栈刷屏。
// ---------------------------------------------------------------------------
class ThrottledLogger {
  constructor({ linesPerMin, sink = console.log } = {}) {
    this.cap = linesPerMin != null ? linesPerMin : +(process.env.GOV_LOG_LPM || 100);
    this.sink = sink;
    this.windowStart = Date.now();
    this.count = 0;
    this.dropped = 0;
    this.lastWarn = 0;
  }
  log(msg) {
    const now = Date.now();
    if (now - this.windowStart >= 60000) { this.windowStart = now; this.count = 0; }
    if (this.count >= this.cap) {
      this.dropped++;
      if (now - this.lastWarn > 60000) {
        this.lastWarn = now;
        this.sink(`[日志节流] 已达 ${this.cap} 行/分钟上限，本周期丢弃约 ${this.dropped} 行（已降级为采样记录）`);
        this.dropped = 0;
      }
      return false;
    }
    this.count++;
    this.sink(msg);
    return true;
  }
  snapshot() { return { linesPerMin: this.cap, dropped: this.dropped }; }
}

// ---------------------------------------------------------------------------
// Governor 聚合单例
// ---------------------------------------------------------------------------
function createGovernor(opts = {}) {
  const maxConcurrent = opts.maxConcurrent != null ? opts.maxConcurrent : +(process.env.GOV_MAX_CONCURRENT || 2);
  const budgetMs = opts.budgetMs != null ? opts.budgetMs : +(process.env.GOV_TASK_BUDGET_MS || 30000);
  const queueMax = opts.queueMax != null ? opts.queueMax : +(process.env.GOV_QUEUE_MAX || 1000);
  const idleMs = opts.idleMs != null ? opts.idleMs : +(process.env.GOV_IDLE_MS || 180000);
  const linesPerMin = opts.linesPerMin != null ? opts.linesPerMin : +(process.env.GOV_LOG_LPM || 100);
  const gate = new TaskGate({ maxConcurrent, budgetMs });
  const queue = new BackpressureQueue({ max: queueMax });
  const idle = new IdleGovernor({ idleMs });
  const logger = new ThrottledLogger({ linesPerMin, sink: console.log });
  let _prevCpu = process.cpuUsage();
  return {
    gate, queue, idle, logger,
    runTask: (name, fn, degraded) => gate.run(name, fn, degraded),
    fetch: (url, o) => expBackoffFetch(url, o),
    isIdle: (ms) => idle.isIdle(ms),
    touch: () => idle.touch(),
    snapshot() {
      const c = process.cpuUsage(_prevCpu);
      _prevCpu = process.cpuUsage();
      const m = process.memoryUsage();
      return {
        ts: Date.now(),
        cpu: { userMs: c.user / 1000, systemMs: c.system / 1000 }, // 自上次 snapshot 的增量（秒）
        memRssMb: +(m.rss / 1048576).toFixed(1),
        memHeapMb: +(m.heapUsed / 1048576).toFixed(1),
        uptimeS: +process.uptime().toFixed(0),
        idleForMs: idle.idleFor(),
        idle: idle.isIdle(),
        gate: gate.snapshot(),
        queue: queue.snapshot(),
        log: logger.snapshot(),
        env: { maxConcurrent, budgetMs, queueMax, idleMs, linesPerMin },
      };
    },
  };
}

module.exports = {
  TaskGate, BackpressureQueue, IdleGovernor, ThrottledLogger, expBackoffFetch, createGovernor,
};
