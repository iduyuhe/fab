// Phase 7 动态再调度 — 验证脚本 v2
// 1) 整段 module script 语法检查 (node --check, 支持静态 import)
// 2) 动态提取纯逻辑段(括号配对)做桩数据逻辑测试，避开 DOM/3D 代码
const fs = require('fs');
const vm = require('vm');
const { spawnSync } = require('child_process');
const html = fs.readFileSync('E:/Fab/fab-mes/twin3d/index.html', 'utf8');
const lines = html.split('\n');

// ---- 1) 语法检查 ----
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) { console.error('FAIL: 未找到 module script'); process.exit(1); }
const tmp = 'E:/Fab/fab-mes/twin3d/tools/_check.mjs';
fs.writeFileSync(tmp, m[1]);
const chk = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
if (chk.status !== 0) { console.error('FAIL 语法:\n' + chk.stderr); process.exit(1); }
console.log('PASS 语法: module script OK (' + m[1].length + ' chars)');

// ---- 2) 括号配对提取（不跳过字符串：代码内 { } [ ] 均成对） ----
function findLine(re) { const i = lines.findIndex(l => re.test(l)); if (i < 0) throw new Error('not found: ' + re); return i; }
// 从 startLine 起，对第 pos 个字符（'{' 或 '['）做配对，返回闭合行
function pairFrom(startLine, openCh) {
  const closeCh = openCh === '{' ? '}' : ']';
  let depth = 0, begun = false;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === openCh) { depth++; begun = true; }
      else if (ch === closeCh) { depth--; if (begun && depth === 0) return i; }
    }
  }
  throw new Error('unbalanced ' + openCh + ' from line ' + (startLine + 1));
}
// 取 [l0, l1] 行文本（含两端）
const seg = (l0, l1) => lines.slice(l0, l1 + 1).join('\n');

let parts = [];
// rnd / clamp
const rndL = findLine(/const rnd = /);
parts.push(lines[rndL], lines[rndL + 1]);
// MODULES 数组 + pickStatus（纯数据/纯函数区：到 tools 定义前一行）
const modL = findLine(/const MODULES = \[/);
const toolsL = findLine(/const tools = \[\];/);
parts.push(seg(modL, toolsL - 1));
// tools 构建段（纯数据，到 3D/DOM 起点前）
const domL = findLine(/const app = document/);
parts.push(seg(toolsL, domL - 1));
// gauss
const gauL = findLine(/function gauss\(\)/);
parts.push(seg(gauL, pairFrom(gauL, '{')));
// Heap class
const heapL = findLine(/class Heap/);
parts.push(seg(heapL, pairFrom(heapL, '{')));
// runDES
const desL = findLine(/function runDES\(cfg\)/);
parts.push(seg(desL, pairFrom(desL, '{')));
// runMonteCarlo
const mcL = findLine(/function runMonteCarlo\(cfg\)/);
parts.push(seg(mcL, pairFrom(mcL, '{')));

const combined = parts.join('\n');
const sandbox = { console, Math, Set, Map, Array };
vm.createContext(sandbox);
try {
  new vm.Script(combined + '\n;globalThis.__runDES=runDES; globalThis.__runMC=runMonteCarlo;')
    .runInContext(sandbox);
} catch (e) { console.error('FAIL 加载:', e.message); process.exit(1); }

const { __runDES: runDES, __runMC: runMC } = sandbox;
const totalTools = 192;
const base = { lambda: 18, passes: 3, cv: 0.15, horizon: 168, rule: 'HYBRID', hybridBn: ['LITHO'], hybridBnRule: 'BN', hybridOtherRule: 'FIFO' };
const safe = (name, fn) => { try { return fn(); } catch (e) { console.error('EXC ' + name + ':', e && (e.stack || e.message || String(e))); process.exitCode = 1; throw e; } };

// A: dyn 关闭 → 无停机/无再调度
const off = safe('A', () => runMC({ ...base, reps: 3, dyn: false }));
console.log('A dyn off: thr=' + off.thr.toFixed(2) + ' 停机=' + off.resched.nBreakdown.toFixed(2) +
  ' 切换=' + off.resched.nBnSwitch.toFixed(2) + ' 升级=' + off.resched.nDueEsc.toFixed(2));

// B: dyn 开启 → 停机注入 + 动态瓶颈 + 交期升级
console.log('B 开始…');
const on = safe('B', () => runMC({ ...base, reps: 4, dyn: true, dnDetect: true, dnDue: true, downtimeRate: 1 / (totalTools * 2) }));
console.log('B 结束…');
console.log('B dyn on : thr=' + on.thr.toFixed(2) + ' 停机=' + on.resched.nBreakdown.toFixed(2) +
  ' 切换=' + on.resched.nBnSwitch.toFixed(2) + ' 升级=' + on.resched.nDueEsc.toFixed(2) +
  ' 时间线=' + on.resched.bnTimeline.length + ' 事件=' + on.resched.events.length);
console.log('  样本事件:', on.resched.events.slice(0, 3).map(e => '[' + e.t + 'h ' + e.type + '] ' + e.text).join(' | '));

// C: 单次 DES 直查
const one = safe('C', () => runDES({ ...base, dyn: true, dnDetect: true, dnDue: true, downtimeRate: 1 / (totalTools * 2) }));
console.log('C 单次DES: 停机=' + one.resched.nBreakdown + ' 切换=' + one.resched.nBnSwitch + ' 升级=' + one.resched.nDueEsc);

// ---- 断言 ----
let ok = true;
const checks = [
  ['A 关闭时无停机', off.resched.nBreakdown === 0],
  ['A 关闭时无切换', off.resched.nBnSwitch === 0],
  ['B 开启时停机>0', on.resched.nBreakdown > 0],
  ['B 瓶颈时间线非空', on.resched.bnTimeline.length > 0],
  ['B 再调度事件有记录', on.resched.events.length > 0],
  ['B 吞吐合理>0', on.thr > 0],
  ['C 单次停机>0', one.resched.nBreakdown > 0],
];
checks.forEach(([n, c]) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) ok = false; });
console.log(ok ? '\n=== 全部通过 ===' : '\n=== 存在失败 ===');
process.exitCode = ok ? 0 : 1;
