const fs = require('fs');
const path = require('path');
const ROOT = 'E:/Fab/fab-mes';
const targets = [
  'portal.html','console.html','eap-console.html','erp-ops.html','wms-ops.html','config-admin.html',
  'twin.html','line-twin.html','fab-twin.html','sim.html','lab.html','agent.html',
  'twin3d/portal.html','twin3d/index.html'
];
const marker = '<a href="/config-admin.html">主数据配置</a>';
const link = '<a href="/npi-ops.html">NPI 流片</a>';
let modified = [], skipped = [];
for (const f of targets) {
  const fp = path.join(ROOT, f);
  if (!fs.existsSync(fp)) { skipped.push(f + '(missing)'); continue; }
  let c = fs.readFileSync(fp, 'utf8');
  if (c.includes('npi-ops.html')) { skipped.push(f + '(has link)'); continue; }
  if (!c.includes(marker)) { skipped.push(f + '(no marker)'); continue; }
  c = c.replace(marker, marker + link);
  fs.writeFileSync(fp, c, 'utf8');
  modified.push(f);
}
console.log('MODIFIED:', modified.join(', ') || '(none)');
console.log('SKIPPED :', skipped.join(', ') || '(none)');
