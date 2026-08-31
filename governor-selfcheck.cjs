// 本地自测：资源治理层（不依赖服务器，纯逻辑验证）
// 运行：node governor-selfcheck.cjs
'use strict';
const { TaskGate, BackpressureQueue, IdleGovernor, ThrottledLogger, expBackoffFetch, createGovernor } = require('./governance');

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ? '→ ' + extra : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('== 1. 并发闸门：同时 ≤2，5 个任务全部完成 ==');
  const gate = new TaskGate({ maxConcurrent: 2, budgetMs: 5000 });
  let concurrent = 0, peak = 0;
  const jobs = Array.from({ length: 5 }, (_, i) =>
    gate.run('t' + i, async () => { concurrent++; peak = Math.max(peak, concurrent); await sleep(40); concurrent--; return i; }, -1));
  const res = await Promise.all(jobs);
  assert('峰值并发 ≤ 2', peak <= 2, 'peak=' + peak);
  assert('5 个任务全部完成', res.length === 5 && res.every(r => r >= 0 && r < 5), JSON.stringify(res));
  assert('指标 completed=5', gate.metrics.completed === 5, JSON.stringify(gate.metrics));

  console.log('== 2. 时间预算：超时被中断并返回降级值，槽位释放 ==');
  const gate2 = new TaskGate({ maxConcurrent: 1, budgetMs: 30 });
  const slow = gate2.run('slow', () => sleep(300).then(() => 'done'), 'DEGRADED');
  const fast = gate2.run('fast', () => 'ok', 'DEGRADED');
  const r1 = await slow; const r2 = await fast;
  assert('慢任务返回降级值', r1 === 'DEGRADED', 'r1=' + r1);
  assert('慢任务记 timedOut', gate2.metrics.timedOut === 1, JSON.stringify(gate2.metrics));
  assert('快任务仍正常完成', r2 === 'ok', 'r2=' + r2);
  assert('槽位已释放(running=0)', gate2.metrics.running === 0, JSON.stringify(gate2.metrics));

  console.log('== 3. 背压队列：满则丢弃最旧并计数 ==');
  const q = new BackpressureQueue({ max: 3, policy: 'drop-oldest' });
  [1, 2, 3, 4, 5].forEach(x => q.push(x));
  assert('长度封顶=3', q.length === 3, 'len=' + q.length);
  assert('丢弃计数=2', q.dropped === 2, 'dropped=' + q.dropped);
  assert('保留最新3个', JSON.stringify(q.items) === JSON.stringify([3, 4, 5]), JSON.stringify(q.items));

  console.log('== 4. 空闲判定 ==');
  const idle = new IdleGovernor({ idleMs: 100 });
  idle.touch();
  assert('刚 touch 不空闲', idle.isIdle() === false);
  await sleep(130);
  assert('超阈值判为空闲', idle.isIdle() === true);

  console.log('== 5. 退避抓取：目标不可达返回 null，不抛异常、不卡死 ==');
  const t0 = Date.now();
  const r = await expBackoffFetch('http://127.0.0.1:1/nope', { timeoutMs: 200, max: 1500, base: 100 });
  const dt = Date.now() - t0;
  assert('不可达返回 null', r === null, 'r=' + r);
  assert('有退避但 2s 内返回', dt < 2000, 'dt=' + dt + 'ms');

  console.log('== 6. 日志节流：突发 200 行，落盘 ≤ 上限+1 ==');
  let sunk = 0;
  const tl = new ThrottledLogger({ linesPerMin: 10, sink: () => { sunk++; } });
  for (let i = 0; i < 200; i++) tl.log('line ' + i);
  assert('落盘行数 ≤ 11（上限10+1提示）', sunk <= 11, 'sunk=' + sunk);
  assert('丢弃计数 > 0', tl.dropped > 0, 'dropped=' + tl.dropped);

  console.log('== 7. Governor 聚合：snapshot 含增量 CPU / 内存 / 空闲 ==');
  const gov = createGovernor();
  gov.touch();
  const s1 = gov.snapshot();
  await sleep(50);
  const s2 = gov.snapshot();
  assert('snapshot 含 memRssMb', typeof s1.memRssMb === 'number' && s1.memRssMb > 0);
  assert('snapshot 含 idle 状态', s2.idle === false);
  assert('两次采样 CPU 增量为数字', typeof s2.cpu.userMs === 'number');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('自测异常:', e); process.exit(2); });
