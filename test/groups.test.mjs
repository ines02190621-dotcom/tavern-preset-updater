import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdaterCore } from '../src/core.mjs';
const c = createUpdaterCore();
const prompt = id => ({ identifier: id, name: id, role: 'system', content: id });
const preset = (ids = ['a', 'b', 'c']) => ({ prompts: ids.map(prompt), prompt_order: [{ character_id: 100001, order: ids.map(identifier => ({ identifier, enabled: true })) }], extensions: {} });
const group = (id, name = id, extra = {}) => ({ id, name, order: 0, collapsed: true, enabled: true, ...extra });
function native(p, groups, members, extra = {}) {
  p.extensions.baibaiToolkit ||= {};
  p.extensions.baibaiToolkit.presetPromptGroups = { ...extra, groups: groups.map((g, order) => ({ ...g, order })), prompts: Object.fromEntries(Object.entries(members).map(([id, v]) => [id, typeof v === 'string' ? { groupId: v } : v])) };
  return p;
}
const state = p => p.extensions.baibaiToolkit.presetPromptGroups;
const map = (b, s) => Object.fromEntries(c.identify(b, s).rows.map(x => [x.baseId, x.sideId]));
const merge = (b, l, r, options = {}) => c.merge({ binding: c.makeBinding('缝合预设', b, l, map(b, l), '旧版'), local: l, remote: r, remoteMap: map(b, r), ...options });
function append(p, id, index = p.prompt_order[0].order.length) {
  p.prompts.push(prompt(id)); p.prompt_order[0].order.splice(index, 0, { identifier: id, enabled: false }); return p;
}
const basic = () => native(preset(), [group('g', '故事基调')], { a: 'g', b: 'g' });

