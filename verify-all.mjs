// 统一回归套件：依次运行 P0 + P1-1..P1-5 全部验收脚本，汇总 pass/fail。
// 用法：
//   node verify-all.mjs              # 跑全部（P0 全链路最慢，约 1~3 分钟）
//   node verify-all.mjs --skip-p0    # 跳过 P0，只跑 P1 组（快速，约 30s）
//   node verify-all.mjs --only=P1-3  # 只跑单个脚本
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const NODE = 'C:/Users/35657/.workbuddy/binaries/node/versions/22.22.2/node.exe';
const MES = 'http://127.0.0.1:8124';

const PORTS = [5000, 8123, 8124, 8125, 8126, 8127, 8128];
const SCRIPTS = [
  { id: 'P0',   file: 'verify-p0.mjs',   desc: 'OTD 主轴贯通（SO→WO→生产→发运→签收→收款）', timeout: 240000 },
  { id: 'P1-1', file: 'verify-p1-1.mjs', desc: 'FDC→自动响应闭环（fdcAlarm→fdcAutoResp+pdmAlert）', timeout: 60000 },
  { id: 'P1-2', file: 'verify-p1-2.mjs', desc: 'APC setpoint 回灌设备（EAP S2F41→deviceParams）', timeout: 60000 },
  { id: 'P1-3', file: 'verify-p1-3.mjs', desc: 'VM→APC 联动（vmPrediction 总线驱动）', timeout: 60000 },
  { id: 'P1-4', file: 'verify-p1-4.mjs', desc: 'APS→dispatch 调度闭环（plan→directive→_pick）', timeout: 60000 },
  { id: 'P1-5', file: 'verify-p1-5.mjs', desc: 'Agent 编排器串五大引擎上 OTD 主轴', timeout: 60000 },
];

const skipP0 = process.argv.includes('--skip-p0');
const onlyId = process.argv.find(a => a.startsWith('--only='))?.split('=')[1];

function tcpUp(port) {
  return new Promise(res => {
    const s = net.connect(port, '127.0.0.1');
    s.setTimeout(800);
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('timeout', () => { s.destroy(); res(false); });
    s.on('error', () => { s.destroy(); res(false); });
  });
}

function run(spec) {
  return new Promise(resolve => {
    const child = spawn(NODE, [join(__dir, spec.file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; process.stdout.write(d); });
    child.stderr.on('data', d => { err += d; process.stderr.write(d); });
    const to = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: 124, out, err, timeout: true }); }, spec.timeout);
    child.on('close', code => { clearTimeout(to); resolve({ code, out, err, timeout: false }); });
  });
}

function parse(out) {
  const m = out.match(/== (P0|P1-\d) 结果：通过 (\d+) \/ 失败 (\d+) ==/);
  if (m) return { pass: +m[2], fail: +m[3] };
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function postConfig(body) {
  try { await fetch(MES + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch {}
}

(async () => {
  // 1) 前置：探活全栈端口
  console.log('— 前置：探活 fab-mes 全栈端口 —');
  const down = [];
  for (const p of PORTS) if (!(await tcpUp(p))) down.push(p);
  if (down.length) {
    console.log(`  [FAIL] 以下端口未监听：${down.join(', ')}`);
    console.log('  请先启动：bash bin/start-community.sh');
    process.exit(2);
  }
  console.log(`  [PASS] 端口 ${PORTS.join('/')} 全部在线`);

  // 2) 降载：关 autoWo 避免事件风暴压垮 WMS 事件循环（验收期惯例，重启即恢复）
  await postConfig({ autoWo: false, speed: 600 });
  console.log('  [PASS] 已下发 autoWo=false（验收降载）\n');

  // 3) 依次运行
  const results = [];
  for (const s of SCRIPTS) {
    if (skipP0 && s.id === 'P0') continue;
    if (onlyId && s.id !== onlyId) continue;
    console.log(`\n${'='.repeat(64)}\n# 运行 ${s.id} — ${s.desc}\n${'='.repeat(64)}`);
    const r = await run(s);
    const p = parse(r.out);
    const failed = r.code !== 0 || !!r.timeout || (p && p.fail > 0);
    const failCount = r.timeout ? 1 : (p ? p.fail : (failed ? 1 : 0));
    const passCount = p ? p.pass : 0;
    if (failed) console.log(`  >>> ${s.id} 退出码=${r.code}${r.timeout ? ' (TIMEOUT)' : ''}`);
    results.push({ id: s.id, desc: s.desc, code: r.code, pass: passCount, fail: failCount, failed, timeout: r.timeout });
    await sleep(300); // 让端口/总线稍微喘息，避免连续冲击
  }

  // 4) 汇总
  console.log(`\n\n${'#'.repeat(66)}\n# 统一回归套件结果\n${'#'.repeat(66)}`);
  let totalPass = 0, totalFail = 0, anyFail = false;
  for (const r of results) {
    const tag = r.failed ? 'FAIL' : 'PASS';
    console.log(`  [${tag}] ${r.id.padEnd(4)} ${r.desc}`);
    if (r.timeout) console.log(`          (超时 ${r.timeout})`);
    totalPass += r.pass; totalFail += r.fail;
    if (r.failed) anyFail = true;
  }
  console.log(`\n  脚本数=${results.length}  通过项=${totalPass}  失败项=${totalFail}`);
  console.log(anyFail ? '  结论：存在失败项 [FAIL]' : '  结论：全部通过 [PASS]');
  process.exit(anyFail ? 1 : 0);
})();
