// U5：给所有报告类文档注入统一主题基底引用（相对路径，file:// 与门户均可加载）
const fs = require('fs');
const path = require('path');
const root = process.cwd();

// 仅报告类/文档类 HTML；运营页(console/twin/agent/erp-ops/wms-ops/npi-ops/lab/eap-console/config-admin/portal/sim + twin3d/*) 不注入
const reports = [
  '3D物理工厂孪生模块核查报告.html',
  'APC执行级闭环推进报告_2026-08-27.html',
  'qa_reverify_2026-08-23.html',
  'qa_audit_report.html',
  '开发规划-四级AI晶圆工厂平台.html',
  '战略审计报告_2026-08-27_总览.html',
  '战略审计与功能补全_复验报告_2026-08-23.html',
  '项目总结报告.html',
  '战略白皮书-AI晶圆工厂智能企业平台.html',
  '租户模块代码审计报告_2026-08-27.html',
  'WMS新建与接入数字主线报告.html',
  'otd5-walkthrough-report.html',
  'qa_mainline_report.html',
  '真实协议适配器接通主轴报告.html',
  'docs/otd-lifecycle-audit.html',
];

let n = 0;
for (const rel of reports) {
  const fp = path.join(root, rel);
  if (!fs.existsSync(fp)) { console.log('skip(missing):', rel); continue; }
  let s = fs.readFileSync(fp, 'utf8');
  if (s.includes('theme.css')) { console.log('skip(already):', rel); continue; }
  const href = rel.includes('/') ? '../theme.css' : 'theme.css';
  const tag = `<link rel="stylesheet" href="${href}">`;
  if (s.includes('</head>')) s = s.replace('</head>', `  ${tag}\n</head>`);
  else if (s.includes('<head>')) s = s.replace('<head>', `<head>\n  ${tag}`);
  else s = `${tag}\n` + s;
  fs.writeFileSync(fp, s);
  n++;
  console.log('injected:', rel, '->', href);
}
console.log('total injected:', n);
