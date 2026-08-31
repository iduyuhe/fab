// ============================================================
//  storage 工厂（§5.3）：按 STORAGE_DRIVER 返回实现，默认 sqlite。
//  用法：const storage = require('./storage'); storage.xxx(...)
// ============================================================
const { SQLiteStorage } = require('./sqlite');

let instance = null;
function getStorage() {
  if (instance) return instance;
  const driver = process.env.STORAGE_DRIVER || 'sqlite';
  if (driver === 'sqlite') instance = new SQLiteStorage();
  else throw new Error(`未知 STORAGE_DRIVER: ${driver}（阶段0 仅支持 sqlite）`);
  return instance;
}

// 单例：所有进程内模块共享同一 db 连接
module.exports = getStorage();
module.exports.getStorage = getStorage;
