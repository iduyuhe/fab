// ============================================================
//  C3 验证：FDC 多变量异常检测（detectMultivariate）真实样本驱动
//  说明：P1-1 的 verify-p1-1 注入的是**合成 fdcAlarm**，从未用真实多变量
//        样本驱动检测引擎。本用例用 4 变量样本矩阵（wph/util/temp/press）
//        ① 纯基线 → 应 0 误报（特异性）② 注入离群样本 → 应检出（灵敏度）。
//  运行：node verify-fdc-real.mjs
// ============================================================
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { detectMultivariate } = require('./fdc');

// 简易高斯噪声（Box-Muller）
function gauss(mean = 0, sd = 1) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const VARS = ['wph', 'util', 'temp', 'press'];
// 标称工作点（4 变量）
const NOMINAL = { wph: 120, util: 70, temp: 320, press: 1.2 };

// 生成 N 个围绕标称、低噪声的基线样本
function baseline(n, sd = 2) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ tool: 'TEST-TOOL', vars: {
      wph: +gauss(NOMINAL.wph, sd).toFixed(2),
      util: +gauss(NOMINAL.util, sd).toFixed(2),
      temp: +gauss(NOMINAL.temp, sd).toFixed(2),
      press: +gauss(NOMINAL.press, sd * 0.05).toFixed(3),
    } });
  }
  return out;
}

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  [PASS] ${name} ${extra}`); } else { fail++; console.log(`  [FAIL] ${name} ${extra}`); } };

console.log('C3 · FDC 多变量检测真实样本验证');

// ① 特异性：纯基线（30 样本）应低误报（χ² 95% 阈值下理论 ~5%，允许 ≤2 误报）
const baseSamples = baseline(30);
const r1 = detectMultivariate(baseSamples);
check('纯基线低误报(≤2/30)', r1.anomalies.length <= 2, `(anomalies=${r1.anomalies.length}, thr=${r1.threshold})`);

// ② 灵敏度：基线上注入 1 个强离群（各变量 +6σ）
const withOutlier = baseline(30).concat([{ tool: 'TEST-TOOL', vars: {
  wph: +(NOMINAL.wph + 6 * 3).toFixed(2),
  util: +(NOMINAL.util + 6 * 3).toFixed(2),
  temp: +(NOMINAL.temp + 6 * 3).toFixed(2),
  press: +(NOMINAL.press + 6 * 0.15).toFixed(3),
} }]);
const r2 = detectMultivariate(withOutlier);
const outScore = r2.scoreByTool['TEST-TOOL'];
check('离群样本被检出', r2.anomalies.length >= 1, `(anomalies=${r2.anomalies.length})`);
check('异常分值超阈值', outScore != null && outScore > r2.threshold, `(score=${outScore}, thr=${r2.threshold})`);
check('TOP 贡献变量非空', Array.isArray(r2.contrib['TEST-TOOL']) && r2.contrib['TEST-TOOL'].length > 0,
  `(${(r2.contrib['TEST-TOOL'] || []).map(c => c.var).join('/')})`);

// ③ 引擎级：直接走 FDC.assess 累积真实样本后触发分数
const { FDC } = require('./fdc');
const fdc = new FDC({ maxBuf: 30 });
for (const s of baseline(20)) fdc.feed(s, {}, { vars: s.vars });
const a = fdc.assess({ id: 'TEST-TOOL', wph: 220, util: 88 }, { avgWph: 120, module: 'LITHO' },
  { vars: { wph: 220, util: 88, temp: 500, press: 2.0 } });
check('FDC.assess 累积基线后给出 score', typeof a.score === 'number', `(score=${a.score}, thr=${a.mvThreshold})`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
