import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Window } from 'happy-dom';
import { IDBFactory } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
import { createUpdaterCore } from '../src/core.mjs';
const c = createUpdaterCore();
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
const script = JSON.parse(fs.readFileSync(new URL('../dist/酒馆预设智能更新器-v' + version + '.json', import.meta.url)));
const nativeEntry = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url)));
const old = { temperature: 1, prompts: [{ identifier: 'a', name: '作者条目', content: '旧正文', role: 'system' }, { identifier: 'b', name: '作者规则', content: '规则', role: 'system' }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: true }] }], extensions: {} };
const local = c.copy(old); local.prompts.push({ identifier: 'x', name: '我的条目', content: '<img src=x onerror="parent.injected=true">', extra: { data: false } }); local.prompt_order[0].order.splice(1, 0, { identifier: 'x', enabled: false, unknown: 'retain' });
const remote = c.copy(old); remote.prompts[0].content = '新正文'; remote.prompts.push({ identifier: 'new', name: '作者新增', content: '新规则' }); remote.prompt_order[0].order.push({ identifier: 'new', enabled: false });
const folding = p => p.extensions.baibaiToolkit.presetPromptGroups;
function withFolding(p, members) {
  p.extensions.baibaiToolkit = { other: { preserved: true }, presetPromptGroups: { version: 1,
    groups: [{ id: 'story', name: '故事基调', order: 0, collapsed: false, enabled: false }],
    prompts: Object.fromEntries(members.map(id => [id, { groupId: 'story' }])) } };
  return p;
}
async function until(fn, label = 'condition') {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 5)); }
  throw Error('Timed out: ' + label);
}
function findButton(root, text) { const b = [...root.querySelectorAll('button')].find(x => x.textContent === text); assert.ok(b, 'missing button ' + text); return b; }
function checkLabel(root, text) { const label = [...root.querySelectorAll('label')].find(x => x.textContent.includes(text)); assert.ok(label, text); const box = label.querySelector('input'); box.checked = true; box.dispatchEvent(new box.ownerDocument.defaultView.Event('change')); }
async function selectFile(root, value, name = 'preset.json') {
  const input = root.querySelector('input[type=file]'), win = input.ownerDocument.defaultView, transfer = new win.DataTransfer();
  transfer.items.add(new win.File([JSON.stringify(value)], name, { type: 'application/json' })); input.files = transfer.files; input.dispatchEvent(new win.Event('change'));
  await until(() => root.querySelector('.busy-mask').hidden, 'file import');
}
async function harness(strings = true, noDatabase = false, options = {}) {
  const host = new Window({ url: 'https://tavern.test/', settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  // Happy DOM otherwise permits attachShadow on <dialog>, unlike real browsers.
  const attach = host.Element.prototype.attachShadow;
  const allowed = new Set(['article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span']);
  let failWindow = !!options.failWindowOnce;
  host.Element.prototype.attachShadow = function(init) {
    if (!allowed.has(this.localName) && !this.localName.includes('-')) throw new host.DOMException('Unsupported shadow host: ' + this.localName, 'NotSupportedError');
    if (failWindow && this.dataset.presetUpdaterSurface) { failWindow = false; throw Error('simulated window creation failure'); }
    return attach.call(this, init);
  };
  Object.defineProperty(host, 'crypto', { value: webcrypto });
  Object.defineProperty(host, 'indexedDB', { value: options.databaseNever ? { open() { return {}; } } : noDatabase ? { open() { throw Error('no database'); } } : new IDBFactory() });
  const initialLocal = options.initialLocal || local;
  const state = { disk: c.copy(initialLocal), saved: c.copy(initialLocal), live: c.copy(initialLocal), vars: {}, events: {}, writes: [], moduleImports: 0, diskReads: 0, errors: [] };
  const manager = { getSelectedPresetName: () => '我的预设', getSelectedPreset: () => '0', getPresetList: () => ({ presets: [state.saved], preset_names: { 我的预设: 0 }, settings: state.live }),
    async savePreset(name, raw, options) { assert.equal(name, '我的预设'); assert.equal(options.skipUpdate, true); state.writes.push(c.copy(raw)); state.disk = c.copy(raw); },
    updateList(name, raw) { state.saved = c.copy(raw); state.live = c.copy(raw); } };
  const ctx = { mainApi: 'openai', getPresetManager: () => manager, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    extensionSettings: options.extensionSettings || { variables: { global: state.vars } },
    async saveSettingsDebounced() { state.settingSaves = (state.settingSaves || 0) + 1; } };
  state.ctx = ctx;
  host.SillyTavern = { getContext: () => ctx };
  host.fetch = async function() { assert.ok(this?.document === host.document, 'fetch must use the main-window receiver'); state.diskReads++; return { ok: true, json: async () => ({ openai_setting_names: ['我的预设'], openai_settings: [strings ? JSON.stringify(state.disk) : c.copy(state.disk)] }) }; };
  const api = { getChatCompletionPreset: () => c.copy(state.live), getPresetApplicationPromise: async () => {} };
  const OriginalFunction = host.Function;
  let releaseModule;
  const moduleGate = new Promise(resolve => { releaseModule = () => resolve(api); });
  host.Function = function(...args) {
    if (String(args[0]).startsWith('return import(')) {
      assert.ok(args[0].includes('https://tavern.test/scripts/openai.js')); state.moduleImports++;
      return () => options.deferModule || options.moduleNever ? moduleGate : Promise.resolve(api);
    }
    return OriginalFunction(...args);
  };
  host.toastr = { error: text => state.errors.push(text) };
  if (options.fastDeadlines) {
    const originalTimeout = host.setTimeout.bind(host);
    host.setTimeout = (fn, ms, ...args) => originalTimeout(fn, [8000, 12000].includes(ms) ? 20 : ms, ...args);
  }
  if (options.staleSingleton) host.__presetSmartUpdaterV1 = { close() { state.closedStale = true; } };
  const frame = host.document.createElement('iframe'); frame.srcdoc = ''; host.document.body.append(frame); await until(() => frame.contentWindow, 'iframe'); const child = frame.contentWindow;
  child.getVariables = () => c.copy(state.vars); child.insertOrAssignVariables = v => Object.assign(state.vars, v); child.getButtonEvent = x => x; child.eventOn = (key, cb) => { state.events[key] = cb; };
  if (options.native) {
    const mountPanel = () => { const target = host.document.createElement('div'); target.id = 'extensions_settings'; host.document.body.append(target); };
    if (options.delayPanel) host.setTimeout(mountPanel, 10); else mountPanel();
    host.eval(nativeEntry); await until(() => host.document.querySelector('#preset-smart-updater-native-controls button'), 'native extension button');
    if (!options.deferOpen) {
      host.document.querySelector('#preset-smart-updater-native-controls button').click();
      await until(() => host.document.querySelector('[data-preset-updater-surface]')?.shadowRoot?.querySelector('.busy-mask')?.hidden, 'native initialization');
    }
  } else {
    child.eval(script.content);
    await until(() => state.events['预设更新器'], 'script button registration');
    if (!options.deferOpen) await state.events['预设更新器']();
  }
  return { host, child, state, releaseModule, get root() { return host.document.querySelector('[data-preset-updater-surface]')?.shadowRoot; },
    async dispose() { child.dispatchEvent(new child.Event('unload')); host.__presetSmartUpdaterV1?.dispose?.(); await host.happyDOM.close(); } };
}
for (const strings of [true, false]) for (const nativeMode of [false, true]) test('full DOM workflow with IndexedDB transactions: ' + (nativeMode ? 'URL extension / ' : 'JSON script / ') + (strings ? 'native ST/TT string-array response' : 'object-array compatibility response'), async () => {
  const h = await harness(strings, false, { native: nativeMode }); const { root, state } = h;
  try {
    assert.equal(state.moduleImports, 1); assert.equal(state.writes.length, 0);
    findButton(root, '去首次绑定').click(); await until(() => root.textContent.includes('选择作者旧版 JSON'));
    await selectFile(root, old, '作者旧版.json');
    checkLabel(root, '我确认这份作者旧版'); findButton(root, '保存首次绑定').click();
    await until(() => root.querySelector('.note').textContent.includes('绑定好了'), root.querySelector('.note').textContent);
    assert.equal(state.writes.length, 0);
    await selectFile(root, remote, '作者新版.json'); findButton(root, '生成三方合并预览').click();
    await until(() => root.querySelector('.plan'), 'merge preview');
    assert.ok(root.textContent.includes('我的条目 1'));
    const customDetails = [...root.querySelectorAll('details')].find(x => x.querySelector('summary')?.textContent === '我的条目 · 1 项');
    customDetails.open = true; customDetails.dispatchEvent(new h.host.Event('toggle'));
    const bodyDetails = customDetails.querySelector('details'); bodyDetails.open = true; bodyDetails.dispatchEvent(new h.host.Event('toggle'));
    assert.equal(root.querySelectorAll('img').length, 0, 'uploaded content is rendered only as text');
    checkLabel(root, '我已核对作者的新增'); findButton(root, '备份并原位更新').click();
    await until(() => root.querySelector('.confirm-card'), 'update confirmation'); findButton(root, '确认备份并更新').click();
    await until(() => root.querySelector('.note').textContent.includes('已原位更新'), root.querySelector('.note').textContent);
    assert.equal(state.writes.length, 1); assert.equal(state.disk.prompts[0].content, '新正文'); assert.deepEqual(state.disk.prompts.find(x => x.identifier === 'x'), local.prompts[2]);
    assert.deepEqual(state.disk.prompt_order[0].order.find(x => x.identifier === 'x'), local.prompt_order[0].order[1]);
    findButton(root, '备份恢复').click(); await until(() => root.querySelector('.backup'), 'backups');
    let card = [...root.querySelectorAll('.backup')].find(x => x.textContent.includes(' · 更新 · ')); findButton(card, '恢复这一版').click();
    await until(() => root.querySelector('.confirm-card')); findButton(root, '备份现状并恢复').click();
    await until(() => state.writes.length === 2 && root.querySelector('.busy-mask').hidden, 'restore'); assert.deepEqual(state.disk, local);
    card = [...root.querySelectorAll('.backup')].find(x => x.textContent.includes(' · 恢复备份 · ')); findButton(card, '恢复这一版').click();
    await until(() => root.querySelector('.confirm-card')); findButton(root, '备份现状并恢复').click();
    await until(() => state.writes.length === 3 && root.querySelector('.busy-mask').hidden, 'undo restore'); assert.equal(state.disk.prompts[0].content, '新正文');
    assert.ok(state.diskReads > 0); assert.deepEqual(state.errors, []);
    assert.ok(h.host.document.querySelector('dialog > [data-preset-updater-surface]').shadowRoot === root);
  } finally { await h.dispose(); }
});
test('installable manifest resolves to the generated native entry and declares no helper dependency', () => {
  assert.equal(manifest.version, version); assert.equal(manifest.js, 'index.js'); assert.deepEqual(manifest.requires, []); assert.equal(manifest.auto_update, false);
  assert.ok(!nativeEntry.includes("import { startUpdater }")); assert.ok(nativeEntry.includes('startNativeUpdater().catch'));
});
test('native extension registers one button and does no module, database or settings work until opened', async () => {
  const h = await harness(true, false, { native: true, deferOpen: true, extensionSettings: {} });
  try {
    assert.equal(typeof h.host.getVariables, 'undefined'); assert.equal(typeof h.host.eventOn, 'undefined');
    assert.equal(h.state.moduleImports, 0); assert.equal(h.state.settingSaves || 0, 0); assert.equal(h.root, undefined);
    h.host.eval(nativeEntry); await until(() => h.host.document.querySelector('#preset-smart-updater-native-controls button'));
    assert.equal(h.host.document.querySelectorAll('#preset-smart-updater-native-controls').length, 1);
    h.host.document.querySelector('#preset-smart-updater-native-controls button').click();
    await until(() => h.root?.querySelector('.busy-mask')?.hidden); assert.equal(h.state.moduleImports, 1); assert.equal(h.state.settingSaves, 1);
    assert.ok(h.state.ctx.extensionSettings.preset_smart_updater.scope); assert.deepEqual(h.state.errors, []);
  } finally { await h.dispose(); }
});
test('native extension reuses a script binding and its backups after the helper script is disabled', async () => {
  const h = await harness();
  try {
    let root = h.root;
    findButton(root, '去首次绑定').click(); await until(() => root.textContent.includes('选择作者旧版 JSON'));
    await selectFile(root, old); checkLabel(root, '我确认这份作者旧版'); findButton(root, '保存首次绑定').click(); await until(() => root.textContent.includes('绑定好了'));
    const oldScope = h.state.vars.__preset_smart_updater_scope_v1;
    h.child.dispatchEvent(new h.child.Event('unload')); assert.equal(h.host.__presetSmartUpdaterV1, undefined);
    const target = h.host.document.createElement('div'); target.id = 'extensions_settings'; h.host.document.body.append(target);
    h.host.eval(nativeEntry); await until(() => h.host.document.querySelector('#preset-smart-updater-native-controls button'));
    h.host.document.querySelector('#preset-smart-updater-native-controls button').click(); await until(() => h.root?.querySelector('.busy-mask')?.hidden);
    root = h.root; assert.equal(h.state.ctx.extensionSettings.preset_smart_updater.scope, oldScope);
    assert.ok(root.textContent.includes('选择作者新版 JSON')); assert.equal(h.state.writes.length, 0);
    findButton(root, '备份恢复').click(); await until(() => root.querySelector('.backup')); assert.ok(root.textContent.includes('首次绑定'));
  } finally { await h.dispose(); }
});
test('native mode takes ownership from the JSON mode and survives subsequent helper-script unloads', async () => {
  const h = await harness(true, false, { deferOpen: true });
  try {
    assert.equal(h.host.__presetSmartUpdaterV1.mode, 'script');
    const target = h.host.document.createElement('div'); target.id = 'extensions_settings'; h.host.document.body.append(target);
    h.host.eval(nativeEntry); await until(() => h.host.__presetSmartUpdaterV1.mode === 'extension');
    const instance = h.host.__presetSmartUpdaterV1;
    h.child.eval(script.content); assert.equal(h.host.__presetSmartUpdaterV1, instance);
    h.child.dispatchEvent(new h.child.Event('unload')); assert.equal(h.host.__presetSmartUpdaterV1, instance);
    h.host.document.querySelector('#preset-smart-updater-native-controls button').click(); await until(() => h.root?.querySelector('.busy-mask')?.hidden);
    assert.deepEqual(h.state.errors, []);
  } finally { await h.dispose(); }
});
test('native storage failures leave the extension usable and prohibit in-place updates', async () => {
  const h = await harness(true, true, { native: true, extensionSettings: {} });
  try { assert.ok(h.root.textContent.includes('备份数据库不可用')); assert.equal(h.state.writes.length, 0); assert.ok(h.root.textContent.includes('离线')); }
  finally { await h.dispose(); }
});
test('native entry waits for a late-loading extension panel and still mounts just one launcher', async () => {
  const h = await harness(true, false, { native: true, deferOpen: true, delayPanel: true, extensionSettings: {} });
  try { assert.equal(h.host.document.querySelectorAll('#preset-smart-updater-native-controls').length, 1); assert.equal(h.state.moduleImports, 0); }
  finally { await h.dispose(); }
});
test('changing user namespace after preview prevents a native write into another account', async () => {
  const h = await harness(true, false, { native: true, extensionSettings: {} });
  try {
    const root = h.root;
    findButton(root, '去首次绑定').click(); await until(() => root.textContent.includes('选择作者旧版 JSON'));
    await selectFile(root, old); checkLabel(root, '我确认这份作者旧版'); findButton(root, '保存首次绑定').click(); await until(() => root.textContent.includes('绑定好了'));
    await selectFile(root, remote); findButton(root, '生成三方合并预览').click(); await until(() => root.querySelector('.plan'));
    h.state.ctx.extensionSettings = { preset_smart_updater: { scope: 'different-user-123456789' } };
    checkLabel(root, '我已核对作者的新增'); findButton(root, '备份并原位更新').click(); await until(() => root.querySelector('.confirm-card')); findButton(root, '确认备份并更新').click();
    await until(() => root.querySelector('.note').textContent.includes('数据空间发生变化')); assert.equal(h.state.writes.length, 0);
  } finally { await h.dispose(); }
});
test('UI requires a field conflict decision and uses the chosen author text', async () => {
  const h = await harness(); const { root, state } = h;
  try {
    state.live.prompts[0].content = '我改过的正文'; state.saved = c.copy(state.live); state.disk = c.copy(state.live);
    findButton(root, '重新读取当前预设').click(); await until(() => root.querySelector('.busy-mask').hidden);
    findButton(root, '去首次绑定').click(); await until(() => root.textContent.includes('选择作者旧版 JSON'));
    await selectFile(root, old); checkLabel(root, '我确认这份作者旧版'); findButton(root, '保存首次绑定').click(); await until(() => root.textContent.includes('绑定好了'));
    await selectFile(root, remote); findButton(root, '生成三方合并预览').click(); await until(() => root.querySelector('.plan'));
    assert.ok(root.querySelector('.decision-status').textContent.includes('还有 1 项'));
    const select = root.querySelector('.decision select'); select.value = 'remote'; select.dispatchEvent(new h.host.Event('change'));
    assert.ok(root.querySelector('.decision-status').textContent.includes('必选冲突已处理'));
    checkLabel(root, '我已核对作者的新增'); findButton(root, '备份并原位更新').click(); await until(() => root.querySelector('.confirm-card')); findButton(root, '确认备份并更新').click();
    await until(() => root.querySelector('.note').textContent.includes('已原位更新'));
    assert.equal(state.disk.prompts[0].content, '新正文');
  } finally { await h.dispose(); }
});
test('folding-group preview and in-place update preserve group membership through backup and restore', async () => {
  const b = withFolding(c.copy(old), ['a', 'b']), l = withFolding(c.copy(local), ['a', 'x', 'b']), r = withFolding(c.copy(remote), ['a', 'b', 'new']);
  folding(l).prompts.x.extra = { mine: true };
  const h = await harness(true, false, { initialLocal: l });
  try {
    const root = h.root;
    findButton(root, '去首次绑定').click(); await until(() => root.textContent.includes('选择作者旧版 JSON'));
    await selectFile(root, b); checkLabel(root, '我确认这份作者旧版'); findButton(root, '保存首次绑定').click(); await until(() => root.textContent.includes('绑定好了'));
    await selectFile(root, r); findButton(root, '生成三方合并预览').click(); await until(() => root.querySelector('.plan'));
    const preview = [...root.querySelectorAll('details')].find(x => x.querySelector('summary')?.textContent === '查看合并后的折叠分组（大条码）');
    assert.ok(preview); preview.open = true; preview.dispatchEvent(new h.host.Event('toggle'));
    assert.ok(preview.textContent.includes('故事基调 · 4 条 · 总开关关闭')); assert.ok(preview.textContent.includes('作者新增')); assert.ok(preview.textContent.includes('我的条目'));
    assert.equal(root.querySelectorAll('img').length, 0); assert.equal(h.state.writes.length, 0);
    checkLabel(root, '我已核对作者的新增'); findButton(root, '备份并原位更新').click(); await until(() => root.querySelector('.confirm-card')); findButton(root, '确认备份并更新').click();
    await until(() => root.querySelector('.note').textContent.includes('已原位更新'));
    assert.equal(folding(h.state.disk).prompts.new.groupId, 'story'); assert.deepEqual(folding(h.state.disk).prompts.x, folding(l).prompts.x); assert.equal(folding(h.state.disk).groups[0].enabled, false);
    findButton(root, '备份恢复').click(); await until(() => root.querySelector('.backup'));
    const card = [...root.querySelectorAll('.backup')].find(x => x.textContent.includes(' · 更新 · ')); findButton(card, '恢复这一版').click();
    await until(() => root.querySelector('.confirm-card')); findButton(root, '备份现状并恢复').click();
    await until(() => h.state.writes.length === 2 && root.querySelector('.busy-mask').hidden); assert.deepEqual(h.state.disk, l);
  } finally { await h.dispose(); }
});
test('restoring a prompt reveals a required group-placement choice that the UI renders and saves', async () => {
  const b = withFolding(c.copy(old), ['a', 'b']), l = withFolding(c.copy(old), ['b']);
  l.prompts = l.prompts.filter(x => x.identifier !== 'a'); l.prompt_order[0].order = l.prompt_order[0].order.filter(x => x.identifier !== 'a');
  const r = c.copy(old); r.prompts[0].content = '作者修改过的正文';
  const h = await harness(true, false, { initialLocal: l });
  try {
    const root = h.root;
    findButton(root, '去首次绑定').click(); await until(() => root.textContent.includes('选择作者旧版 JSON'));
    await selectFile(root, b); checkLabel(root, '我确认这份作者旧版'); findButton(root, '保存首次绑定').click(); await until(() => root.textContent.includes('绑定好了'));
    await selectFile(root, r); findButton(root, '生成三方合并预览').click(); await until(() => root.querySelector('.plan'));
    let restore = root.querySelector('.decision select'); assert.ok(restore.getAttribute('aria-label').includes('你已删除'));
    restore.value = 'remote'; restore.dispatchEvent(new h.host.Event('change'));
    const placement = [...root.querySelectorAll('.decision select')].find(x => x.getAttribute('aria-label').includes('未提供分组')); assert.ok(placement);
    assert.ok(root.querySelector('.decision-status').textContent.includes('还有 1 项'));
    checkLabel(root, '我已核对作者的新增'); findButton(root, '备份并原位更新').click();
    await until(() => root.querySelector('.busy-mask').hidden); assert.equal(h.state.writes.length, 0); assert.ok(!root.querySelector('.confirm-card'));
    placement.value = 'group:story'; placement.dispatchEvent(new h.host.Event('change'));
    assert.ok(root.querySelector('.decision-status').textContent.includes('必选冲突已处理'));
    assert.equal([...root.querySelectorAll('label')].find(x => x.textContent.includes('我已核对作者的新增')).querySelector('input').checked, false);
    checkLabel(root, '我已核对作者的新增'); findButton(root, '备份并原位更新').click(); await until(() => root.querySelector('.confirm-card')); findButton(root, '确认备份并更新').click();
    await until(() => root.querySelector('.note').textContent.includes('已原位更新')); assert.equal(folding(h.state.disk).prompts.a.groupId, 'story');
  } finally { await h.dispose(); }
});
test('an edit made after preview is rejected without any overwrite', async () => {
  const h = await harness(); const { root, state } = h;
  try {
    findButton(root, '去首次绑定').click(); await until(() => root.textContent.includes('选择作者旧版 JSON'));
    await selectFile(root, old); checkLabel(root, '我确认这份作者旧版'); findButton(root, '保存首次绑定').click(); await until(() => root.textContent.includes('绑定好了'));
    await selectFile(root, remote); findButton(root, '生成三方合并预览').click(); await until(() => root.querySelector('.plan'));
    state.live.prompt_order[0].order[0].enabled = false;
    checkLabel(root, '我已核对作者的新增'); findButton(root, '备份并原位更新').click(); await until(() => root.querySelector('.confirm-card')); findButton(root, '确认备份并更新').click();
    await until(() => root.querySelector('.note').textContent.includes('重新生成预览'));
    assert.equal(state.writes.length, 0); assert.deepEqual(state.disk, local);
  } finally { await h.dispose(); }
});
test('failed database disables in-place apply and still exposes offline import', async () => {
  const h = await harness(true, true); try {
    assert.ok(h.root.textContent.includes('原位写入已停用'));
    findButton(h.root, '去首次绑定').click(); await until(() => h.root.textContent.includes('选择作者旧版 JSON'));
    await selectFile(h.root, old); checkLabel(h.root, '我确认这份作者旧版'); findButton(h.root, '保存首次绑定').click();
    await until(() => h.root.textContent.includes('临时绑定'));
    await selectFile(h.root, remote); findButton(h.root, '生成三方合并预览').click(); await until(() => h.root.querySelector('.plan'));
    assert.ok(findButton(h.root, '备份并原位更新').disabled); assert.equal(h.state.writes.length, 0);
  } finally { await h.dispose(); }
});
test('a strict browser rejects <dialog> as a shadow host while the updater opens with a valid child host', async () => {
  const h = await harness();
  try {
    assert.throws(() => h.host.document.createElement('dialog').attachShadow({ mode: 'open' }), { name: 'NotSupportedError' });
    assert.ok(h.host.document.querySelector('dialog').isConnected);
    assert.equal(h.root.host.localName, 'div');
    assert.deepEqual(h.state.errors, []);
  } finally { await h.dispose(); }
});
test('the button registers before imports and shows a window immediately while initialization is pending', async () => {
  const h = await harness(true, false, { deferOpen: true, deferModule: true });
  try {
    assert.equal(h.state.moduleImports, 0);
    assert.deepEqual(h.state.vars, {});
    const pending = h.state.events['预设更新器']();
    assert.ok(h.host.document.querySelector('dialog').isConnected);
    assert.ok(h.root.querySelector('.note').textContent.includes('正在读取'));
    assert.equal(h.state.writes.length, 0);
    h.releaseModule(); await pending;
    assert.ok(h.root.querySelector('.status').textContent.includes('我的预设'));
  } finally { await h.dispose(); }
});
test('a pre-display window error shows a toast and the next click can retry', async () => {
  const h = await harness(true, false, { deferOpen: true, failWindowOnce: true });
  try {
    await h.state.events['预设更新器']();
    assert.equal(h.state.errors.length, 1);
    assert.match(h.state.errors[0], /simulated window creation failure/);
    assert.equal(h.host.document.querySelector('dialog'), null);
    await h.state.events['预设更新器']();
    assert.ok(h.root.querySelector('.status').textContent.includes('我的预设'));
  } finally { await h.dispose(); }
});
test('module initialization timeouts leave a visible diagnostic and offline file picker', async () => {
  const h = await harness(true, false, { moduleNever: true, fastDeadlines: true });
  try {
    assert.ok(h.root.querySelector('.note').textContent.includes('超时'));
    assert.ok(h.root.querySelector('.note').classList.contains('error'));
    assert.ok(h.root.querySelector('input[type=file]'));
    assert.equal(h.state.writes.length, 0);
  } finally { await h.dispose(); }
});
test('database initialization timeouts keep the window usable and disable writes', async () => {
  const h = await harness(true, false, { databaseNever: true, fastDeadlines: true });
  try {
    assert.ok(h.root.textContent.includes('备份数据库打开超时'));
    assert.ok(h.root.textContent.includes('原位写入已停用'));
    assert.equal(h.state.writes.length, 0);
  } finally { await h.dispose(); }
});
test('a stale v1.0.0 singleton cannot hijack the repaired button', async () => {
  const h = await harness(true, false, { staleSingleton: true });
  try {
    assert.equal(h.state.closedStale, true);
    assert.equal(h.host.__presetSmartUpdaterV1.version, version);
    assert.ok(h.root.querySelector('.status').textContent.includes('我的预设'));
  } finally { await h.dispose(); }
});

function typeSearch(h, input, text) {
  assert.ok(input, 'search box exists'); input.value = text; input.dispatchEvent(new h.host.Event('input'));
}
async function bindForSearch(h, base = old) {
  findButton(h.root, '去首次绑定').click(); await until(() => h.root.textContent.includes('选择作者旧版 JSON'));
  await selectFile(h.root, base); checkLabel(h.root, '我确认这份作者旧版'); findButton(h.root, '保存首次绑定').click();
  await until(() => h.root.querySelector('.note').textContent.includes('绑定好了'));
}
function sourceRow(h, mapping, name) {
  typeSearch(h, mapping.querySelector('.map-source-search input'), name);
  const row = mapping.querySelector('.map-primary-rows .map-row'); assert.ok(row); return row;
}
test('source name search finds matched rows without expanding all entries, and clearing restores the initial view', async () => {
  const base = c.copy(old), modified = c.copy(local);
  base.prompts[0].name = modified.prompts[0].name = '三水草稿cot'; base.prompts[1].name = modified.prompts[1].name = '三水续写';
  const h = await harness(true, false, { initialLocal: modified });
  try {
    findButton(h.root, '去首次绑定').click(); await until(() => h.root.textContent.includes('选择作者旧版 JSON')); await selectFile(h.root, base);
    const mapping = h.root.querySelector('.mapping'), field = mapping.querySelector('.map-source-search input');
    assert.equal(mapping.querySelectorAll('.map-primary-rows .map-row').length, 0);
    typeSearch(h, field, '三水');
    assert.deepEqual([...mapping.querySelectorAll('.map-primary-rows .map-source span')].map(x => x.textContent), ['三水草稿cot', '三水续写']);
    assert.ok(mapping.querySelector('.map-source-count').textContent.includes('2 条'));
    assert.ok(mapping.querySelector('details').hidden);
    typeSearch(h, field, '没有这个名字'); assert.equal(mapping.querySelectorAll('.map-primary-rows .map-row').length, 0);
    typeSearch(h, field, ''); assert.equal(mapping.querySelectorAll('.map-primary-rows .map-row').length, 0); assert.equal(mapping.querySelector('details').hidden, false);
    assert.equal(h.state.writes.length, 0); assert.deepEqual(h.state.disk, modified);
  } finally { await h.dispose(); }
});
test('candidate name search shows all 三水 matches while preserving an existing out-of-filter selection', async () => {
  const modified = c.copy(local);
  modified.prompts.push({ identifier: 's1', name: '三水草稿cot', content: 'a' }, { identifier: 's2', name: '三水续写', content: 'b' }, { identifier: 'other', name: '其他', content: 'c' });
  const h = await harness(true, false, { initialLocal: modified });
  try {
    findButton(h.root, '去首次绑定').click(); await until(() => h.root.textContent.includes('选择作者旧版 JSON')); await selectFile(h.root, old);
    const mapping = h.root.querySelector('.mapping'), row = sourceRow(h, mapping, '作者条目'), select = row.querySelector('select'), field = row.querySelector('.map-candidate-search');
    assert.equal(select.value, '"a"');
    typeSearch(h, field, '三水');
    const ids = [...select.options].map(x => x.value);
    assert.deepEqual(ids, ['?', 'null', '"a"', '"s1"', '"s2"']);
    assert.equal(select.value, '"a"'); assert.ok(row.querySelector('.map-candidate-count').textContent.includes('2 个'));
    assert.ok([...select.options].find(x => x.value === '"a"').textContent.startsWith('当前已选：'));
    typeSearch(h, field, ''); assert.equal(select.value, '"a"'); assert.ok([...select.options].some(x => x.value === '"other"'));
    assert.equal(h.state.writes.length, 0);
  } finally { await h.dispose(); }
});
test('empty candidate results keep the previous mapping and the explicit deletion option', async () => {
  const h = await harness();
  try {
    findButton(h.root, '去首次绑定').click(); await until(() => h.root.textContent.includes('选择作者旧版 JSON')); await selectFile(h.root, old);
    const row = sourceRow(h, h.root.querySelector('.mapping'), '作者条目'), select = row.querySelector('select');
    typeSearch(h, row.querySelector('.map-candidate-search'), '找不到的内容');
    assert.equal(select.value, '"a"'); assert.ok(row.querySelector('.map-candidate-count').textContent.includes('没有匹配'));
    assert.ok([...select.options].some(x => x.value === 'null'));
    assert.equal(h.state.writes.length, 0);
  } finally { await h.dispose(); }
});
test('candidate filtering treats case, full-width text and regex punctuation as plain name keywords', async () => {
  const modified = c.copy(local); modified.prompts.push({ identifier: 's1', name: '三水草稿CoT[简版]', content: 'a' });
  const h = await harness(true, false, { initialLocal: modified });
  try {
    findButton(h.root, '去首次绑定').click(); await until(() => h.root.textContent.includes('选择作者旧版 JSON')); await selectFile(h.root, old);
    const row = sourceRow(h, h.root.querySelector('.mapping'), '作者条目'), field = row.querySelector('.map-candidate-search');
    for (const query of [' cot ', 'ＣＯＴ', '[简版]']) {
      typeSearch(h, field, query); assert.ok([...row.querySelector('select').options].some(x => x.value === '"s1"'));
      assert.ok(row.querySelector('.map-candidate-count').textContent.includes('1 个'));
    }
    assert.deepEqual(h.state.errors, []);
  } finally { await h.dispose(); }
});
test('a manually selected mapping survives hiding and restoring its source row', async () => {
  const modified = c.copy(local); modified.prompts.push({ identifier: 's1', name: '三水草稿cot', content: 'a' });
  const h = await harness(true, false, { initialLocal: modified });
  try {
    findButton(h.root, '去首次绑定').click(); await until(() => h.root.textContent.includes('选择作者旧版 JSON')); await selectFile(h.root, old);
    const mapping = h.root.querySelector('.mapping'), row = sourceRow(h, mapping, '作者条目');
    typeSearch(h, row.querySelector('.map-candidate-search'), '三水');
    const select = row.querySelector('select'); select.value = '"s1"'; select.dispatchEvent(new h.host.Event('change'));
    sourceRow(h, mapping, '作者规则');
    const restored = sourceRow(h, mapping, '作者条目');
    assert.equal(restored.querySelector('select').value, '"s1"'); assert.equal(restored.querySelector('.map-candidate-search').value, '三水');
    assert.ok(mapping.querySelector('p').textContent.includes('已对应 2 条'));
  } finally { await h.dispose(); }
});
test('author-new candidate search can resolve a renamed-ID match and produce the intended merged content', async () => {
  const h = await harness();
  try {
    await bindForSearch(h);
    const next = c.copy(remote); next.prompts[0].identifier = 'a-new'; next.prompts[0].name = '三水草稿cot'; next.prompt_order[0].order[0].identifier = 'a-new';
    await selectFile(h.root, next, '新版.json');
    const mapping = h.root.querySelector('[data-mapping-target="作者新版"]'), row = sourceRow(h, mapping, '作者条目');
    typeSearch(h, row.querySelector('.map-candidate-search'), '三水');
    const select = row.querySelector('select'); select.value = '"a-new"'; select.dispatchEvent(new h.host.Event('change'));
    findButton(h.root, '生成三方合并预览').click(); await until(() => h.root.querySelector('.plan'));
    checkLabel(h.root, '我已核对作者的新增'); findButton(h.root, '备份并原位更新').click(); await until(() => h.root.querySelector('.confirm-card')); findButton(h.root, '确认备份并更新').click();
    await until(() => h.root.querySelector('.note').textContent.includes('已原位更新'));
    assert.equal(h.state.disk.prompts.find(p => p.identifier === 'a').name, '三水草稿cot');
    assert.equal(h.state.disk.prompts.find(p => p.identifier === 'a').content, '新正文');
    assert.deepEqual(h.state.disk.prompts.find(p => p.identifier === 'x'), local.prompts.find(p => p.identifier === 'x'));
  } finally { await h.dispose(); }
});
