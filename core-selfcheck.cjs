// 纯净单元测试：core.js 内存护栏（不依赖 DB / 不启服务）
'use strict';
const { WIPEngine, ROUTE } = require('./core');
const tools = ['LITHO','ETCH','DEP','CMP','IMPL','METRO'].map((m,i)=>({id:m+'-'+i, module:m, wph:100}));
const byId = new Map(tools.map(t=>[t.id,t]));
const emit = ()=>{};
const engine = new WIPEngine(byId, tools, emit, { maxLots: 10, maxWos: 5 });

let pass=0, fail=0;
const assert=(n,c,e)=>{ if(c){pass++;console.log('  ✓ '+n);} else {fail++;console.log('  ✗ '+n+(e?' → '+e:''));} };

// 构造 20 个已完工 lot + 5 个在制 lot + 5 个 HOLD lot，全部塞进 lots（模拟超限历史堆积）
for (let i=0;i<20;i++){ const id='DONE-'+i; const lot={id,status:'DONE',route:[],step:1,rem:0,wafers:[]}; engine.lots.push(lot); engine.byLot.set(id,lot); }
for (let i=0;i<5;i++){ const id='WIP-'+i; const lot={id,status:'WIP',route:[],step:1,rem:1,wafers:[]}; engine.lots.push(lot); engine.byLot.set(id,lot); }
for (let i=0;i<5;i++){ const id='HOLD-'+i; const lot={id,status:'HOLD',route:[],step:1,rem:1,wafers:[]}; engine.lots.push(lot); engine.byLot.set(id,lot); }
// 构造 8 个 wo：其中 6 个全子批已 DONE，2 个仍有在制
for (let i=0;i<6;i++){ const id='WO-DONE-'+i; engine.wos.push({id, lots:['DONE-'+i]}); }
for (let i=0;i<2;i++){ const id='WO-WIP-'+i; engine.wos.push({id, lots:['WIP-'+i]}); }

console.log('== _pruneDone：超量历史堆积应被裁剪到上限，在制/HOLD 保留 ==');
engine._pruneDone();
assert('lots 裁剪到 maxLots=10', engine.lots.length === 10, 'len='+engine.lots.length);
assert('已完工 DONE 被回收(应剩 0 个 DONE)', engine.lots.filter(l=>l.status==='DONE').length === 0, JSON.stringify(engine.lots.map(l=>l.status)));
assert('在制 WIP 全部保留', engine.lots.filter(l=>l.status==='WIP').length === 5, 'wip='+engine.lots.filter(l=>l.status==='WIP').length);
assert('HOLD 全部保留', engine.lots.filter(l=>l.status==='HOLD').length === 5, 'hold='+engine.lots.filter(l=>l.status==='HOLD').length);
assert('wo 裁剪到 maxWos=5', engine.wos.length === 5, 'wos='+engine.wos.length);
assert('已完成 wo 被回收(应剩 2 个 WO-WIP)', engine.wos.filter(w=>w.id.startsWith('WO-WIP')).length === 2, JSON.stringify(engine.wos.map(w=>w.id)));

console.log('== createWO 正常加 lot 不报错 ==');
const wo = engine.createWO({ product:'N2', qty:2, dueHours:24 });
assert('createWO 返回 WO 且含 lot', !!wo && wo.lots.length === 2, JSON.stringify(wo && wo.lots));
assert('byLot 同步登记', engine.byLot.has(wo.lots[0]), '');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
