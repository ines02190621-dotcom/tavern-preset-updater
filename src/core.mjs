import { createPresetGrouping } from './groups.mjs';
// Preset Smart Updater — raw Chat Completion preset merge engine.
// No network, DOM, prompt execution, or host mutations in this module.
export function createUpdaterCore() {
  const MISSING = Symbol('missing');
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const copy = v => v === MISSING || v === undefined ? v : JSON.parse(JSON.stringify(v));
  function canonical(v) {
    if (v === MISSING || v === undefined) return '<missing>';
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (object(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }
  const equal = (a, b) => canonical(a) === canonical(b);
  function uuid(crypto = globalThis.crypto) {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    if (typeof crypto?.getRandomValues !== 'function') throw Error('当前环境缺少随机编号接口，无法安全建立备份。');
    const a = crypto.getRandomValues(new Uint8Array(16)); a[6] = (a[6] & 15) | 64; a[8] = (a[8] & 63) | 128;
    const h = [...a].map(x => x.toString(16).padStart(2, '0')).join('');
    return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-');
  }
  const val = (o, k) => object(o) && own(o, k) ? o[k] : MISSING;
  const publicValue = v => v === MISSING ? { $missing: true } : copy(v);
  function assertSafe(v, depth = 0) {
    if (depth > 90) throw Error('JSON 嵌套过深，已停止。');
    if (!v || typeof v !== 'object') return;
    for (const k of Object.keys(v)) {
      if (['__proto__', 'prototype', 'constructor'].includes(k)) throw Error('JSON 含不安全的对象键，已停止。');
      assertSafe(v[k], depth + 1);
    }
  }
  function validate(p, label = '预设') {
    assertSafe(p);
    if (!object(p) || !Array.isArray(p.prompts) || !Array.isArray(p.prompt_order)) {
      throw Error(label + ' 必须是含 prompts 和 prompt_order 的原始 Chat Completion 预设 JSON。');
    }
    if (!p.prompts.length || p.prompts.length > 10000 || p.prompt_order.length > 2000) throw Error(label + ' 的条目数量不在支持范围。');
    const ids = new Set();
    for (const x of p.prompts) {
      if (!object(x) || typeof x.identifier !== 'string' || !x.identifier || typeof x.name !== 'string') throw Error(label + ' 有缺少编号或名称的条目。');
      if (ids.has(x.identifier)) throw Error(label + ' 含重复编号：' + x.identifier + '。请先在酒馆中处理重复条目。');
      ids.add(x.identifier);
      if (own(x, 'content') && typeof x.content !== 'string') throw Error(label + ' 有非文本正文：' + x.name);
    }
    const groups = new Set();
    for (const g of p.prompt_order) {
      if (!object(g) || !['number', 'string'].includes(typeof g.character_id) || !Array.isArray(g.order)) throw Error(label + ' 有无效的顺序组。');
      const key = String(g.character_id);
      if (groups.has(key)) throw Error(label + ' 含重复顺序组：' + key);
      groups.add(key);
      const seen = new Set();
      for (const x of g.order) {
        if (!object(x) || !ids.has(x.identifier)) throw Error(label + ' 的顺序列表引用不存在的条目：' + (x?.identifier ?? '空编号'));
        if (seen.has(x.identifier)) throw Error(label + ' 的同一顺序组重复引用了条目：' + x.identifier);
        if (own(x, 'enabled') && typeof x.enabled !== 'boolean') throw Error(label + ' 有无效开关。');
        seen.add(x.identifier);
      }
    }
    return p;
  }
  function parse(text, label) {
    if (typeof text !== 'string' || text.length > 32 * 1024 * 1024) throw Error('文件超过 32 MiB 限制。');
    let p;
    try { p = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw Error((label || '文件') + ' 不是有效 JSON。'); }
    return validate(p, label);
  }
  const prompts = p => new Map(p.prompts.map(x => [x.identifier, x]));
  function withoutId(p) { const r = copy(p); delete r.identifier; return r; }
  function fingerprint(p) {
    return canonical({ name: p.name, content: p.content, role: p.role ?? 'system', marker: !!p.marker, system_prompt: !!p.system_prompt });
  }
  // Exact ID first; automatic ID migration requires unique, byte-equivalent semantic content.
  // Name alone only proposes a match and always requires an explicit decision.
  function identify(base, side, storedMap = null) {
    validate(base); validate(side);
    const b = prompts(base), s = prompts(side), used = new Set(), rows = [];
    for (const p of b.values()) {
      let id = null, method = 'absent';
      if (storedMap && own(storedMap, p.identifier)) {
        id = storedMap[p.identifier];
        if (id !== null && s.has(id) && !used.has(id)) method = 'binding';
        else if (id === null) method = 'deleted';
        else id = null;
      } else if (s.has(p.identifier) && !used.has(p.identifier)) {
        id = p.identifier; method = 'id';
      }
      if (id !== null && s.has(id)) used.add(id);
      rows.push({ baseId: p.identifier, name: p.name, sideId: id, method, needsReview: false, candidates: [] });
    }
    for (const row of rows.filter(x => x.method === 'absent')) {
      const p = b.get(row.baseId);
      const candidates = [...s.values()].filter(x => !used.has(x.identifier));
      const exact = candidates.filter(x => fingerprint(x) === fingerprint(p));
      const reverseCount = exact.length === 1 ? rows.filter(x => x.method === 'absent' && fingerprint(b.get(x.baseId)) === fingerprint(exact[0])).length : 0;
      if (exact.length === 1 && reverseCount === 1) {
        row.sideId = exact[0].identifier; row.method = 'exact'; used.add(row.sideId);
      }
    }
    for (const row of rows.filter(x => x.sideId === null && x.method !== 'deleted')) {
      row.candidates = [...s.values()].filter(x => !used.has(x.identifier) && x.name === row.name).map(x => x.identifier);
      row.needsReview = row.candidates.length > 0;
    }
    return { rows, unmatched: side.prompts.filter(x => !used.has(x.identifier)).map(copy) };
  }
  function checkMap(base, side, map) {
    const seen = new Set(), sp = prompts(side);
    for (const p of base.prompts) {
      if (!own(map, p.identifier)) throw Error('条目对应关系尚未确认：' + p.name);
      const id = map[p.identifier];
      if (id !== null) {
        if (!sp.has(id)) throw Error('对应条目不存在：' + p.name);
        if (seen.has(id)) throw Error('多个作者条目对应到同一个条目，请重新核对。');
        seen.add(id);
      }
    }
  }
  function makeBinding(name, base, local, map, label) {
    validate(base); validate(local); checkMap(base, local, map);
    if (!Object.values(map).some(x => x !== null)) throw Error('还没有任何对应条目，不能安全绑定。请先核对旧版文件。');
    return { schema: 1, name, base: copy(base), authorMap: copy(map), label: label || '作者原版', updatedAt: new Date().toISOString() };
  }
  function isConnection(k) {
    return /(^|_)(model|models|url|urls|server|proxy|password|api_key|secret|provider|providers|endpoint|headers|connection)(_|$)/i.test(k)
      || ['chat_completion_source', 'custom_include_body', 'custom_exclude_body', 'custom_include_headers', 'additional_parameters_by_source', 'additional_parameters_migration_version', 'use_makersuite_sysprompt', 'vertexai_auth_mode'].includes(k);
  }
  function weave(primary, secondary) {
    const result = [...primary], inPrimary = new Set(primary);
    let lastInserted;
    let i = 0;
    while (i < secondary.length) {
      if (inPrimary.has(secondary[i])) { i++; continue; }
      const start = i, run = [];
      while (i < secondary.length && !inPrimary.has(secondary[i])) { if (!result.includes(secondary[i])) run.push(secondary[i]); i++; }
      if (!run.length) continue;
      const prev = secondary.slice(0, start).reverse().find(x => inPrimary.has(x));
      const next = secondary.slice(i).find(x => inPrimary.has(x));
      const anchored = prev !== undefined ? result.indexOf(prev) + 1 : next !== undefined ? result.indexOf(next) : result.length;
      const index = Math.max(anchored, lastInserted === undefined ? 0 : result.indexOf(lastInserted) + 1);
      result.splice(index, 0, ...run);
      lastInserted = run[run.length - 1];
    }
    return result;
  }
  function merge({ binding, local, remote, localMap = binding.authorMap, remoteMap, choices = {}, followAuthorEnabled = false }) {
    const base = binding.base;
    validate(base, '作者旧版'); validate(local, '当前预设'); validate(remote, '作者新版');
    checkMap(base, local, localMap); checkMap(base, remote, remoteMap);
    const conflicts = [], changes = [], notices = [], bp = prompts(base), lp = prompts(local), rp = prompts(remote);
    function decision(key, title, b, l, r, options = [{ value: 'local', label: '保留我的' }, { value: 'remote', label: '采用作者新版' }], defaultChoice = '') {
      const picked = own(choices, key) ? choices[key] : defaultChoice;
      const valid = options.some(x => x.value === picked);
      conflicts.push({ key, title, base: publicValue(b), local: publicValue(l), remote: publicValue(r), options, choice: valid ? picked : '', required: !defaultChoice });
      return valid ? picked : 'local'; // Preview is conservative; unresolved decisions block applying.
    }
    function mergeValue(b, l, r, path, title) {
      if (equal(l, r)) return copy(l);
      if (equal(b, r)) return copy(l);
      if (equal(b, l)) return copy(r);
      if (object(b) && object(l) && object(r)) {
        const out = {};
        for (const k of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
          const v = mergeValue(val(b, k), val(l, k), val(r, k), [...path, k], title + ' / ' + k);
          if (v !== MISSING) out[k] = v;
        }
        return out;
      }
      return copy(decision(JSON.stringify(path), title, b, l, r) === 'remote' ? r : l);
    }
    const grouping = createPresetGrouping({ base, local, remote, localMap, remoteMap, decision, mergeValue, copy, equal, weave, notices });
    const output = copy(local), entries = new Map(), bToOut = new Map(), lToOut = new Map(), rToOut = new Map(), nextMap = {};
    const forceLocalOrder = new Set(), forceRemoteOrder = new Set();
    const localAuthorIds = new Set(Object.values(localMap).filter(x => x !== null));
    const protectedIds = new Set(local.prompts.filter(x => !localAuthorIds.has(x.identifier)).map(x => x.identifier));
    const remoteMatched = new Set(Object.values(remoteMap).filter(x => x !== null));
    const orderState = (preset, id) => preset.prompt_order.flatMap(g => {
      const index = g.order.findIndex(x => x.identifier === id);
      return index < 0 ? [] : [{ character_id: g.character_id, index, ...copy(g.order[index]), identifier: 'matched-entry' }];
    });
    const flagsChanged = id => base.prompt_order.some(bg => {
      const lg = local.prompt_order.find(g => String(g.character_id) === String(bg.character_id));
      const br = bg.order.find(x => x.identifier === id);
      const lr = lg?.order.find(x => x.identifier === localMap[id]);
      return !equal(br ? { ...br, identifier: id } : MISSING, lr ? { ...lr, identifier: id } : MISSING);
    });
    for (const b of base.prompts) {
      const bid = b.identifier, lid = localMap[bid], rid = remoteMap[bid];
      const l = lid === null ? null : lp.get(lid), r = rid === null ? null : rp.get(rid);
      let outId = lid || rid || bid, result = null;
      const rawChanged = r && !equal(withoutId(b), withoutId(r));
      if (!r) {
        changes.push({ kind: 'deleted', name: b.name, id: bid, base: copy(b), local: copy(l), remote: null });
        if (l) {
          const locallyChanged = !equal(withoutId(b), withoutId(l)) || flagsChanged(bid) || grouping.locallyChanged(bid, lid);
          if (locallyChanged && decision('delete:' + bid, '作者删除了你调整过的条目：' + l.name, b, l, MISSING,
            [{ value: 'local', label: '保留此条目' }, { value: 'remote', label: '确认删除' }]) === 'local') { result = copy(l); forceLocalOrder.add(outId); }
        }
      } else if (!l) {
        if (rawChanged) {
          changes.push({ kind: 'modified', name: r.name, id: rid, base: copy(b), local: null, remote: copy(r) });
          if (decision('restore:' + bid, '你已删除、作者又修改的条目：' + r.name, b, MISSING, r,
            [{ value: 'local', label: '保持我的删除' }, { value: 'remote', label: '恢复作者新版条目' }]) === 'remote') { result = copy(r); forceRemoteOrder.add(outId); }
        }
      } else {
        const bb = withoutId(b), ll = withoutId(l), rr = withoutId(r);
        if (!followAuthorEnabled && own(ll, 'enabled')) { bb.enabled = ll.enabled; rr.enabled = ll.enabled; }
        result = mergeValue(bb, ll, rr, ['prompt', bid], l.name);
        result.identifier = outId;
        if (rawChanged || bid !== rid) changes.push({ kind: 'modified', name: r.name, id: rid, base: copy(b), local: copy(l), remote: copy(r), rekeyed: bid !== rid });
      }
      if (r && !equal(orderState(base, bid), orderState(remote, rid)) && !changes.some(x => x.kind === 'modified' && x.id === rid)) {
        changes.push({ kind: 'modified', name: r.name + '（顺序／开关）', id: rid,
          base: orderState(base, bid), local: lid ? orderState(local, lid) : null, remote: orderState(remote, rid), orderOnly: true });
      }
      if (result) {
        if (entries.has(outId) || (protectedIds.has(outId) && outId !== lid)) throw Error('作者编号与自定义条目相撞，请先核对对应关系：' + outId);
        result.identifier = outId; entries.set(outId, result);
        bToOut.set(bid, outId); if (lid) lToOut.set(lid, outId); if (rid) rToOut.set(rid, outId);
      }
      if (rid) nextMap[rid] = result ? outId : null;
    }
    for (const l of local.prompts.filter(x => protectedIds.has(x.identifier))) {
      if (entries.has(l.identifier)) throw Error('自定义条目编号冲突。');
      entries.set(l.identifier, copy(l)); lToOut.set(l.identifier, l.identifier);
      changes.push({ kind: 'custom', name: l.name, id: l.identifier, base: null, local: copy(l), remote: null });
    }
    for (const r of remote.prompts.filter(x => !remoteMatched.has(x.identifier))) {
      let outId = r.identifier, result = copy(r);
      changes.push({ kind: 'added', name: r.name, id: r.identifier, base: null, local: null, remote: copy(r) });
      if (entries.has(outId)) {
        const action = decision('collision:' + outId, '作者新增条目和现有条目编号相同：' + r.name, MISSING, entries.get(outId), r,
          [{ value: 'local', label: '保留现有，跳过作者新增' }, { value: 'both', label: '两条都保留（为作者新增生成编号）' }]);
        if (action === 'local') { nextMap[r.identifier] = null; continue; }
        let n = 1; while (entries.has(outId) || rp.has(outId) || lp.has(outId)) outId = 'pui-' + r.identifier + '-' + n++;
        result.identifier = outId;
        notices.push('编号冲突已保留两条：' + r.name + '。支持的折叠分组引用会同步转换编号；其他扩展中的编号引用需另行核对。');
      }
      entries.set(outId, result); rToOut.set(r.identifier, outId); nextMap[r.identifier] = outId;
    }
    // Physical prompts-array order is secondary to prompt_order, but preserve local storage order too.
    const localPhysical = local.prompts.map(p => lToOut.get(p.identifier)).filter(Boolean);
    const remotePhysical = remote.prompts.map(p => rToOut.get(p.identifier)).filter(Boolean);
    output.prompts = weave(localPhysical, remotePhysical).map(id => entries.get(id));
    for (const [id, p] of entries) if (!output.prompts.some(x => x.identifier === id)) output.prompts.push(p);
    const bgroups = new Map(base.prompt_order.map(g => [String(g.character_id), g]));
    const lgroups = new Map(local.prompt_order.map(g => [String(g.character_id), g]));
    const rgroups = new Map(remote.prompt_order.map(g => [String(g.character_id), g]));
    output.prompt_order = [];
    for (const gid of new Set([...lgroups.keys(), ...rgroups.keys()])) {
      const bg = bgroups.get(gid), lg = lgroups.get(gid), rg = rgroups.get(gid);
      const remapRows = (g, map) => new Map((g?.order || []).filter(x => map.has(x.identifier)).map(x => [map.get(x.identifier), { ...copy(x), identifier: map.get(x.identifier) }]));
      const bm = remapRows(bg, bToOut), lm = remapRows(lg, lToOut), rm = remapRows(rg, rToOut);
      const membership = new Map();
      for (const id of new Set([...lm.keys(), ...rm.keys(), ...bm.keys()])) {
        const b = bm.has(id) ? bm.get(id) : MISSING, l = lm.has(id) ? lm.get(id) : MISSING;
        // Missing remote groups are left intact; presets often export only one of ST's groups.
        const r = !rg && lg ? b : rm.has(id) ? rm.get(id) : MISSING;
        let v;
        if (protectedIds.has(id) || forceLocalOrder.has(id)) v = copy(l);
        else if (forceRemoteOrder.has(id)) v = copy(r);
        else if (l !== MISSING && r !== MISSING && !followAuthorEnabled) {
          const bb = b === MISSING ? MISSING : { ...b, enabled: l.enabled };
          const rr = { ...r }; if (own(l, 'enabled')) rr.enabled = l.enabled; else delete rr.enabled;
          v = mergeValue(bb, l, rr, ['order-row', gid, id], entries.get(id).name + '（开关及列表设置）');
        } else v = mergeValue(b, l, r, ['order-row', gid, id], entries.get(id).name + '（列表归属）');
        if (v !== MISSING && entries.has(id)) membership.set(id, v);
      }
      const seq = m => [...m.keys()].filter(id => membership.has(id));
      const bs = seq(bm), ls = seq(lm), rs = rg ? seq(rm) : bs;
      const common = bs.filter(id => ls.includes(id) && rs.includes(id));
      const restrict = s => s.filter(id => common.includes(id));
      const bseq = restrict(bs), lseq = restrict(ls), rseq = restrict(rs);
      const localMoved = !equal(bseq, lseq), remoteMoved = !equal(bseq, rseq);
      let strategy = localMoved ? 'local' : 'remote';
      if (localMoved && remoteMoved && !equal(lseq, rseq)) strategy = decision('order:' + gid, '你和作者都调整了条目顺序（组 ' + gid + '）', bs, ls, rs,
        [{ value: 'local', label: '保留我的顺序' }, { value: 'remote', label: '采用作者顺序，重新放回自定义条目' }]);
      let ordered;
      if (strategy === 'local') ordered = weave(ls, rs);
      else {
        const skeleton = weave(rs.filter(id => !protectedIds.has(id)), ls.filter(id => !protectedIds.has(id)));
        ordered = weave(skeleton, ls);
      }
      for (const id of membership.keys()) if (!ordered.includes(id)) ordered.push(id);
      const stripOrder = g => { if (!g) return MISSING; const x = copy(g); delete x.order; return x; };
      const g = mergeValue(stripOrder(bg), stripOrder(lg), rg ? stripOrder(rg) : stripOrder(bg), ['group', gid], '顺序组设置 / ' + gid);
      if (g === MISSING && !lg && !membership.size) continue;
      const group = g === MISSING ? copy(lg || rg) : g; delete group.order;
      group.order = ordered.map(id => membership.get(id)); output.prompt_order.push(group);
      const oldCustom = ls.filter(id => protectedIds.has(id));
      if (remoteMoved && oldCustom.length) notices.push('条目列表 ' + gid + ' 的作者顺序有调整；自定义条目保持彼此的顺序，插入位置按现存作者锚点尽量还原。折叠分组归属请看分组预览。');
      if (oldCustom.length && !ls.some(id => !protectedIds.has(id) && rs.includes(id))) notices.push('条目列表 ' + gid + ' 中自定义条目的原作者锚点均已消失，已保留自定义条目之间的顺序。');
    }
    for (const k of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
      if (['prompts', 'prompt_order', 'extensions'].includes(k)) continue;
      const b = val(base, k), l = val(local, k), r = val(remote, k);
      if (isConnection(k) || k === 'name') {
        if (!equal(b, r)) changes.push({ kind: 'connection', name: k, base: publicValue(b), local: publicValue(l), remote: publicValue(r) });
        continue;
      }
      if (!equal(b, r)) changes.push({ kind: 'setting', name: k, base: publicValue(b), local: publicValue(l), remote: publicValue(r) });
      const v = mergeValue(b, l, r, ['setting', k], '预设参数 / ' + k);
      if (v === MISSING) delete output[k]; else output[k] = v;
    }
    const be = grouping.strip(base.extensions), le = grouping.strip(local.extensions), re = grouping.strip(remote.extensions);
    const extensions = copy(le);
    for (const k of new Set([...Object.keys(be), ...Object.keys(le), ...Object.keys(re)])) {
      const b = val(be, k), l = val(le, k), r = val(re, k);
      if (!equal(b, r)) {
        changes.push({ kind: 'extension', name: k, base: publicValue(b), local: publicValue(l), remote: publicValue(r) });
        const action = decision('extension:' + k, '扩展内容 / ' + k + '（整项替换可能包含脚本或正则）', b, l, r,
          [{ value: 'local', label: '保留当前扩展（默认）' }, { value: 'remote', label: '采用作者整项扩展（覆盖此项）' }], 'local');
        if (action === 'remote') { if (r === MISSING) delete extensions[k]; else extensions[k] = copy(r); }
      }
    }
    const foldingGroups = grouping.merge({ output, extensions, bToOut, lToOut, rToOut, protectedIds, changes });
    if (Object.keys(extensions).length || own(local, 'extensions') || own(remote, 'extensions')) output.extensions = extensions;
    validate(output, '合并结果');
    // A last invariant check: every custom item, including unknown fields and its order-row settings, survives exactly.
    for (const id of protectedIds) {
      if (!equal(lp.get(id), output.prompts.find(x => x.identifier === id))) throw Error('自定义条目保护校验失败：' + id);
      for (const lg of local.prompt_order) {
        const lrow = lg.order.find(x => x.identifier === id);
        const orow = output.prompt_order.find(g => String(g.character_id) === String(lg.character_id))?.order.find(x => x.identifier === id);
        if (!equal(lrow, orow)) throw Error('自定义条目开关保护校验失败：' + id);
      }
    }
    for (const lg of local.prompt_order) {
      const og = output.prompt_order.find(g => String(g.character_id) === String(lg.character_id));
      if (!equal(lg.order.filter(x => protectedIds.has(x.identifier)).map(x => x.identifier), (og?.order || []).filter(x => protectedIds.has(x.identifier)).map(x => x.identifier))) throw Error('自定义条目相对顺序保护校验失败。');
    }
    return { output, nextMap, conflicts, changes, notices: [...new Set(notices)], customIds: [...protectedIds], foldingGroups, unresolved: conflicts.filter(x => !x.choice).length };
  }
  return { copy, canonical, equal, uuid, validate, parse, identify, checkMap, makeBinding, merge, weave, isConnection, assertSafe };
}
