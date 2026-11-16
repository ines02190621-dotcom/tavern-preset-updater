import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdaterCore } from '../src/core.mjs';
import { resolveUpdaterScope } from '../src/scope.mjs';
const core = createUpdaterCore(), KEY = '__preset_smart_updater_scope_v1';
const legacyScope = 'legacy-user-scope-123456', nativeScope = 'native-user-scope-123456';
const native = (extensionSettings = {}) => ({ extensionSettings, saves: 0, async saveSettingsDebounced() { this.saves++; } });
test('native extension creates a per-user scope without any TavernHelper API', async () => {
  const context = native(), scope = await resolveUpdaterScope({ core, context, mode: 'extension' });
  assert.match(scope, /^[a-zA-Z0-9-]{10,80}$/); assert.equal(context.extensionSettings.preset_smart_updater.scope, scope); assert.equal(context.saves, 1);
  assert.equal(await resolveUpdaterScope({ core, context, mode: 'extension' }), scope); assert.equal(context.saves, 1);
});
test('native extension adopts the exact legacy global-variable namespace without rewriting unrelated settings', async () => {
  const context = native({ variables: { global: { [KEY]: legacyScope, unrelated: { keep: true } } }, preset_smart_updater: { other: false } });
  const scope = await resolveUpdaterScope({ core, context, mode: 'extension' }); assert.equal(scope, legacyScope);
  assert.equal(context.extensionSettings.preset_smart_updater.other, false); assert.deepEqual(context.extensionSettings.variables.global.unrelated, { keep: true }); assert.equal(context.saves, 1);
});
test('the JSON script adopts the existing extension scope and shares it with the legacy namespace', async () => {
  const context = native({ preset_smart_updater: { scope: nativeScope } }), vars = { other: false };
  const scope = await resolveUpdaterScope({ core, context, mode: 'script', readLegacy: () => vars, writeLegacy: value => Object.assign(vars, value) });
  assert.equal(scope, nativeScope); assert.equal(vars[KEY], nativeScope); assert.equal(vars.other, false);
});
test('different helper, direct settings and native scopes fail closed without changing settings', async () => {
  for (const mode of ['script', 'extension']) {
    const context = native({ preset_smart_updater: { scope: nativeScope }, variables: { global: { [KEY]: legacyScope } } });
    const before = core.copy(context.extensionSettings);
    await assert.rejects(resolveUpdaterScope({ core, context, mode, readLegacy: () => ({ [KEY]: legacyScope }), writeLegacy: () => assert.fail() }), /数据空间不一致/);
    assert.deepEqual(context.extensionSettings, before); assert.equal(context.saves, 0);
  }
});
test('invalid saved namespace is never silently replaced by a new empty database', async () => {
  const context = native({ preset_smart_updater: { scope: 'bad' } });
  await assert.rejects(resolveUpdaterScope({ core, context, mode: 'extension' }), /编号无效/); assert.equal(context.saves, 0);
});
test('missing host settings persistence stops native storage initialization', async () => {
  await assert.rejects(resolveUpdaterScope({ core, context: { extensionSettings: {} }, mode: 'extension' }), /设置保存接口/);
});
test('a failed settings save rolls memory back before any database can be opened', async () => {
  const context = native({ variables: { global: { keep: true } } }); context.saveSettingsDebounced = async () => { throw Error('disk full'); };
  const before = core.copy(context.extensionSettings);
  await assert.rejects(resolveUpdaterScope({ core, context, mode: 'extension' }), /未打开备份数据库/); assert.deepEqual(context.extensionSettings, before);
});
test('different user settings create isolated namespaces and returning to one user retains its scope', async () => {
  const first = native(), second = native();
  const a = await resolveUpdaterScope({ core, context: first, mode: 'extension' }), b = await resolveUpdaterScope({ core, context: second, mode: 'extension' });
  assert.notEqual(a, b); assert.equal(await resolveUpdaterScope({ core, context: first, mode: 'extension' }), a);
});
