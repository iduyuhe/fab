// Phase 8 联合寻优 — 验证脚本
// 1) 整段 module script 语法检查  2) stub readCfg/document 跑 optimizeFab，断言规则维度价值
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

// ---- 2) 提取纯逻辑段 ----
function findLine(re) { const i = lines.findIndex(l => re.test(l)); if (i < 0) throw new Error('not found: ' + re); return i; }
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
const seg = (l0, l1) => lines.slice(l0, l1 + 1).join('\n');

let parts = [];
const rndL = findLine(/const rnd = /);
parts.push(lines[rndL], lines[rndL + 1]);
const modL = findLine(/const MODULES = \[/);
const toolsL = findLine(/const tools = \[\];/);
parts.push(seg(modL, toolsL - 1));
const domL = findLine(/const app = document/);
parts.push(seg(toolsL, domL - 1));
const gauL = findLine(/function gauss\(\)/);
parts.push(seg(gauL, pairFrom(gauL, '{')));
const heapL = findLine(/class Heap/);
parts.push(seg(heapL, pairFrom(heapL, '{')));
const desL = findLine(/function runDES\(cfg\)/);
parts.push(seg(desL, pairFrom(desL, '{')));
const mcL = findLine(/function runMonteCarlo\(cfg\)/);
parts.push(seg(mcL, pairFrom(mcL, '{')));
// Phase 4 纯逻辑：POWER / getUtil / estimateYield / estimateEnergy / RULE_SET / optimizeFab
const pL = findLine(/const POWER=/);
parts.push(lines[pL]);
const guL = findLine(/const getUtil=/);
parts.push(lines[guL]);
const eyL = findLine(/function estimateYield\(res\)/);
parts.push(seg(eyL, pairFrom(eyL, '{')));
const eeL = findLine(/function estimateEnergy\(cfg,res\)/);
parts.push(seg(eeL, pairFrom(eeL, '{')));
const rsL = findLine(/const RULE_SET=/);
parts.push(seg(rsL, pairFrom(rsL, '[')));
const ofL = findLine(/function optimizeFab\(\)/);
parts.push(seg(ofL, pairFrom(ofL, '{')));

const combined = parts.join('\n');
const sandbox = { console, Math, Set, Map, Array,
  document: { getElementById: id => ({ value: '26', style: {}, textContent: '', innerHTML: '', addEventListener() {} }) } };
vm.createContext(sandbox);
try {
  new vm.Script(combined + '\n;readCfg=()=>({lambda:18,passes:3,cv:0.15,horizon:168,reps:6,rule:\'HYBRID\',hybridBn:[\'LITHO\'],hybridBnRule:\'BN\',hybridOtherRule:\'FIFO\',toolDelta:{},dyn:false}); globalThis.__opt=optimizeFab;')
    .runInContext(sandbox);
} catch (e) { console.error('FAIL 加载:', e.message); process.exit(1); }

// ---- 3) 联合寻优测试（目标 26 lots/hr，重载场景，规则差异应体现） ----
console.log('联合寻优 target=26 …');
const t0 = Date.now();
const opt = sandbox.__opt();
console.log('耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
opt.byRule.forEach(x => {
  const b = x.best;
  console.log('  ' + x.label.padEnd(22) + ' 瓶颈=' + x.bn.padEnd(5) +
    (b ? ' 增机=' + b.add + ' 吞吐=' + b.r.throughput.toFixed(1) + ' 成本=$' + b.score.toFixed(0) + 'M' : ' 不可行'));
});
console.log('全局最优: ' + (opt.best ? opt.best.ruleLabel + ' 成本=$' + opt.best.score.toFixed(0) + 'M (增机 ' + opt.best.add + ', 吞吐 ' + opt.best.r.throughput.toFixed(1) + ')' : '无'));

// ---- 断言 ----
let ok = true;
const checks = [];
const fifo = opt.byRule.find(x => x.rule === 'FIFO');
checks.push(['byRule 覆盖 6 规则', opt.byRule.length === 6]);
checks.push(['存在全局可行最优', !!opt.best]);
checks.push(['全局最优带规则名', !!opt.best && !!opt.best.ruleLabel]);
checks.push(['FIFO 有结果(可行或不可行)', !!fifo && (!!fifo.best || !!fifo.bestEffort)]);
if (opt.best && fifo && fifo.best) {
  // 联合寻优核心价值：存在规则 ≤ FIFO 成本（FIFO 不严格更优）
  const nonFifoBetter = opt.byRule.some(x => x.best && x.rule !== 'FIFO' && x.best.score <= fifo.best.score + 1e-9);
  checks.push(['存在规则成本 ≤ FIFO（联合寻优有效）', nonFifoBetter]);
}
checks.forEach(([n, c]) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) ok = false; });
console.log(ok ? '\n=== 全部通过 ===' : '\n=== 存在失败 ===');
process.exitCode = ok ? 0 : 1;
