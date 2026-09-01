// 验证 enforceRetention：落库表超过上限即裁剪最旧行，防无限膨胀。
process.env.FAB_DB_PATH = 'E:/Fab/fab-mes/test_ret.db';
const fs = require('fs');
try { fs.rmSync('E:/Fab/fab-mes/test_ret.db', { force: true }); } catch (_) {}
const storage = require('./storage');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

// 1) events 表：插入 500 条，上限 200 → 裁剪到 200
for (let i = 0; i < 500; i++) storage.enqueueEvent('2026-01-01T00:00:00Z', 'evt' + i, '{}');
storage.flushEvents();
const beforeEvents = storage.db.prepare('SELECT COUNT(*) c FROM events').get().c;
storage.enforceRetention(200, 500000, 200000);
const afterEvents = storage.db.prepare('SELECT COUNT(*) c FROM events').get().c;
ok('events 插入 500 条', beforeEvents === 500);
ok('events 裁剪到 ≤200 (' + afterEvents + ')', afterEvents <= 200 && afterEvents > 0);

// 2) tsdb 表：插入 300 条，上限 100 → 裁剪到 100
for (let i = 0; i < 300; i++) storage.db.prepare('INSERT INTO tsdb(ts,t,domain,metric,tool,lot,product,value,unit,aux) VALUES(?,?,?,?,?,?,?,?,?,?)').run('2026-01-01T00:00:00Z', i, 'd', 'm', 'T1', 'L1', 'P1', i, 'x', '{}');
const beforeTsdb = storage.db.prepare('SELECT COUNT(*) c FROM tsdb').get().c;
storage.enforceRetention(200, 100, 200000);
const afterTsdb = storage.db.prepare('SELECT COUNT(*) c FROM tsdb').get().c;
ok('tsdb 插入 300 条', beforeTsdb === 300);
ok('tsdb 裁剪到 ≤100 (' + afterTsdb + ')', afterTsdb <= 100 && afterTsdb > 0);

// 3) 未超限不裁剪：插入 50 条 events，上限 200 → 仍是 50
for (let i = 0; i < 50; i++) storage.enqueueEvent('2026-01-01T00:00:00Z', 'e2' + i, '{}');
storage.flushEvents();
const b2 = storage.db.prepare('SELECT COUNT(*) c FROM events').get().c;
storage.enforceRetention(200, 500000, 200000);
const a2 = storage.db.prepare('SELECT COUNT(*) c FROM events').get().c;
ok('未超限不裁剪 (' + b2 + '→' + a2 + ')', b2 === 50 && a2 === 50);

try { fs.rmSync('E:/Fab/fab-mes/test_ret.db', { force: true }); } catch (_) {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
