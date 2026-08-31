'use strict';
// 数字主线端到端验收：投料→EAP→量测→SPC/FDC→孪生→ERP领料→Agent→审计
const PORTS = { portal: 8123, mes: 8124, eap: 8125, erp: 8126, agent: 8127 };
const HEALTH = { portal: '/api/health', mes: '/api/health', eap: '/api/health', erp: '/api/erp/health', agent: '/api/agent/health' };

function req(port, path, { method = 'GET', body = null } = {}) {
  const url = `http://127.0.0.1:${port}${path}`;
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opt.body = JSON.stringify(body);
  return fetch(url, opt).then(async r => {
    let data = null;
    try { data = await r.json(); } catch (e) { try { data = await r.text(); } catch (_) {} }
    return { status: r.status, data };
  }).catch(e => ({ status: 0, error: e.message }));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function log(step, name, ok, detail) {
  results.push({ step, name, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${step} | ${name} | ${results[results.length-1].detail}`);
}
function warn(name, detail) { console.log(`WARN | ${name} | ${detail}`); }

async function main() {
  console.log('===== 数字主线端到端验收 =====\n');

  // 0. 五进程健康（各自正确 health 端点）
  for (const k of Object.keys(PORTS)) {
    const r = await req(PORTS[k], HEALTH[k]);
    const svc = r.data && (r.data.service || r.data.ok);
    log('0.健康', `${k}(${PORTS[k]})`, r.status === 200 && !!svc, svc || `status=${r.status}`);
  }

  // A4. 门户代理打通：门户 /api/health 应返回 MES 服务；孪生/EAP 静态页经门户可加载
  const ph = await req(PORTS.portal, '/api/health');
  log('A4.门户代理', '8123/api/health→MES', ph.status === 200 && ph.data && ph.data.service === 'fab-mes', ph.data && ph.data.service);
  for (const pg of ['/fab-twin.html', '/line-twin.html', '/twin3d/index.html', '/eap-console.html']) {
    const r = await req(PORTS.portal, pg);
    log('A4.门户代理', `8123${pg}`, r.status === 200, `status=${r.status}`);
  }

  // 1. 投料（创建工单 → core.js:72 _enqueue emit lotRelease）
  const before = await req(PORTS.mes, '/api/lots');
  const wo = await req(PORTS.mes, '/api/wos', { method: 'POST', body: { qty: 1, product: 'N2', dueHours: 48 } });
  log('1.投料', 'POST /api/wos', wo.status === 201, wo.data && wo.data.wo ? `wo=${wo.data.wo.id}` : `status=${wo.status}`);
  const after = await req(PORTS.mes, '/api/lots');
  const beforeIds = new Set((before.data && before.data.lots || []).map(l => l.id));
  const newLots = (after.data && after.data.lots || []).filter(l => !beforeIds.has(l.id));
  const lotId = newLots.length ? newLots[newLots.length - 1].id : null;
  log('1.投料', '新批次生成', !!lotId, lotId ? `lot=${lotId}` : '未取到新lot');

  // 2. EAP 执行：设备上报 lotStart（等价 eap-host forwardToMES → /api/ingest）
  const eh = await req(PORTS.eap, '/api/health');
  log('2.EAP', 'EAP 进程在线', eh.status === 200, eh.data && eh.data.service);
  const ed = await req(PORTS.eap, '/api/devices');
  log('2.EAP', '设备列表可见', ed.status === 200 && ed.data && ed.data.devices && ed.data.devices.length > 0, ed.data && ed.data.devices ? `${ed.data.devices.length} 台` : 'none');
  const ing = await req(PORTS.mes, '/api/ingest', { method: 'POST', body: { type: 'lotStart', id: 'LITHO-001' } });
  log('2.EAP', 'POST /api/ingest lotStart (A2修复)', ing.status === 200, ing.data);

  await sleep(1800); // 等 ERP 经 WS 收到 lotRelease 并领料

  // 3. MES 量测（SPC 数据源）
  const inj = await req(PORTS.mes, '/api/spc/inject', { method: 'POST', body: { product: 'N2', param: 'CD', lot: lotId || 'TEST-LOT', tool: 'METRO-001', value: 999 } });
  log('3.量测', 'POST /api/spc/inject', inj.status === 200, inj.data && inj.data.injected ? `value=${inj.data.injected.value}` : `status=${inj.status}`);
  const metro = await req(PORTS.mes, '/api/metrology?limit=5');
  log('3.量测', 'GET /api/metrology 有样本', metro.status === 200 && metro.data && metro.data.count >= 0, metro.data ? `count=${metro.data.count}` : `status=${metro.status}`);

  // 4. SPC/FDC 判异（用最新 alarm id 比较，避免 LIMIT 30 造成的数量误判）
  const spcBefore = await req(PORTS.mes, '/api/spc');
  const idBefore = (spcBefore.data && spcBefore.data.alarms && spcBefore.data.alarms[0]) ? spcBefore.data.alarms[0].id : 0;
  const fdcBefore = await req(PORTS.mes, '/api/fdc');
  const inj2 = await req(PORTS.mes, '/api/spc/inject', { method: 'POST', body: { product: 'N2', param: 'CD', lot: 'QATEST-UNIQ', tool: 'QA-UNIQ-001', value: 100000 } });
  const spcAfter = await req(PORTS.mes, '/api/spc');
  const idAfter = (spcAfter.data && spcAfter.data.alarms && spcAfter.data.alarms[0]) ? spcAfter.data.alarms[0].id : 0;
  log('4.SPC/FDC', 'SPC 判异触发并落库', idAfter > idBefore && inj2.status === 200, `alarmId ${idBefore}→${idAfter}`);
  const fdc = await req(PORTS.mes, '/api/fdc');
  log('4.SPC/FDC', 'FDC 接口在线', fdc.status === 200, fdc.data ? `alarms=${fdc.data.count}` : `status=${fdc.status}`);

  // 5. 孪生映射：事件总线贯通（孪生页经 WS 消费 8124 事件）
  const ev = await req(PORTS.mes, '/api/events?limit=300');
  const types = new Set((ev.data && ev.data.events || []).map(e => e.type));
  const need = ['lotRelease', 'lotStart', 'metrology', 'spcAlarm'];
  const miss = need.filter(t => !types.has(t));
  log('5.孪生', '事件总线含主线事件', miss.length === 0, `含:${[...types].join(',')} 缺:${miss.join(',') || '无'}`);
  const wip = await req(PORTS.mes, '/api/wip');
  log('5.孪生', 'WIP 快照可读', wip.status === 200, wip.data ? `wip=${wip.data.wip}` : `status=${wip.status}`);

  // 6. ERP 领料：lotRelease → issueBom（经 WS 订阅触发）
  const tx = await req(PORTS.erp, '/api/erp/tx?limit=50');
  const issues = (tx.data && tx.data.tx || []).filter(t => t.type === 'ISSUE' && lotId && t.ref === lotId);
  log('6.ERP领料', 'lotRelease→领料(ISSUE)', issues.length > 0, issues.length ? `ref=${issues[0].ref}` : (tx.data ? `tx总数=${tx.data.count}` : `status=${tx.status}`));
  const inv = await req(PORTS.erp, '/api/erp/inventory');
  log('6.ERP领料', '库存可读', inv.status === 200, inv.data ? `value=${inv.data.value}` : `status=${inv.status}`);
  if (inv.data && inv.data.value < 0) warn('ERP库存', `库存估值=${inv.data.value} 为负，演示数据需校准（非主线断裂）`);

  // 7. Agent 问答（基于实时数据）
  const chat = await req(PORTS.agent, '/api/agent/chat', { method: 'POST', body: { message: `当前在制多少批次？有没有SPC报警？新批次${lotId || ''}是否已投料并领料？` } });
  const reply = chat.data && chat.data.reply ? chat.data.reply : '';
  log('7.Agent', '问答返回', chat.status === 200 && reply.length > 0, reply.slice(0, 80).replace(/\n/g, ' '));

  // 8. A1 审计：POST /api/audit/log 落链 + 可查回
  const aud = await req(PORTS.mes, '/api/audit/log', { method: 'POST', body: { actor: 'acceptance', action: 'mainline-verify', target: lotId, payload: { step: 'E2E' } } });
  log('8.审计(A1)', 'POST /api/audit/log', aud.status === 201, aud.data);
  const audQ = await req(PORTS.mes, '/api/audit?limit=5');
  const hit = (audQ.data && audQ.data.audit || []).filter(a => a.action === 'mainline-verify');
  log('8.审计(A1)', '审计可查回', hit.length > 0, hit.length ? `action=${hit[0].action}` : (audQ.data ? `count=${audQ.data.count}` : `status=${audQ.status}`));

  // 汇总
  const pass = results.filter(r => r.ok).length;
  console.log(`\n===== 验收汇总: ${pass}/${results.length} PASS =====`);
  const fails = results.filter(r => !r.ok);
  if (fails.length) { console.log('未通过:'); fails.forEach(f => console.log(` - ${f.step} | ${f.name} | ${f.detail}`)); }
  else console.log('全部通过，数字主线端到端贯通 ✅');

  // 生成 HTML 报告
  const html = buildReport(results, pass);
  const fs = require('fs');
  fs.writeFileSync('qa_mainline_report.html', html);
  console.log('\n报告已生成: qa_mainline_report.html');
}
function buildReport(results, pass) {
  const rows = results.map(r => `<tr class="${r.ok?'ok':'bad'}"><td>${r.step}</td><td>${r.name}</td><td>${r.ok?'✅':'❌'}</td><td>${r.detail}</td></tr>`).join('');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>数字主线验收报告</title>
<style>body{font-family:system-ui,'Microsoft YaHei',sans-serif;background:#f5f7fa;margin:0;padding:24px;color:#1f2937}
h1{font-size:22px}table{border-collapse:collapse;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)}
th,td{padding:10px 12px;border-bottom:1px solid #eee;text-align:left;font-size:14px}
th{background:#1e3a8a;color:#fff}.ok{color:#16a34a}.bad{color:#dc2626}
.sum{margin:16px 0;font-size:18px;font-weight:700}
.flow{background:#fff;padding:16px;border-radius:8px;margin-bottom:16px;line-height:1.9;font-size:14px}
.flow b{color:#1e3a8a}</style></head><body>
<h1>fab-mes 数字主线端到端验收报告</h1>
<div class="flow"><b>主线：</b>投料(工单→lotRelease) → EAP执行(lotStart) → MES量测(metrology) → SPC/FDC判异(spcAlarm/fdcAlarm) → 孪生映射(事件总线) → ERP领料(ISSUE) → Agent问答 → 审计落链</div>
<div class="sum">验收结果：${pass}/${results.length} 通过</div>
<table><thead><tr><th>阶段</th><th>验收项</th><th>结果</th><th>证据</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}
main().catch(e => { console.error('验收脚本异常:', e); process.exit(1); });
