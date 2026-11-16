import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createUpdaterCore } from '../src/core.mjs';
const c = createUpdaterCore();
const p = (id, content = id, extra = {}) => ({ identifier: id, name: id, role: 'system', content, system_prompt: false, ...extra });
function preset(ps = [p('a'), p('b'), p('c')], seq = ps.map(x => x.identifier)) {
  return { temperature: 1, custom_url: 'http://local.invalid', prompts: c.copy(ps), prompt_order: [{ character_id: 100001, order: seq.map(identifier => ({ identifier, enabled: true })) }], extensions: {} };
}
const map = (b, s, stored) => Object.fromEntries(c.identify(b, s, stored).rows.map(x => [x.baseId, x.sideId]));
const binding = (b, l) => c.makeBinding('当前预设', b, l, map(b, l), '旧版.json');
const merge = (b, l, r, opts = {}) => c.merge({ binding: binding(b, l), local: l, remote: r, remoteMap: map(b, r), ...opts });
const order = x => x.output.prompt_order[0].order.map(x => x.identifier);

test('no-op has byte-equivalent semantic roundtrip for native ST and TT fixtures', () => {
  for (const host of ['st', 'tt']) {
    const b = JSON.parse(fs.readFileSync(new URL('../research/' + host + '-default.json', import.meta.url)));
    const out = merge(b, b, b); assert.equal(out.unresolved, 0); assert.ok(c.equal(out.output, b));
  }
});
test('updates author content while retaining custom body, extra settings, order and disabled flag', () => {
  const b = preset(), l = c.copy(b), r = c.copy(b);
  const x = p('custom', '我的正文', { extra: { a: [1, 2] }, injection_depth: 7, injection_position: 1 });
  l.prompts.push(x); l.prompt_order[0].order.splice(1, 0, { identifier: 'custom', enabled: false, customFlag: 'kept' });
  r.prompts[0].content = '新版';
  const out = merge(b, l, r); assert.equal(out.unresolved, 0);
  assert.equal(out.output.prompts.find(x => x.identifier === 'a').content, '新版');
  assert.deepEqual(out.output.prompts.find(x => x.identifier === 'custom'), x);
  assert.deepEqual(order(out), ['a', 'custom', 'b', 'c']);
  assert.deepEqual(out.output.prompt_order[0].order[1], l.prompt_order[0].order[1]);
});
test('custom unused prompts stay unused', () => {
  const b = preset(), l = c.copy(b); l.prompts.push(p('unused', '', { foo: { enabled: false } }));
  const out = merge(b, l, b); assert.ok(out.output.prompts.some(x => x.identifier === 'unused')); assert.ok(!order(out).includes('unused'));
});
test('merges disjoint field edits on one prompt', () => {
  const b = preset(), l = c.copy(b), r = c.copy(b);
  l.prompts[0].extra = { mine: 1 }; r.prompts[0].content = 'author';
  const out = merge(b, l, r); assert.equal(out.unresolved, 0); assert.equal(out.output.prompts[0].content, 'author'); assert.equal(out.output.prompts[0].extra.mine, 1);
});
test('same-field conflicts require an explicit decision and honor local and remote', () => {
  const b = preset(), l = c.copy(b), r = c.copy(b); l.prompts[0].content = 'local'; r.prompts[0].content = 'remote';
  const out = merge(b, l, r); assert.equal(out.unresolved, 1); assert.equal(out.output.prompts[0].content, 'local');
  const choices = { [out.conflicts[0].key]: 'remote' }; const chosen = merge(b, l, r, { choices });
  assert.equal(chosen.unresolved, 0); assert.equal(chosen.output.prompts[0].content, 'remote');
  assert.equal(merge(b, l, r, { choices: { [out.conflicts[0].key]: 'invalid' } }).unresolved, 1);
});
test('author deletions are automatic only when local item is unchanged', () => {
  const b = preset(), r = preset([p('a'), p('c')]);
  assert.deepEqual(order(merge(b, b, r)), ['a', 'c']);
  const l = c.copy(b); l.prompts[1].content = 'edited';
  const out = merge(b, l, r); assert.equal(out.unresolved, 1); assert.ok(order(out).includes('b'));
  assert.ok(!order(merge(b, l, r, { choices: { 'delete:b': 'remote' } })).includes('b'));
});
test('author deletion conflicts with a user-changed switch', () => {
  const b = preset(), l = c.copy(b), r = preset([p('a'), p('c')]); l.prompt_order[0].order[1].enabled = false;
  const out = merge(b, l, r); assert.equal(out.unresolved, 1); assert.ok(order(out).includes('b'));
});
test('local deletions remain absent unless author modified the item and restore is chosen', () => {
  const b = preset(), l = preset([p('a'), p('c')]), r = c.copy(b);
  assert.ok(!order(merge(b, l, r)).includes('b'));
  r.prompts[1].content = 'changed'; const out = merge(b, l, r); assert.equal(out.unresolved, 1);
  assert.ok(order(merge(b, l, r, { choices: { 'restore:b': 'remote' } })).includes('b'));
});
test('existing switches stay local while new author switches use remote', () => {
  const b = preset(), l = c.copy(b), r = c.copy(b);
  r.prompt_order[0].order[0].enabled = false;
  r.prompts.push(p('new')); r.prompt_order[0].order.splice(1, 0, { identifier: 'new', enabled: false });
  const out = merge(b, l, r); assert.equal(out.unresolved, 0);
  assert.equal(out.output.prompt_order[0].order[0].enabled, true);
  assert.equal(out.output.prompt_order[0].order.find(x => x.identifier === 'new').enabled, false);
  assert.equal(merge(b, l, r, { followAuthorEnabled: true }).output.prompt_order[0].order[0].enabled, false);
});
test('unique name and exact body can migrate identifiers', () => {
  const b = preset(), r = c.copy(b); r.prompts[0].identifier = 'new-a'; r.prompt_order[0].order[0].identifier = 'new-a';
  const info = c.identify(b, r); assert.equal(info.rows[0].sideId, 'new-a'); assert.equal(info.rows[0].method, 'exact');
  const out = merge(b, b, r); assert.deepEqual(order(out), ['a', 'b', 'c']); assert.equal(out.nextMap['new-a'], 'a');
});
test('name-only matches are proposals and duplicate names are never guessed', () => {
  const b = preset([p('a', 'old', { name: '同名' })]);
  const r = preset([p('new1', 'new1', { name: '同名' }), p('new2', 'new2', { name: '同名' })]);
  const info = c.identify(b, r); assert.equal(info.rows[0].sideId, null); assert.equal(info.rows[0].needsReview, true); assert.equal(info.rows[0].candidates.length, 2);
});
test('author addition cannot overwrite a custom item with the same identifier', () => {
  const b = preset(), l = c.copy(b), r = c.copy(b); l.prompts.push(p('x', 'mine')); l.prompt_order[0].order.splice(1, 0, { identifier: 'x', enabled: false });
  r.prompts.push(p('x', 'remote')); r.prompt_order[0].order.push({ identifier: 'x', enabled: true });
  const out = merge(b, l, r); assert.equal(out.unresolved, 1); assert.equal(out.output.prompts.find(x => x.identifier === 'x').content, 'mine');
  const chosen = merge(b, l, r, { choices: { 'collision:x': 'both' } }); assert.equal(chosen.unresolved, 0);
  assert.equal(chosen.output.prompts.find(x => x.identifier === 'x').content, 'mine');
  assert.ok(chosen.output.prompts.some(x => x.content === 'remote' && x.identifier !== 'x')); assert.ok(chosen.nextMap.x.startsWith('pui-x-'));
});
test('custom entries preserve relative order when author reverses their anchors', () => {
  const b = preset(), l = preset([p('a'), p('x'), p('b'), p('y'), p('c')]), r = preset([p('a'), p('b'), p('c')], ['c', 'b', 'a']);
  const out = merge(b, l, r); assert.deepEqual(order(out).filter(id => ['x', 'y'].includes(id)), ['x', 'y']);
  assert.deepEqual(order(out).filter(id => ['a', 'b', 'c'].includes(id)), ['c', 'b', 'a']);
});
test('simultaneous incompatible author reordering needs a choice', () => {
  const b = preset(), l = preset(undefined, ['b', 'a', 'c']), r = preset(undefined, ['a', 'c', 'b']);
  const out = merge(b, l, r); assert.ok(out.conflicts.some(x => x.key === 'order:100001')); assert.equal(out.unresolved, 1);
  assert.deepEqual(order(merge(b, l, r, { choices: { 'order:100001': 'remote' } })), ['a', 'c', 'b']);
});
test('reanchors customs when preceding author item disappears', () => {
  const b = preset(), l = preset([p('a'), p('x'), p('b'), p('c')]), r = preset([p('b'), p('c')]);
  assert.deepEqual(order(merge(b, l, r)), ['x', 'b', 'c']);
});
test('all custom settings survive in multiple order groups', () => {
  const b = preset(), l = c.copy(b), r = c.copy(b); l.prompts.push(p('x'));
  l.prompt_order[0].order.push({ identifier: 'x', enabled: false, weight: 0 });
  l.prompt_order.push({ character_id: 'other', foo: [1], order: [{ identifier: 'x', enabled: true, custom: { deep: 1 } }] });
  r.prompts[0].content = 'new'; const out = merge(b, l, r);
  assert.deepEqual(out.output.prompt_order[1], l.prompt_order[1]);
});
test('connection, model and address fields always stay local', () => {
  const b = preset(), l = c.copy(b), r = c.copy(b);
  l.custom_url = 'http://mine.invalid'; r.custom_url = 'http://remote.invalid'; r.chat_completion_source = 'claude'; r.openai_model = 'other'; r.reverse_proxy = 'http://proxy.invalid';
  const out = merge(b, l, r); assert.equal(out.output.custom_url, l.custom_url); assert.ok(!('chat_completion_source' in out.output)); assert.ok(!('openai_model' in out.output)); assert.equal(out.unresolved, 0);
});
test('extensions are local by default and require explicit opt-in for whole-item replacement', () => {
  const b = preset(), l = c.copy(b), r = c.copy(b); l.extensions.regex_scripts = [{ id: 'mine', enabled: false }]; r.extensions.regex_scripts = [{ id: 'author' }];
  const out = merge(b, l, r); assert.equal(out.unresolved, 0); assert.deepEqual(out.output.extensions, l.extensions);
  assert.deepEqual(merge(b, l, r, { choices: { 'extension:regex_scripts': 'remote' } }).output.extensions, r.extensions);
});
test('new baseline advances while custom edits survive a second and third update', () => {
  const b = preset(), l = preset([p('a'), p('x'), p('b'), p('c')]), r = c.copy(b); r.prompts[0].content = 'v2';
  const first = merge(b, l, r), bound2 = { ...binding(b, l), base: r, authorMap: first.nextMap };
  const r3 = c.copy(r); r3.prompts[0].identifier = 'renamed'; r3.prompts[0].content = 'v3'; r3.prompt_order[0].order[0].identifier = 'renamed';
  const second = c.merge({ binding: bound2, local: first.output, remote: r3, remoteMap: { a: 'renamed', b: 'b', c: 'c' } });
  assert.equal(second.unresolved, 0); assert.equal(second.nextMap.renamed, 'a'); assert.equal(second.output.prompts.find(x => x.identifier === 'a').content, 'v3');
  const bound3 = { ...bound2, base: r3, authorMap: second.nextMap }, r4 = c.copy(r3); r4.prompts[0].content = 'v4';
  const third = c.merge({ binding: bound3, local: second.output, remote: r4, remoteMap: map(r3, r4) });
  assert.equal(third.output.prompts.find(x => x.identifier === 'a').content, 'v4'); assert.equal(third.output.prompts.find(x => x.identifier === 'x').content, 'x');
});
test('false, zero, empty string, empty arrays and missing values retain distinct semantics', () => {
  const b = preset(), l = c.copy(b), r = c.copy(b); Object.assign(b, { x: false, y: 0, z: '' }); Object.assign(l, { x: false, y: 0, z: '' }); Object.assign(r, { x: true, y: 1, z: 'next' });
  const out = merge(b, l, r); assert.equal(out.output.x, true); assert.equal(out.output.y, 1); assert.equal(out.output.z, 'next');
});
test('duplicate IDs, dangling references, wrong file types and prototype keys are blocked', () => {
  assert.throws(() => c.validate(preset([p('a'), p('a')])));
  const bad = preset(); bad.prompt_order[0].order.push({ identifier: 'ghost' }); assert.throws(() => c.validate(bad));
  assert.throws(() => c.parse('{"type":"script","content":"foo"}'));
  assert.throws(() => c.parse('{"__proto__":{},"prompts":[],"prompt_order":[]}'));
  assert.equal({}.polluted, undefined);
});
test('map assignments must be one-to-one and complete', () => {
  const b = preset(); assert.throws(() => c.checkMap(b, b, { a: 'a', b: 'a', c: 'c' })); assert.throws(() => c.checkMap(b, b, { a: 'a' }));
});
test('UUID generation also works for non-secure LAN pages without randomUUID', () => {
  const random = { getRandomValues: a => crypto.getRandomValues(a) };
  assert.match(c.uuid(random), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
test('merge does not mutate any input', () => {
  const b = preset(), l = preset([p('a'), p('x'), p('b'), p('c')]), r = c.copy(b); r.prompts[0].content = 'r';
  const before = c.canonical([b, l, r]); merge(b, l, r); assert.equal(c.canonical([b, l, r]), before);
});
test('randomized author insertions, deletions and reorderings cannot remove or mutate customs', () => {
  let seed = 987654321;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  for (let k = 0; k < 200; k++) {
    const b = preset(Array.from({ length: 8 }, (_, i) => p('a' + i)));
    const l = c.copy(b); let localSeq = l.prompt_order[0].order;
    for (let j = 0; j < 5; j++) { const x = p('custom' + j, 'custom data', { extra: { n: k, v: false } }); l.prompts.push(x); localSeq.splice(Math.floor(random() * (localSeq.length + 1)), 0, { identifier: x.identifier, enabled: random() > .5, n: k }); }
    const ps = b.prompts.filter(() => random() > .35).map(x => ({ ...x, content: 'updated ' + k })); ps.push(p('new' + k));
    const seq = ps.map(x => x.identifier); for (let i = seq.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [seq[i], seq[j]] = [seq[j], seq[i]]; }
    const out = merge(b, l, preset(ps, seq));
    for (const x of l.prompts.filter(x => x.identifier.startsWith('custom'))) assert.deepEqual(out.output.prompts.find(p => p.identifier === x.identifier), x);
    assert.deepEqual(order(out).filter(id => id.startsWith('custom')), localSeq.filter(x => x.identifier.startsWith('custom')).map(x => x.identifier));
    c.validate(out.output);
  }
});