test('author additions join their explicit group while custom metadata and group switches stay local', () => {
  const b = basic(), l = append(c.copy(b), 'x', 1), r = append(c.copy(b), 'n', 1);
  state(l).prompts.x = { groupId: 'g', unknown: { mine: true } }; state(l).groups[0].enabled = false; state(l).groups[0].collapsed = false;
  state(l).groups[0].customSetting = [1, false]; state(l).runtime = { retain: true };
  state(r).prompts.n = { groupId: 'g' };
  const out = merge(b, l, r); assert.equal(out.unresolved, 0);
  assert.equal(state(out.output).prompts.n.groupId, 'g'); assert.deepEqual(state(out.output).prompts.x, state(l).prompts.x);
  assert.deepEqual(state(out.output).groups[0], state(l).groups[0]); assert.deepEqual(state(out.output).runtime, state(l).runtime);
  assert.deepEqual(out.foldingGroups.groups[0].identifiers, ['a', 'x', 'n', 'b']);
});
test('native grouping no-op preserves the complete state including unknown fields', () => {
  const b = basic(); state(b).foo = [false, 0]; state(b).prompts.a.extra = { z: 1 };
  assert.deepEqual(merge(b, b, b).output, b);
});
test('compatibility ranges merge into local native groups across group and prompt rekeys', () => {
  const b = preset(['h', 'a', 'b', 't', 'c']);
  b.extensions.entryGrouping = [{ id: 'author-g', name: '顶部分组', startIdentifier: 'h', endIdentifier: 't', mode: 'exclusive' }];
  const l = append(c.copy(b), 'x', 2); native(l, [group('local-g', '顶部分组', { enabled: false })], { a: 'local-g', b: 'local-g' });
  const r = append(c.copy(b), 'n', 2); r.prompts.find(x => x.identifier === 'a').identifier = 'new-a'; r.prompt_order[0].order[1].identifier = 'new-a';
  r.extensions.entryGrouping[0].id = 'new-author-g';
  const out = merge(b, l, r); assert.equal(out.unresolved, 0);
  assert.equal(state(out.output).prompts.a.groupId, 'local-g'); assert.equal(state(out.output).prompts.n.groupId, 'local-g');
  assert.equal(state(out.output).groups[0].enabled, false); assert.ok(!state(out.output).prompts['new-a']); assert.ok(!state(out.output).prompts.x);
  assert.deepEqual(out.output.extensions.entryGrouping[0].memberIdentifiers, ['a', 'n', 'b']);
  assert.ok(!('startIdentifier' in out.output.extensions.entryGrouping[0]));
});
test('member-list compatibility wrappers retain unrelated wrapper and group settings', () => {
  for (const wrapper of ['groups', 'entries', 'entryGroups', 'items']) {
    const b = preset(); b.extensions.entryGrouping = { [wrapper]: [{ id: 'g', name: '组', memberIdentifiers: ['a', 'b'], unknown: { n: 1 } }], setting: false };
    const l = append(c.copy(b), 'x', 1); l.extensions.entryGrouping[wrapper][0].memberIdentifiers.push('x');
    const r = append(c.copy(b), 'n', 1); r.extensions.entryGrouping[wrapper][0].memberIdentifiers.push('n');
    const out = merge(b, l, r); assert.equal(out.unresolved, 0);
    assert.equal(out.output.extensions.entryGrouping.setting, false); assert.deepEqual(out.output.extensions.entryGrouping[wrapper][0].unknown, { n: 1 });
    assert.deepEqual(out.output.extensions.entryGrouping[wrapper][0].memberIdentifiers, ['a', 'x', 'n', 'b']);
  }
});
test('compatibility groups without IDs match names after a reordered import', () => {
  const b = preset(); b.extensions.entryGrouping = [{ name: '甲', memberIdentifiers: ['a'] }, { name: '乙', memberIdentifiers: ['b'] }];
  const l = native(c.copy(b), [group('mine-a', '甲'), group('mine-b', '乙')], { a: 'mine-a', b: 'mine-b' });
  const r = append(c.copy(b), 'n'); r.extensions.entryGrouping.reverse(); r.extensions.entryGrouping[1].memberIdentifiers.push('n');
  const out = merge(b, l, r); assert.equal(out.unresolved, 0); assert.equal(state(out.output).prompts.n.groupId, 'mine-a');
});
test('remote group membership and prompt ID collision references remap to the actual retained prompt', () => {
  const b = basic(), l = append(c.copy(b), 'x', 1), r = append(c.copy(b), 'x', 1); state(l).prompts.x = { groupId: 'g', mine: 42 }; state(r).prompts.x = { groupId: 'g' };
  const out = merge(b, l, r, { choices: { 'collision:x': 'both' } }); assert.equal(out.unresolved, 0);
  assert.deepEqual(state(out.output).prompts.x, state(l).prompts.x); assert.equal(state(out.output).prompts[out.nextMap.x].groupId, 'g'); assert.notEqual(out.nextMap.x, 'x');
});
test('independently added groups with colliding IDs require a choice and can remain separate', () => {
  const b = basic(), l = append(c.copy(b), 'x'), r = append(c.copy(b), 'n');
  state(l).groups.push(group('collision', '我的组', { order: 1, enabled: false })); state(l).prompts.x = { groupId: 'collision' };
  state(r).groups.push(group('collision', '作者新组', { order: 1 })); state(r).prompts.n = { groupId: 'collision' };
  const out = merge(b, l, r), conflict = out.conflicts.find(x => x.key.includes('folding:match:当前预设（新增分组）'));
  assert.ok(conflict); assert.ok(out.unresolved > 0);
  const separate = merge(b, l, r, { choices: { [conflict.key]: 'none' } }); assert.equal(separate.unresolved, 0);
  assert.equal(state(separate.output).prompts.x.groupId, 'collision'); assert.notEqual(state(separate.output).prompts.n.groupId, 'collision');
  assert.equal(state(separate.output).groups.find(x => x.id === 'collision').enabled, false);
  const joined = merge(b, l, r, { choices: { [conflict.key]: 'group:collision' } }); assert.equal(joined.unresolved, 0); assert.equal(state(joined.output).prompts.n.groupId, 'collision');
});
test('independent toolkit settings can be explicitly replaced without overwriting protected grouping', () => {
  const b = basic(), l = append(c.copy(b), 'x'), r = append(c.copy(b), 'n'); state(l).prompts.x = { groupId: 'g' }; state(l).groups[0].enabled = false; state(r).prompts.n = { groupId: 'g' };
  l.extensions.baibaiToolkit.other = { mine: true }; r.extensions.baibaiToolkit.other = { author: true };
  const out = merge(b, l, r, { choices: { 'extension:baibaiToolkit': 'remote' } });
  assert.equal(out.unresolved, 0); assert.deepEqual(out.output.extensions.baibaiToolkit.other, { author: true });
  assert.equal(state(out.output).prompts.x.groupId, 'g'); assert.equal(state(out.output).prompts.n.groupId, 'g'); assert.equal(state(out.output).groups[0].enabled, false);
});
test('both-side moves create a readable membership conflict and honor either choice', () => {
  const b = native(preset(), [group('g1', '一'), group('g2', '二'), group('g3', '三')], { a: 'g1', b: 'g2', c: 'g3' });
  const l = c.copy(b), r = c.copy(b); state(l).prompts.a.groupId = 'g2'; state(r).prompts.a.groupId = 'g3';
  const out = merge(b, l, r); assert.equal(out.unresolved, 1); assert.equal(state(out.output).prompts.a.groupId, 'g2');
  assert.equal(out.conflicts[0].key, 'folding:member:a'); assert.equal(out.conflicts[0].base, '一');
  assert.equal(state(merge(b, l, r, { choices: { 'folding:member:a': 'remote' } }).output).prompts.a.groupId, 'g3');
});
test('local moves survive when author grouping is unchanged and author moves apply to unchanged members', () => {
  const b = native(preset(), [group('g1'), group('g2')], { a: 'g1', b: 'g1', c: 'g2' });
  const l = c.copy(b), r = c.copy(b); state(l).prompts.a.groupId = 'g2'; state(r).prompts.b.groupId = 'g2';
  const out = merge(b, l, r); assert.equal(out.unresolved, 0); assert.equal(state(out.output).prompts.a.groupId, 'g2'); assert.equal(state(out.output).prompts.b.groupId, 'g2');
});
test('author deletion conflicts with a prompt whose only local change is group membership', () => {
  const b = native(preset(), [group('g1'), group('g2')], { a: 'g1', b: 'g1', c: 'g2' });
  const l = c.copy(b), r = native(preset(['b', 'c']), state(b).groups, { b: 'g1', c: 'g2' }); state(l).prompts.a.groupId = 'g2';
  const out = merge(b, l, r); assert.equal(out.unresolved, 1); assert.ok(out.conflicts.some(x => x.key === 'delete:a'));
  assert.equal(state(out.output).prompts.a.groupId, 'g2'); assert.ok(!state(merge(b, l, r, { choices: { 'delete:a': 'remote' } }).output).prompts.a);
});
test('deleted author groups cannot remove customs and dead prompt references are pruned', () => {
  const b = basic(), l = append(c.copy(b), 'x', 1), r = preset(['c']); state(l).prompts.x = { groupId: 'g', extra: [false] };
  native(r, [], {});
  const out = merge(b, l, r); assert.equal(out.unresolved, 0); assert.deepEqual(state(out.output).prompts, { x: { groupId: 'g', extra: [false] } });
  assert.equal(state(out.output).groups[0].id, 'g'); assert.ok(out.output.prompts.some(x => x.identifier === 'x'));
});
test('explicitly restored local-deleted prompts adopt the remote group', () => {
  const b = basic(), l = native(preset(['b', 'c']), state(b).groups, { b: 'g' }), r = c.copy(b); r.prompts[0].content = 'new';
  const out = merge(b, l, r, { choices: { 'restore:a': 'remote' } }); assert.equal(out.unresolved, 0); assert.equal(state(out.output).prompts.a.groupId, 'g');
});
test('author presets without group records retain existing membership and require choices for active additions', () => {
  const b = basic(), l = c.copy(b), r = append(preset(), 'n', 1);
  const pending = merge(b, l, r); assert.equal(pending.unresolved, 1); assert.ok(pending.conflicts.some(x => x.key === 'folding:place:n'));
  assert.equal(state(pending.output).prompts.a.groupId, 'g');
  const out = merge(b, l, r, { choices: { 'folding:place:n': 'group:g' } }); assert.equal(out.unresolved, 0); assert.equal(state(out.output).prompts.n.groupId, 'g');
  const separate = merge(b, l, r, { choices: { 'folding:place:n': 'ungrouped' } }); assert.equal(separate.unresolved, 0); assert.ok(separate.foldingGroups.ungrouped.includes('n'));
  assert.equal(merge(b, l, r, { choices: { 'folding:place:n': 'invalid' } }).unresolved, 1);
});
test('ungrouped new author prompts are respected when an explicit remote grouping record exists', () => {
  const b = basic(), r = append(c.copy(b), 'n'); const out = merge(b, b, r);
  assert.equal(out.unresolved, 0); assert.ok(!state(out.output).prompts.n); assert.ok(out.foldingGroups.ungrouped.includes('n'));
});
test('unused author additions do not trigger grouping choices or become active', () => {
  const b = basic(), r = preset(); r.prompts.push(prompt('unused'));
  const out = merge(b, b, r); assert.equal(out.unresolved, 0); assert.ok(!state(out.output).prompts.unused); assert.ok(!out.foldingGroups.ungrouped.includes('unused'));
});
test('unused customs and secondary-order-only members retain native group references and settings', () => {
  const b = basic(), l = c.copy(b), r = append(c.copy(b), 'n'); state(r).prompts.n = { groupId: 'g' };
  l.prompts.push(prompt('unused'), prompt('secondary'));
  state(l).prompts.unused = { groupId: 'g', retained: [0, false] }; state(l).prompts.secondary = { groupId: 'g', retained: 'secondary' };
  l.prompt_order.push({ character_id: 123, order: [{ identifier: 'secondary', enabled: false }] });
  const out = merge(b, l, r); assert.equal(out.unresolved, 0);
  assert.deepEqual(state(out.output).prompts.unused, state(l).prompts.unused); assert.deepEqual(state(out.output).prompts.secondary, state(l).prompts.secondary);
  assert.deepEqual(out.output.prompt_order[1], l.prompt_order[1]);
});
test('author group order can update while retaining local group power and customs', () => {
  const b = native(preset(), [group('g1'), group('g2'), group('g3')], { a: 'g1', b: 'g2', c: 'g3' });
  const l = c.copy(b), r = c.copy(b); state(l).groups[0].enabled = false;
  state(r).groups = [state(r).groups[2], state(r).groups[0], state(r).groups[1]].map((g, order) => ({ ...g, order }));
  const out = merge(b, l, r); assert.equal(out.unresolved, 0); assert.deepEqual(state(out.output).groups.map(x => x.id), ['g3', 'g1', 'g2']);
  assert.equal(state(out.output).groups.find(x => x.id === 'g1').enabled, false);
});
test('both-side group-order edits require an explicit choice', () => {
  const b = native(preset(), [group('g1'), group('g2'), group('g3')], { a: 'g1', b: 'g2', c: 'g3' });
  const l = c.copy(b), r = c.copy(b);
  state(l).groups = [state(l).groups[1], state(l).groups[0], state(l).groups[2]].map((g, order) => ({ ...g, order }));
  state(r).groups = [state(r).groups[0], state(r).groups[2], state(r).groups[1]].map((g, order) => ({ ...g, order }));
  const out = merge(b, l, r); assert.ok(out.conflicts.some(x => x.key === 'folding:order'));
  assert.deepEqual(state(merge(b, l, r, { choices: { 'folding:order': 'remote' } }).output).groups.map(x => x.id), ['g1', 'g3', 'g2']);
});
test('duplicate names use unique exact author-member signatures rather than first-name guessing', () => {
  const b = native(preset(), [group('g1', '同名'), group('g2', '同名')], { a: 'g1', b: 'g2' });
  const l = native(c.copy(b), [group('local1', '同名'), group('local2', '同名')], { a: 'local1', b: 'local2' });
  const r = append(c.copy(b), 'n'); state(r).prompts.n = { groupId: 'g2' };
  const out = merge(b, l, r); assert.equal(out.unresolved, 0); assert.equal(state(out.output).prompts.n.groupId, 'local2');
});
test('ambiguous split groups require review instead of guessing a correspondence', () => {
  const b = basic(), l = native(c.copy(b), [group('mine1', '分组一'), group('mine2', '分组二')], { a: 'mine1', b: 'mine2' }), r = append(c.copy(b), 'n'); state(r).prompts.n = { groupId: 'g' };
  const out = merge(b, l, r); const conflict = out.conflicts.find(x => x.key === 'folding:match:当前预设:g'); assert.ok(conflict); assert.ok(out.unresolved > 0);
  const chosen = merge(b, l, r, { choices: { [conflict.key]: 'group:mine1' } }); assert.equal(chosen.unresolved, 0); assert.equal(state(chosen.output).prompts.n.groupId, 'mine1'); assert.equal(state(chosen.output).prompts.b.groupId, 'mine2');
});
test('different range and member layouts require a format choice and native data takes priority', () => {
  const b = preset(); b.extensions.entryGrouping = [{ id: 'g', name: '组', startIdentifier: 'a', endIdentifier: 'b', memberIdentifiers: ['b', 'c'] }];
  const out = merge(b, b, b); assert.ok(out.conflicts.some(x => x.key.startsWith('folding:format:'))); assert.ok(out.unresolved > 0);
  const choices = Object.fromEntries(out.conflicts.map(x => [x.key, 'range']));
  const chosen = merge(b, b, b, { choices }); assert.equal(chosen.unresolved, 0); assert.deepEqual(chosen.output.extensions.entryGrouping[0].memberIdentifiers, ['a', 'b']);
  native(b, [group('native')], { a: 'native' }); assert.equal(merge(b, b, b).unresolved, 0);
});
test('group renames merge by ID and incompatible renames need a choice', () => {
  const b = basic(), l = c.copy(b), r = c.copy(b); state(r).groups[0].name = '新名字';
  assert.equal(state(merge(b, l, r).output).groups[0].name, '新名字');
  state(l).groups[0].name = '我的名字'; const out = merge(b, l, r); assert.equal(out.unresolved, 1);
  assert.equal(state(merge(b, l, r, { choices: { [out.conflicts[0].key]: 'remote' } }).output).groups[0].name, '新名字');
});
test('malformed native groups fail closed, while unrelated unsupported extensions remain unchanged', () => {
  const b = basic(), r = c.copy(b); state(r).groups.push(c.copy(state(r).groups[0]));
  assert.throws(() => merge(b, b, r), /分组.*重复编号/);
  r.extensions.baibaiToolkit.presetPromptGroups = { groups: 'wrong', prompts: {} }; assert.throws(() => merge(b, b, r), /分组格式无效/);
  const plain = preset(); plain.extensions.luker = { prompt_groups: [{ id: 'unknown', identifiers: ['a'] }] };
  const out = merge(plain, plain, plain); assert.deepEqual(out.output.extensions, plain.extensions); assert.ok(out.notices.some(x => x.includes('单独核对')));
});
test('next update retains manual placement of prior additions and protects inputs from mutation', () => {
  const b = basic(), l = append(c.copy(b), 'x'), r = append(c.copy(b), 'n'); state(l).prompts.x = { groupId: 'g' }; state(r).prompts.n = { groupId: 'g' };
  const originals = c.copy([b, l, r]), first = merge(b, l, r); assert.deepEqual([b, l, r], originals);
  const nextLocal = c.copy(first.output); state(nextLocal).groups.push(group('mine', '我的分组', { order: 1 })); state(nextLocal).prompts.n.groupId = 'mine';
  const nextRemote = append(c.copy(r), 'n2'); state(nextRemote).prompts.n2 = { groupId: 'g' };
  const second = c.merge({ binding: { ...c.makeBinding('缝合预设', b, l, map(b, l)), base: r, authorMap: first.nextMap }, local: nextLocal, remote: nextRemote, remoteMap: map(r, nextRemote) });
  assert.equal(second.unresolved, 0); assert.equal(state(second.output).prompts.n.groupId, 'mine'); assert.equal(state(second.output).prompts.n2.groupId, 'g'); assert.equal(state(second.output).prompts.x.groupId, 'g');
});
test('random author group moves, deletions and insertions cannot alter custom membership or group switches', () => {
  let seed = 38129;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let round = 0; round < 80; round++) {
    const ids = Array.from({ length: 12 }, (_, i) => 'author' + i), groups = Array.from({ length: 3 }, (_, i) => group('g' + i));
    const b = native(preset(ids), groups, Object.fromEntries(ids.map((id, i) => [id, 'g' + i % 3]))), l = c.copy(b), r = c.copy(b);
    for (let i = 0; i < 5; i++) {
      const id = 'custom' + i; append(l, id, random(l.prompt_order[0].order.length + 1));
      if (i !== 4) state(l).prompts[id] = { groupId: 'g' + random(3), extra: { round, disabled: false } };
    }
    for (const g of state(l).groups) { g.enabled = !!random(2); g.collapsed = !!random(2); }
    for (let i = 0; i < 3; i++) { const id = 'new' + i; append(r, id, random(r.prompt_order[0].order.length + 1)); state(r).prompts[id] = { groupId: 'g' + random(3) }; }
    for (const id of ids.filter(() => random(4) === 0)) { r.prompts = r.prompts.filter(x => x.identifier !== id); r.prompt_order[0].order = r.prompt_order[0].order.filter(x => x.identifier !== id); delete state(r).prompts[id]; }
    for (const id of ids.filter(id => state(r).prompts[id])) state(r).prompts[id].groupId = 'g' + random(3);
    const out = merge(b, l, r); assert.equal(out.unresolved, 0);
    for (let i = 0; i < 5; i++) assert.deepEqual(state(out.output).prompts['custom' + i], state(l).prompts['custom' + i]);
    assert.deepEqual(state(out.output).groups, state(l).groups);
    for (let i = 0; i < 3; i++) assert.equal(state(out.output).prompts['new' + i].groupId, state(r).prompts['new' + i].groupId);
  }
});
