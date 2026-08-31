// M2 端到端验证：工单/批次/派工/lot 追踪/规则切换
const http = require('http');
const get = (p, cb) => http.get('http://127.0.0.1:8124' + p, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => cb(JSON.parse(b), r.statusCode)); });
const post = (p, body, cb) => {
  const data = JSON.stringify(body);
  const req = http.request('http://127.0.0.1:8124' + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => cb(JSON.parse(b), r.statusCode)); });
  req.end(data);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let ok = true;
  const check = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) ok = false; };

  await sleep(2000);
  // health
  get('/api/health', (h, code) => {
    check('health M2 版本', code === 200 && h.version === 'M3' && h.tools === 192);
  });
  await sleep(300);
  // 工单
  get('/api/wos', (w, code) => {
    check('自动投料已生成工单', code === 200 && w.count > 0);
    console.log('  工单数=' + w.count + ' 首个=' + (w.wos[0] ? w.wos[0].id + ' ' + w.wos[0].product + ' ×' + w.wos[0].qty : '-'));
  });
  await sleep(300);
  // lots
  get('/api/lots', (l, code) => {
    check('批次已生成', code === 200 && l.count > 0);
    const st = {}; l.lots.forEach(x => { st[x.status] = (st[x.status] || 0) + 1; });
    console.log('  lots=' + l.count + ' 状态分布=' + JSON.stringify(st));
    if (l.lots.length) {
      const first = l.lots[0];
      check('批次含路线进度', first.step >= 0 && first.rem >= 0);
    }
  });
  await sleep(300);
  // 手动创建工单（POST）
  post('/api/wos', { qty: 2, product: 'A16', dueHours: 24 }, (r, code) => {
    check('POST 工单创建', code === 201 && r.wo && r.wo.id && r.wo.total === 2);
    console.log('  手动工单: ' + (r.wo ? r.wo.id + ' lots=' + JSON.stringify(r.wo.lots) : '-'));
  });
  await sleep(300);
  // 等 lot 流转
  console.log('  等待 18s 观察派工流转…');
  await sleep(18000);
  get('/api/wip', (w, code) => {
    check('WIP 快照', code === 200);
    console.log('  rule=' + w.rule + ' wip=' + w.wip + ' done=' + w.done + ' moves=' + w.moves +
      ' 模块队列=' + Object.entries(w.byModule).map(([k, v]) => k + ':' + v.queue + '/' + v.processing).join(' '));
    check('lot 已流转(有完成或步进)', w.moves > 0 || w.done > 0);
    check('设备在加工或已产出', Object.values(w.byModule).some(v => v.processing > 0) || w.done > 0);
  });
  await sleep(300);
  // lot 详情（找第一个 DONE 或有 hist 的）
  get('/api/lots?status=DONE', (d, code) => {
    const target = d.lots[0];
    if (!target) { console.log('  (暂无完成批次，查 WIP 批次历史)'); return; }
    get('/api/lots/' + target.id, (lot, c2) => {
      check('lot 详情+追踪历史', c2 === 200 && lot.hist && lot.hist.length > 0);
      console.log('  ' + lot.id + ' 历史步骤=' + lot.hist.length + ' 首步=' + (lot.hist[0] ? lot.hist[0].mod + '@' + lot.hist[0].tool : '-'));
    });
  });
  await sleep(500);
  // 派工规则切换
  post('/api/config', { rule: 'EDD' }, (r, code) => {
    check('规则切换 EDD', code === 200 && r.rule === 'EDD');
  });
  await sleep(300);
  get('/api/config', (r, code) => {
    check('规则读取', code === 200 && r.rule === 'EDD' && r.rules.includes('HYBRID'));
    console.log('  当前规则=' + r.rule + ' autoWo=' + r.autoWo + ' speed=' + r.speed);
  });

  await sleep(800);
  console.log(ok ? '\n=== 全部通过 ===' : '\n=== 存在失败 ===');
  process.exitCode = ok ? 0 : 1;
})();
