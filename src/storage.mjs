export async function createUpdaterStore({ host, scope, core }) {
  if (!scope || typeof scope !== 'string') throw Error('无法确定当前用户的数据空间。');
  const db = await new Promise((resolve, reject) => {
    const r = host.indexedDB.open('preset-smart-updater-v1-' + scope, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('bindings')) r.result.createObjectStore('bindings', { keyPath: 'name' });
      if (!r.result.objectStoreNames.contains('backups')) r.result.createObjectStore('backups', { keyPath: 'id' });
      if (!r.result.objectStoreNames.contains('locks')) r.result.createObjectStore('locks', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(Error('备份数据库无法打开，已停用写入。'));
    r.onblocked = () => reject(Error('备份数据库被其他窗口占用，请关闭其他更新器窗口。'));
  });
  async function tx(names, mode, action) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(names, mode); let value;
      t.oncomplete = () => resolve(value);
      t.onabort = () => reject(Error('备份或绑定保存失败（空间不足或数据库不可用），没有继续写入预设。'));
      t.onerror = () => {}; // onabort reports the failed transaction.
      try {
        const r = action(t);
        if (r && 'onsuccess' in r) r.onsuccess = () => { value = r.result; };
      } catch (e) { t.abort(); reject(e); }
    });
  }
  const getBinding = name => tx(['bindings'], 'readonly', t => t.objectStore('bindings').get(name));
  const putBinding = binding => tx(['bindings'], 'readwrite', t => t.objectStore('bindings').put(core.copy(binding)));
  const backups = async name => (await tx(['backups'], 'readonly', t => t.objectStore('backups').getAll()))
    .filter(x => !name || x.name === name).sort((a, b) => b.at.localeCompare(a.at));
  const putBackup = record => tx(['backups'], 'readwrite', t => t.objectStore('backups').put(core.copy(record)));
  const finish = (record, binding) => tx(['backups', 'bindings'], 'readwrite', t => {
    t.objectStore('backups').put(core.copy(record));
    if (binding) t.objectStore('bindings').put(core.copy(binding));
    else t.objectStore('bindings').delete(record.name);
  });
  async function withLock(action) {
    const token = core.uuid(host.crypto);
    const lease = async acquire => new Promise((resolve, reject) => {
      const t = db.transaction(['locks'], 'readwrite'), s = t.objectStore('locks');
      let failure;
      const q = s.get('writer');
      q.onsuccess = () => {
        const old = q.result;
        if (acquire && old && old.until > Date.now() && old.token !== token) {
          failure = Error('另一个更新器窗口正在保存，请稍后重试。'); t.abort(); return;
        }
        if (acquire || old?.token === token) s.put({ id: 'writer', token, until: Date.now() + 300000 });
      };
      t.oncomplete = resolve; t.onabort = () => reject(failure || Error('无法锁定备份数据库，已停止。'));
    });
    await lease(true);
    const timer = host.setInterval(() => { lease(false).catch(() => {}); }, 30000);
    try { return await action(); }
    finally {
      host.clearInterval(timer);
      await new Promise(resolve => {
        const t = db.transaction(['locks'], 'readwrite'), s = t.objectStore('locks'), q = s.get('writer');
        q.onsuccess = () => { if (q.result?.token === token) s.delete('writer'); };
        t.oncomplete = resolve; t.onabort = resolve;
      });
    }
  }
  return { getBinding, putBinding, backups, putBackup, finish, withLock, close: () => db.close() };
}
