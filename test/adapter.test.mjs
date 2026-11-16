import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdaterCore } from '../src/core.mjs';
import { createHostAdapter } from '../src/adapter.mjs';
const core = createUpdaterCore();
const fixture = () => ({ temperature: 1, unknown: { kept: true }, prompts: [{ identifier: 'a', name: 'a', content: 'old' }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: false }] }], extensions: {} });
function setup({ strings = true, failBackup = false, failSave = false, corruptDisk = false, failFinish = false } = {}) {
  let cached = fixture(), live = fixture(), disk = fixture(), current = '当前预设', bound = { name: current, label: 'old' };
  const events = [], records = [];
  const manager = {
    getSelectedPresetName: () => current, getSelectedPreset: () => '0',
    getPresetList: () => ({ presets: [cached], preset_names: { 当前预设: 0 }, settings: live }),
    async savePreset(name, raw, options) {
      events.push(['save', name, options]); if (failSave) throw Error('network error');
      disk = core.copy(raw); if (corruptDisk) disk.temperature = 99;
    },
    updateList(name, raw) { events.push(['refresh', name]); cached = core.copy(raw); live = core.copy(raw); },
  };
  const context = { mainApi: 'openai', getPresetManager: () => manager, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) };
  const host = { crypto, async fetch(path, options) { assert.equal(path, '/api/settings/get'); assert.equal(options.method, 'POST'); events.push(['read-disk']); return { ok: true, async json() { return { openai_setting_names: ['当前预设'], openai_settings: [strings ? JSON.stringify(disk) : core.copy(disk)] }; } }; } };
  const openai = { getChatCompletionPreset: () => core.copy(live), getPresetApplicationPromise: async () => {} };
  const adapter = createHostAdapter({ host, context, openai, core });
  const store = {
    async getBinding() { return core.copy(bound); },
    async putBackup(record) { events.push(['backup', record.status]); if (failBackup) throw Error('quota'); const i = records.findIndex(x => x.id === record.id); if (i >= 0) records[i] = core.copy(record); else records.push(core.copy(record)); },
    async finish(record, binding) { events.push(['finish']); if (failFinish) throw Error('db unavailable'); bound = core.copy(binding); records[records.findIndex(x => x.id === record.id)] = core.copy(record); },
  };
  return { adapter, events, records, store, manager, context, openai, mutateLive: f => f(live), mutateDisk: f => f(disk), switchPreset: n => { current = n; }, mutateBinding: b => { bound = b; }, getDisk: () => disk, getBound: () => bound };
}
for (const strings of [true, false]) test('verified save in ' + (strings ? 'native ST/TT string-array' : 'object-array compatibility') + ' response retains exact existing name and backup-before-write ordering', async () => {
  const s = setup({ strings }), expected = await s.adapter.read(), raw = core.copy(expected.raw); raw.prompts[0].content = 'new';
  await s.adapter.commit({ expected, raw, binding: { name: expected.name, label: 'new' }, beforeBinding: s.getBound(), store: s.store });
  assert.deepEqual(s.getDisk(), raw); assert.equal(s.getBound().label, 'new');
  assert.equal(s.events.filter(x => x[0] === 'save').length, 1); assert.equal(s.events.find(x => x[0] === 'save')[1], '当前预设');
  assert.deepEqual(s.events.find(x => x[0] === 'save')[2], { skipUpdate: true });
  assert.ok(s.events.findIndex(x => x[0] === 'backup') < s.events.findIndex(x => x[0] === 'save'));
  assert.ok(s.events.findIndex(x => x[0] === 'refresh') < s.events.findIndex(x => x[0] === 'finish'));
  assert.equal(s.records[0].status, 'verified'); assert.equal(s.records[0].before.prompts[0].content, 'old');
});
test('uncommitted live settings participate in snapshot while unknown saved fields survive', async () => {
  const s = setup(); s.mutateLive(x => { x.temperature = .2; delete x.unknown; });
  const snapshot = await s.adapter.read(); assert.equal(snapshot.raw.temperature, .2); assert.deepEqual(snapshot.raw.unknown, { kept: true }); assert.equal(snapshot.saved.temperature, 1);
});
test('failed backup prevents all preset writes', async () => {
  const s = setup({ failBackup: true }), expected = await s.adapter.read();
  await assert.rejects(s.adapter.commit({ expected, raw: expected.raw, binding: {}, beforeBinding: s.getBound(), store: s.store }), /quota/);
  assert.ok(!s.events.some(x => x[0] === 'save'));
});
test('changed switches, selected preset, disk contents, or author binding stop writes', async () => {
  for (const mutate of [s => s.mutateLive(x => { x.prompt_order[0].order[0].enabled = true; }), s => s.switchPreset('other'), s => s.mutateDisk(x => { x.temperature = .7; }), s => s.mutateBinding({ name: '当前预设', label: 'changed' })]) {
    const s = setup(), expected = await s.adapter.read(), beforeBinding = s.getBound(); mutate(s);
    await assert.rejects(s.adapter.commit({ expected, raw: expected.raw, binding: {}, beforeBinding, store: s.store }));
    assert.ok(!s.events.some(x => x[0] === 'save'));
  }
});
test('save errors leave old baseline and recoverable uncertain journal, with no automatic retry', async () => {
  const s = setup({ failSave: true }), expected = await s.adapter.read();
  await assert.rejects(s.adapter.commit({ expected, raw: expected.raw, binding: { label: 'new' }, beforeBinding: s.getBound(), store: s.store }), /备份/);
  assert.equal(s.getBound().label, 'old'); assert.equal(s.records[0].status, 'uncertain'); assert.equal(s.events.filter(x => x[0] === 'save').length, 1);
});
test('backend readback mismatch never refreshes UI or advances author baseline', async () => {
  const s = setup({ corruptDisk: true }), expected = await s.adapter.read();
  await assert.rejects(s.adapter.commit({ expected, raw: expected.raw, binding: { label: 'new' }, beforeBinding: s.getBound(), store: s.store }), /不一致/);
  assert.equal(s.getBound().label, 'old'); assert.ok(!s.events.some(x => x[0] === 'refresh')); assert.equal(s.records[0].status, 'uncertain');
});
test('database failure after saving retains enough data to recover the intended author baseline', async () => {
  const s = setup({ failFinish: true }), expected = await s.adapter.read(), raw = core.copy(expected.raw); raw.temperature = 2;
  await assert.rejects(s.adapter.commit({ expected, raw, binding: { label: 'new' }, beforeBinding: s.getBound(), store: s.store }));
  assert.equal(s.getDisk().temperature, 2); assert.equal(s.getBound().label, 'old'); assert.equal(s.records[0].nextBinding.label, 'new'); assert.equal(s.records[0].status, 'uncertain');
});
test('missing host capabilities and Text Completion contexts fail closed', () => {
  const s = setup(); s.context.mainApi = 'textgenerationwebui'; assert.throws(() => s.adapter.check(), /Chat Completion/);
  s.context.mainApi = 'openai'; s.openai.getChatCompletionPreset = undefined; assert.throws(() => s.adapter.check(), /停用/);
});
