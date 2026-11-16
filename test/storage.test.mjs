import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createUpdaterCore } from '../src/core.mjs';
import { createUpdaterStore } from '../src/storage.mjs';
const core = createUpdaterCore();
const host = () => ({ indexedDB: new IDBFactory(), crypto, setInterval, clearInterval });
test('backups and author baseline persist across reopen and stay isolated by account scope', async () => {
  const h = host(), a = await createUpdaterStore({ host: h, core, scope: 'account-one' });
  await a.finish({ id: 'backup', name: 'preset', at: '2026-11-16', before: { content: 'mine' } }, { name: 'preset', label: 'v2' }); a.close();
  const b = await createUpdaterStore({ host: h, core, scope: 'account-one' }); assert.equal((await b.getBinding('preset')).label, 'v2'); assert.equal((await b.backups())[0].before.content, 'mine');
  const c = await createUpdaterStore({ host: h, core, scope: 'account-two' }); assert.equal(await c.getBinding('preset'), undefined); assert.deepEqual(await c.backups(), []); b.close(); c.close();
});
test('restoring an unbound snapshot atomically removes the active baseline', async () => {
  const s = await createUpdaterStore({ host: host(), core, scope: 'scope' });
  await s.putBinding({ name: 'preset', label: 'v1' }); await s.finish({ id: 'restored', name: 'preset', at: '2026-11-16', status: 'verified' }, null);
  assert.equal(await s.getBinding('preset'), undefined); assert.equal((await s.backups())[0].status, 'verified'); s.close();
});
test('a second updater writer cannot enter while the first holds its account lock', async () => {
  const h = host(), a = await createUpdaterStore({ host: h, core, scope: 'scope' }), b = await createUpdaterStore({ host: h, core, scope: 'scope' });
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  const first = a.withLock(async () => { entered(); await gate; }); await started;
  await assert.rejects(b.withLock(async () => { throw Error('should not enter'); }), /另一个/);
  release(); await first; let ran = false; await b.withLock(async () => { ran = true; }); assert.equal(ran, true); a.close(); b.close();
});
test('writer lock is released after an error', async () => {
  const a = await createUpdaterStore({ host: host(), core, scope: 'scope' });
  await assert.rejects(a.withLock(async () => { throw Error('operation failed'); }), /operation failed/);
  let ran = false; await a.withLock(async () => { ran = true; }); assert.ok(ran); a.close();
});
test('database startup errors fail closed', async () => {
  await assert.rejects(createUpdaterStore({ host: { indexedDB: { open() { throw Error('not available'); } } }, scope: 'scope', core }), /not available/);
});
