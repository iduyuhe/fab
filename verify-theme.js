// U5 验收：门户是否 serve /theme.css、报告文档是否可经门户访问且引用主题、六灯是否仍在
const http = require('http');
const enc = p => encodeURI(p);
const paths = [
  '/theme.css',
  '/项目总结报告.html',
  '/docs/otd-lifecycle-audit.html',
  '/战略白皮书-AI晶圆工厂智能企业平台.html',
  '/console.html',
];
let i = 0;
function next() {
  if (i >= paths.length) return;
  const p = paths[i++];
  http.get({ host: '127.0.0.1', port: 8123, path: enc(p) }, r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => {
      console.log(`${p} -> ${r.statusCode} [${r.headers['content-type']}] hasTheme=${d.includes('theme.css')} hasLamp=${d.includes('health-lamp.js')}`);
      next();
    });
  }).on('error', e => { console.log(`${p} ERR ${e.message}`); next(); });
}
next();
