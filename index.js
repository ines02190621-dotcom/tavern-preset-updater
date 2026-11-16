(function () {
"use strict";
// Shared per-user namespace for native extensions and TavernHelper scripts.
async function resolveUpdaterScope({ core, context, mode, readLegacy, writeLegacy }) {
  const KEY = '__preset_smart_updater_scope_v1', MODULE = 'preset_smart_updater';
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const valid = value => typeof value === 'string' && /^[a-zA-Z0-9-]{10,80}$/.test(value);
  const settings = context?.extensionSettings;
  const saved = object(settings) && object(settings[MODULE]) ? settings[MODULE].scope : undefined;
  const globalVariables = object(settings?.variables?.global) ? settings.variables.global : null;
  const storedLegacy = globalVariables?.[KEY];
  const helperLegacy = typeof readLegacy === 'function' ? readLegacy()?.[KEY] : undefined;
  const present = [saved, storedLegacy, helperLegacy].filter(value => value !== undefined && value !== null && value !== '');
  if (present.some(value => !valid(value))) throw Error('更新器的数据空间编号无效，已停用写入。请先保留完整恢复包，勿清除应用数据。');
  if (new Set(present).size > 1) throw Error('发现扩展版与脚本版的数据空间不一致，已停止写入。请先从旧版导出完整恢复包，再核对来源。');
  const scope = present[0] || core.uuid();
  if (mode !== 'extension') {
    if (typeof readLegacy !== 'function' || typeof writeLegacy !== 'function') throw Error('酒馆助手缺少全局变量接口。');
    if (helperLegacy !== scope) writeLegacy({ [KEY]: scope });
    return scope;
  }
  if (!object(settings) || typeof context?.saveSettingsDebounced !== 'function') throw Error('当前酒馆缺少用户扩展设置保存接口，原位写入已停用。');
  const needsSettings = saved !== scope, needsLegacy = globalVariables && storedLegacy !== scope;
  if (needsSettings || needsLegacy) {
    const hadModule = Object.prototype.hasOwnProperty.call(settings, MODULE), before = settings[MODULE];
    const hadLegacy = globalVariables && Object.prototype.hasOwnProperty.call(globalVariables, KEY);
    settings[MODULE] = { ...(object(before) ? before : {}), schema: 1, scope };
    if (globalVariables) globalVariables[KEY] = scope;
    try { await context.saveSettingsDebounced(); }
    catch (error) {
      if (hadModule) settings[MODULE] = before; else delete settings[MODULE];
      if (globalVariables) { if (hadLegacy) globalVariables[KEY] = storedLegacy; else delete globalVariables[KEY]; }
      throw Error('更新器用户设置无法保存，未打开备份数据库：' + (error?.message || error));
    }
  }
  return scope;
}


// Schema-aware folding groups for BaiBai Toolkit and its entryGrouping import format.
// Grouping is independent from ST's prompt_order character_id lists.
function createPresetGrouping({ base, local, remote, localMap, remoteMap, decision, mergeValue, copy, equal, weave, notices }) {
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const normalize = s => String(s).normalize('NFKC').trim().toLocaleLowerCase();
  const activeOrder = p => (p.prompt_order.find(g => String(g.character_id) === '100001') || p.prompt_order[0])?.order.map(x => x.identifier) || [];
  const compatKeys = ['groups', 'entries', 'entryGroups', 'items'];
  function read(p, side) {
    const ext = p.extensions || {}, native = ext.baibaiToolkit?.presetPromptGroups, compat = ext.entryGrouping;
    const active = activeOrder(p), valid = new Set(p.prompts.map(x => x.identifier));
    function nativeLayout() {
      if (native === undefined) return null;
      if (!object(native) || !Array.isArray(native.groups) || !object(native.prompts)) throw Error('折叠分组格式无效（' + side + ' / 柏宝箱），已停止合并。');
      if (native.groups.length > 2000) throw Error('折叠分组数量超出支持范围（' + side + '），已停止合并。');
      const groups = [], seen = new Set(), members = new Map();
      for (const [index, raw] of native.groups.entries()) {
        if (!object(raw) || typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) throw Error('折叠分组含无效或重复编号（' + side + '），已停止合并。');
        seen.add(raw.id);
        groups.push({ key: raw.id, stable: true, name: String(raw.name || '未命名分组'), raw: copy(raw), native: true, index,
          order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index });
      }
      groups.sort((a, b) => a.order - b.order);
      let stale = 0;
      for (const [id, meta] of Object.entries(native.prompts)) {
        if (!object(meta) || !seen.has(meta.groupId) || !valid.has(id)) { stale++; continue; }
        members.set(id, { key: meta.groupId, raw: copy(meta) });
      }
      if (stale) notices.push(side + '的分组记录有 ' + stale + ' 个失效引用；仅清理这些分组引用，不删除条目。');
      return { groups, members, native: true, raw: copy(native) };
    }
    const ng = nativeLayout();
    const wrapperKey = object(compat) ? compatKeys.find(k => Array.isArray(compat[k])) : null;
    const items = Array.isArray(compat) ? compat : wrapperKey ? compat[wrapperKey] : [];
    if (items.length > 2000) throw Error('兼容分组数量超出支持范围（' + side + '），已停止合并。');
    function compatibility(mode) {
      const groups = [], members = new Map(), seen = new Set();
      for (const [index, raw] of items.entries()) {
        if (!object(raw)) continue;
        let ids;
        if (mode === 'members') ids = Array.isArray(raw.memberIdentifiers) ? raw.memberIdentifiers.map(String).filter(id => valid.has(id)) : [];
        else {
          const a = active.indexOf(raw.startIdentifier), b = active.indexOf(raw.endIdentifier);
          if (a < 0 || b < 0) continue;
          const exclusive = String(raw.mode || 'inclusive').toLowerCase() === 'exclusive';
          ids = active.slice(Math.min(a, b) + (exclusive ? 1 : 0), Math.max(a, b) + (exclusive ? 0 : 1));
        }
        ids = ids.filter(id => !members.has(id)); if (!ids.length) continue;
        const stable = raw.id !== undefined && String(raw.id) !== '';
        const key = stable ? String(raw.id) : 'pui-compat-' + index;
        if (seen.has(key)) throw Error('兼容分组含重复编号（' + side + '），已停止合并。');
        seen.add(key);
        groups.push({ key, stable, name: String(raw.name || '未命名分组'), raw: copy(raw), native: false, index, order: index });
        for (const id of ids) members.set(id, { key, raw: {} });
      }
      return groups.length && members.size ? { groups, members, native: false, raw: copy(compat), wrapperKey, mode } : null;
    }
    const range = compatibility('range'), members = compatibility('members');
    // A populated native layout wins, exactly as the toolkit's loader does.
    let layout = ng?.groups.length && ng.members.size ? ng : null;
    if (!layout && range && members) {
      const view = g => ({ groups: g.groups.map(x => [x.key, x.name]), members: [...g.members].map(([id, m]) => [id, m.key]).sort((a, z) => a[0].localeCompare(z[0])) });
      if (equal(view(range), view(members))) layout = members;
      else {
        const selected = decision('folding:format:' + side, side + '的分组同时包含两种不同记录，请确认格式', null, view(members), view(range),
          [{ value: 'members', label: '采用成员列表' }, { value: 'range', label: '采用起止范围' }]);
        layout = selected === 'range' ? range : members;
      }
    }
    layout ||= members || range || ng;
    const recognizedCompat = !!(members || range) || Array.isArray(compat) && !compat.length || !!wrapperKey && !items.length;
    if (compat !== undefined && !recognizedCompat) notices.push(side + '含未识别的 entryGrouping 分组格式；该项按普通扩展保留，请核对分组。');
    for (const key of ['luker', 'prompt_folding']) if (ext[key] !== undefined) notices.push('检测到 ' + key + ' 分组扩展，本版只自动合并柏宝箱及兼容 entryGrouping 分组；其他分组扩展仍需单独核对。');
    return { ...layout, groups: layout?.groups || [], members: layout?.members || new Map(), known: !!layout || recognizedCompat,
      nativePresent: native !== undefined, compatPresent: recognizedCompat, compat, wrapperKey, active, side };
  }
  const b = read(base, '作者旧版'), l = read(local, '当前预设'), r = read(remote, '作者新版');
  const meaningful = b.groups.length || l.groups.length || r.groups.length;
  const toAuthor = sideMap => new Map(Object.entries(sideMap).filter(([, id]) => id !== null).map(([bid, id]) => [id, bid]));
  const bid = new Map(base.prompts.map(x => [x.identifier, x.identifier])), lid = toAuthor(localMap), rid = toAuthor(remoteMap);
  function match(from, to, fromAuthors, toAuthors, label, added = false) {
    const result = new Map(), used = new Set();
    const bind = (a, z) => { result.set(a.key, z.key); used.add(z.key); };
    for (const g of from.groups) {
      const found = to.groups.find(x => !used.has(x.key) && g.stable && x.stable && x.key === g.key);
      // Two independently added groups can reuse an ID, just like prompts can.
      const shared = found && [...from.members].some(([id, m]) => m.key === g.key && fromAuthors.has(id) && [...to.members].some(([otherId, other]) => other.key === found.key && toAuthors.get(otherId) === fromAuthors.get(id)));
      if (found && (!added || shared)) bind(g, found);
    }
    for (const g of from.groups.filter(x => !result.has(x.key))) {
      const candidates = to.groups.filter(x => !used.has(x.key) && normalize(x.name) === normalize(g.name));
      if (added && candidates.some(x => x.key === g.key)) continue;
      if (candidates.length === 1 && from.groups.filter(x => !result.has(x.key) && normalize(x.name) === normalize(g.name)).length === 1) bind(g, candidates[0]);
    }
    const sharedAuthors = new Set([...fromAuthors.values()].filter(id => [...toAuthors.values()].includes(id)));
    const signature = (layout, group, authors) => [...layout.members].filter(([id, m]) => m.key === group.key && sharedAuthors.has(authors.get(id))).map(([id]) => authors.get(id)).sort();
    for (const g of from.groups.filter(x => !result.has(x.key))) {
      const sig = signature(from, g, fromAuthors); if (!sig.length) continue;
      const candidates = to.groups.filter(x => !used.has(x.key) && equal(signature(to, x, toAuthors), sig));
      if (candidates.length === 1 && from.groups.filter(x => !result.has(x.key) && equal(signature(from, x, fromAuthors), sig)).length === 1) bind(g, candidates[0]);
    }
    for (const g of from.groups.filter(x => !result.has(x.key))) {
      const sig = signature(from, g, fromAuthors);
      const candidates = to.groups.filter(x => !used.has(x.key) && (g.stable && x.stable && g.key === x.key || normalize(x.name) === normalize(g.name) || signature(to, x, toAuthors).some(id => sig.includes(id))));
      if (!candidates.length) continue;
      const picked = decision('folding:match:' + label + ':' + g.key, '核对分组「' + g.name + '」在' + label + '中的对应', null, g.name, candidates.map(x => x.name),
        [{ value: 'none', label: '没有对应分组，分别保留' }, ...candidates.map(x => ({ value: 'group:' + x.key, label: x.name + ' · ' + x.key.slice(0, 16) }))]);
      const found = candidates.find(x => 'group:' + x.key === picked); if (found) bind(g, found);
    }
    return result;
  }
  const bToL = meaningful ? match(b, l, bid, lid, '当前预设') : new Map();
  const bToR = meaningful ? match(b, r, bid, rid, '作者新版') : new Map();
  const lUsed = new Set(bToL.values()), rUsed = new Set(bToR.values());
  const newLocal = { ...l, groups: l.groups.filter(x => !lUsed.has(x.key)) };
  const newRemote = { ...r, groups: r.groups.filter(x => !rUsed.has(x.key)) };
  const rNewToL = meaningful ? match(newRemote, newLocal, rid, lid, '当前预设（新增分组）', true) : new Map();
  const sameLocalGroup = (baseGroup, localGroup) => baseGroup == null ? localGroup == null : bToL.get(baseGroup) === localGroup;
  function locallyChanged(baseId, localId) {
    if (!b.known && !l.known) return false;
    return !sameLocalGroup(b.members.get(baseId)?.key ?? null, l.members.get(localId)?.key ?? null);
  }
  const handleNative = b.nativePresent || l.nativePresent || r.nativePresent;
  const handleCompat = b.compatPresent || l.compatPresent || r.compatPresent;
  if (handleCompat && l.compat !== undefined && !l.compatPresent && !handleNative) throw Error('当前预设的 entryGrouping 分组格式无法识别，不能安全替换分组记录。请保留当前预设并核对格式。');
  function strip(extensions = {}) {
    const ext = copy(extensions);
    if (handleNative && object(ext.baibaiToolkit)) {
      delete ext.baibaiToolkit.presetPromptGroups;
      if (!Object.keys(ext.baibaiToolkit).length) delete ext.baibaiToolkit;
    }
    if (handleCompat && (extensions.entryGrouping === undefined || [b, l, r].some(x => x.compatPresent && equal(x.compat, extensions.entryGrouping)))) delete ext.entryGrouping;
    return ext;
  }
  function merge({ output, extensions, bToOut, lToOut, rToOut, protectedIds, changes }) {
    if (!handleNative && !handleCompat) return null;
    if (object(extensions.baibaiToolkit) === false && extensions.baibaiToolkit !== undefined) throw Error('柏宝箱其他扩展设置不是对象，无法安全合并分组。');
    const groups = new Map(), bm = new Map(), lm = new Map(), rm = new Map();
    const allIds = new Set([...l.groups, ...b.groups, ...r.groups].map(g => g.key));
    function freshId(wanted) {
      if (!groups.has(wanted)) return wanted;
      let n = 1; while (allIds.has('pui-group-' + wanted + '-' + n) || groups.has('pui-group-' + wanted + '-' + n)) n++;
      return 'pui-group-' + wanted + '-' + n;
    }
    for (const g of l.groups) { groups.set(g.key, { l: g }); lm.set(g.key, g.key); }
    for (const g of b.groups) {
      const lg = bToL.get(g.key), rg = bToR.get(g.key);
      let key = lg || freshId(rg || g.key);
      const record = groups.get(key) || {}; record.b = g;
      if (rg) { record.r = r.groups.find(x => x.key === rg); rm.set(rg, key); }
      groups.set(key, record); bm.set(g.key, key);
    }
    for (const g of r.groups.filter(x => !rm.has(x.key))) {
      const lg = rNewToL.get(g.key), key = lg || freshId(g.key);
      const record = groups.get(key) || {}; record.r = g; groups.set(key, record); rm.set(g.key, key);
    }
    const names = new Map(output.prompts.map(x => [x.identifier, x.name]));
    const meta = (layout, sourceMap, groupMap) => new Map([...layout.members].filter(([id]) => sourceMap.has(id)).map(([id, m]) => [sourceMap.get(id), { groupId: groupMap.get(m.key), raw: m.raw }]));
    const bs = meta(b, bToOut, bm), ls = meta(l, lToOut, lm), rs = meta(r, rToOut, rm);
    const existingLocal = new Set(lToOut.values()), existingRemote = new Set(rToOut.values());
    const active = activeOrder(output), selected = new Map();
    const used = new Set(output.prompt_order.flatMap(g => g.order.map(x => x.identifier)));
    // Native metadata can also reference a secondary order list or an unused prompt.
    // Preserve these references instead of mistaking them for deleted prompts.
    const eligible = [...new Set([...active, ...used, ...bs.keys(), ...ls.keys(), ...rs.keys()])].filter(id => names.has(id));
    const groupName = key => key == null ? '不放入分组' : groups.get(key)?.l?.name || groups.get(key)?.r?.name || groups.get(key)?.b?.name || key;
    for (const id of eligible) {
      const bv = bs.get(id)?.groupId ?? null, lv = ls.get(id)?.groupId ?? null, rv = rs.get(id)?.groupId ?? null;
      let chosen;
      if (protectedIds.has(id) || !existingRemote.has(id)) chosen = lv;
      else if (!r.known) {
        chosen = lv;
        if (!existingLocal.has(id) && groups.size && used.has(id)) {
          const choice = decision('folding:place:' + id, '作者新版未提供分组，请选择新增条目的分组：' + names.get(id), null, null, null,
            [{ value: 'ungrouped', label: '保持独立，不放入分组' }, ...[...groups.keys()].filter(k => groups.get(k).l || groups.get(k).r).map(k => ({ value: 'group:' + k, label: groupName(k) }))]);
          chosen = choice.startsWith('group:') && groups.has(choice.slice(6)) ? choice.slice(6) : null;
        }
      } else if (!existingLocal.has(id)) chosen = rv; // Includes explicitly restored author prompts.
      else if (lv === rv || bv === rv) chosen = lv;
      else if (bv === lv) chosen = rv;
      else chosen = decision('folding:member:' + id, '你和作者都调整了分组：' + names.get(id), groupName(bv), groupName(lv), groupName(rv),
        [{ value: 'local', label: '保留当前：' + groupName(lv) }, { value: 'remote', label: '采用作者：' + groupName(rv) }]) === 'remote' ? rv : lv;
      if (chosen != null) {
        const raw = existingLocal.has(id) ? copy(ls.get(id)?.raw || {}) : copy(rs.get(id)?.raw || {});
        raw.groupId = chosen; selected.set(id, raw);
      }
      if (chosen !== lv) changes.push({ kind: 'grouping', name: names.get(id), base: groupName(bv), local: groupName(lv), remote: groupName(chosen) });
    }
    const needed = new Set([...selected.values()].map(x => x.groupId));
    for (const [key, record] of groups) if (!record.l && (!record.r || record.b && !needed.has(key))) groups.delete(key);
    const seq = (layout, map) => layout.groups.map(g => map.get(g.key)).filter(k => groups.has(k));
    const bseq = seq(b, bm), lseq = seq(l, lm), rseq = seq(r, rm);
    const common = bseq.filter(k => lseq.includes(k) && rseq.includes(k));
    const commonSeq = s => s.filter(k => common.includes(k));
    const localMoved = !equal(commonSeq(bseq), commonSeq(lseq)), remoteMoved = r.known && !equal(commonSeq(bseq), commonSeq(rseq));
    let order = localMoved || !r.known ? 'local' : 'remote';
    if (localMoved && remoteMoved && !equal(commonSeq(lseq), commonSeq(rseq))) order = decision('folding:order', '你和作者都调整了折叠分组的顺序', bseq.map(groupName), lseq.map(groupName), rseq.map(groupName),
      [{ value: 'local', label: '保留当前分组顺序' }, { value: 'remote', label: '采用作者分组顺序，并放回我的分组' }]);
    const ordered = order === 'remote' ? weave(rseq, lseq) : weave(lseq, rseq);
    for (const key of groups.keys()) if (!ordered.includes(key)) ordered.push(key);
    const groupRows = ordered.map((key, index) => {
      const record = groups.get(key), { b: bg, l: lg, r: rg } = record;
      const name = bg && lg && rg ? mergeValue(bg.name, lg.name, rg.name, ['folding-group', key, 'name'], '折叠分组名称 / ' + lg.name) : (lg || rg || bg).name;
      const raw = copy((lg?.native ? lg.raw : rg?.native ? rg.raw : {}));
      const source = lg || rg || bg;
      const row = { ...raw, id: key, name, order: index, collapsed: source.native ? !!source.raw.collapsed : true, enabled: source.native ? source.raw.enabled !== false : true };
      if (lg && name !== lg.name) changes.push({ kind: 'grouping', name: '分组名称 / ' + lg.name, base: bg?.name, local: lg.name, remote: name });
      if (!lg && rg) changes.push({ kind: 'grouping', name: '新增分组 / ' + name, base: null, local: null, remote: name });
      return row;
    });
    const stateRaw = copy(l.native && l.raw || r.native && r.raw || {});
    if (handleNative) {
      extensions.baibaiToolkit ||= {};
      extensions.baibaiToolkit.presetPromptGroups = { ...stateRaw, groups: groupRows, prompts: Object.fromEntries(selected) };
    }
    if (handleCompat && (l.compat === undefined || l.compatPresent)) {
      const source = l.compatPresent ? l : r.compatPresent ? r : b;
      const compatRows = groupRows.map(g => {
        const record = groups.get(g.id), sourceRaw = record.l && !record.l.native ? record.l.raw : record.r && !record.r.native ? record.r.raw : {};
        const raw = copy(sourceRaw); delete raw.startIdentifier; delete raw.endIdentifier; delete raw.mode;
        return { ...raw, id: g.id, name: g.name, memberIdentifiers: eligible.filter(id => selected.get(id)?.groupId === g.id) };
      });
      if (source.wrapperKey) extensions.entryGrouping = { ...copy(source.compat), [source.wrapperKey]: compatRows };
      else extensions.entryGrouping = compatRows;
    }
    // Protect custom membership and all of its metadata, including explicitly ungrouped items.
    for (const id of protectedIds) {
      if (!names.has(id)) continue;
      const old = l.members.get(id), now = selected.get(id);
      if ((old?.key ?? null) !== (now?.groupId ?? null) || old && l.native && !equal(old.raw, now)) throw Error('自定义条目分组保护校验失败：' + names.get(id));
    }
    if (!r.known && groupRows.length && [...rToOut.values()].some(id => !existingLocal.has(id) && used.has(id))) notices.push('作者新版没有可识别的分组记录；新增条目的分组需要在预览中明确选择，未选择前不能更新。');
    if (handleNative || handleCompat) notices.push('已合并折叠分组：保留自定义条目归属及当前分组总开关、折叠状态。请展开下方的分组预览核对。');
    return { provider: '柏宝箱 / entryGrouping', groups: groupRows.map(g => ({ ...g, identifiers: active.filter(id => selected.get(id)?.groupId === g.id) })), ungrouped: active.filter(id => !selected.has(id)) };
  }
  return { locallyChanged, strip, merge };
}


// Preset Smart Updater — raw Chat Completion preset merge engine.
// No network, DOM, prompt execution, or host mutations in this module.
function createUpdaterCore() {
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


function createHostAdapter({ host, context, openai, core }) {
  const ctx = () => typeof context === 'function' ? context() : context;
  const manager = () => ctx()?.getPresetManager?.('openai');
  function check() {
    const c = ctx(), m = manager();
    if (c?.mainApi !== 'openai') throw Error('请先切换到 Chat Completion／聊天补全，再打开更新器。');
    for (const key of ['getSelectedPresetName', 'getSelectedPreset', 'getPresetList', 'savePreset', 'updateList']) {
      if (typeof m?.[key] !== 'function') throw Error('此版本缺少预设接口 ' + key + '，已停用原位写入。仍可离线对比和导出。');
    }
    if (typeof openai?.getChatCompletionPreset !== 'function' || typeof openai?.getPresetApplicationPromise !== 'function') {
      throw Error('无法可靠读取当前未保存的设置，已停用原位写入。请更新酒馆，或使用离线对比。');
    }
    return m;
  }
  function names() {
    const m = check(), { preset_names } = m.getPresetList();
    return Array.isArray(preset_names) ? [...preset_names] : Object.keys(preset_names);
  }
  function cached(name) {
    const m = check(), { presets, preset_names } = m.getPresetList();
    const index = Array.isArray(preset_names) ? preset_names.indexOf(name) : Object.prototype.hasOwnProperty.call(preset_names, name) ? preset_names[name] : undefined;
    if (index === undefined || index === -1 || !presets[index]) throw Error('目标预设已不存在，停止写入。');
    const p = typeof presets[index] === 'string' ? JSON.parse(presets[index]) : presets[index];
    return core.copy(core.validate(p, '已保存预设'));
  }
  async function read() {
    const m = check();
    await openai.getPresetApplicationPromise();
    const name = m.getSelectedPresetName();
    if (!name || m.getSelectedPreset() === 'gui') throw Error('请先选中一个已保存的预设。');
    const saved = cached(name);
    const live = openai.getChatCompletionPreset();
    core.validate(live, '正在使用的预设');
    const raw = { ...saved, ...core.copy(live) };
    return { name, raw, saved, names: names() };
  }
  async function disk(name) {
    const c = ctx();
    if (typeof c?.getRequestHeaders !== 'function') throw Error('缺少安全请求头接口，不能校验已保存文件。');
    // Host fetch is deliberate: TT's parent window installs its Rust transport interceptor here.
    const r = await host.fetch('/api/settings/get', { method: 'POST', headers: c.getRequestHeaders(), body: '{}', cache: 'no-store' });
    if (!r.ok) throw Error('无法读取磁盘预设进行校验（' + r.status + '）。');
    const data = await r.json();
    const ns = data.openai_setting_names, ps = data.openai_settings;
    if (!Array.isArray(ps) || (!Array.isArray(ns) && (!ns || typeof ns !== 'object'))) throw Error('磁盘预设列表格式不受支持，已停止。');
    const index = Array.isArray(ns) ? ns.indexOf(name) : Object.prototype.hasOwnProperty.call(ns, name) ? ns[name] : -1;
    if (index === -1 || index === undefined || ps[index] === undefined) throw Error('磁盘中未找到目标预设，停止写入。');
    const raw = typeof ps[index] === 'string' ? JSON.parse(ps[index]) : ps[index];
    return core.copy(core.validate(raw, '磁盘预设'));
  }
  async function guard(expected) {
    const now = await read();
    if (now.name !== expected.name || !core.equal(now.raw, expected.raw) || !core.equal(now.saved, expected.saved)
      || !core.equal([...now.names].sort(), [...expected.names].sort())) throw Error('预览之后预设、开关或预设列表发生变化，请重新生成预览。');
    const persisted = await disk(expected.name);
    if (!core.equal(persisted, expected.saved)) throw Error('另一个窗口或设备改过已保存的预设。请刷新酒馆后重新预览，避免覆盖。');
    return now;
  }
  async function persist(name, raw) {
    const m = check();
    if (!names().includes(name) || m.getSelectedPresetName() !== name) throw Error('目标预设或当前选择已改变，停止写入。');
    core.validate(raw, '待写入预设');
    await m.savePreset(name, core.copy(raw), { skipUpdate: true });
    const result = await disk(name);
    if (!core.equal(result, raw)) throw Error('写入后的磁盘内容与合并结果不一致。备份已保留；请在“备份恢复”中检查。');
    if (m.getSelectedPresetName() !== name) throw Error('写入期间切换了预设；文件已保存，尚未刷新当前界面。请重新选中目标预设。');
    m.updateList(name, core.copy(raw));
    await openai.getPresetApplicationPromise();
    if (!names().includes(name)) throw Error('保存后目标名称不见了，请检查备份。');
    return result;
  }
  async function commit({ expected, raw, binding, store, reason = '更新', beforeBinding }) {
    await guard(expected);
    if (!core.equal((await store.getBinding(expected.name)) || null, beforeBinding || null)) throw Error('绑定基准被另一个更新器改动，请重新预览。');
    const record = {
      id: core.uuid(host.crypto), name: expected.name, at: new Date().toISOString(), reason,
      status: 'prepared', before: core.copy(expected.raw), diskBefore: core.copy(expected.saved),
      beforeBinding: core.copy(beforeBinding), intended: core.copy(raw), nextBinding: core.copy(binding),
    };
    // Write-ahead backup is a committed IDB transaction. No preset write if it fails.
    await store.putBackup(record);
    let attempted = false;
    try {
      await guard(expected); // Backup I/O can take time; check again immediately before writing.
      attempted = true;
      await persist(expected.name, raw);
      record.status = 'verified';
      await store.finish(record, binding);
      return record;
    } catch (e) {
      record.status = attempted ? 'uncertain' : 'cancelled'; record.error = String(e?.message || e);
      try { await store.putBackup(record); } catch { /* The committed prepared backup remains usable. */ }
      throw Error(String(e?.message || e) + '\n已保留更新前备份。不会自动重试或再次覆盖；请到备份恢复页核对。');
    }
  }
  return { check, names, read, disk, guard, persist, commit };
}


async function createUpdaterStore({ host, scope, core }) {
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



async function startUpdater(runtime = {}) {
  const core = createUpdaterCore();
  let host = runtime.host || window.parent;
  try { void host.document.body; } catch { host = window; }
  const SINGLETON = '__presetSmartUpdaterV1';
  const VERSION = '1.1.0', mode = runtime.mode || 'script';
  const registerButton = open => {
    if (typeof runtime.registerButton === 'function') return runtime.registerButton(open);
    if (typeof eventOn === 'function' && typeof getButtonEvent === 'function') { eventOn(getButtonEvent('预设更新器'), open); return () => {}; }
    throw Error('酒馆助手脚本按钮接口不可用，请使用扩展版或更新酒馆助手。');
  };
  if (host[SINGLETON]?.version === VERSION && !(mode === 'extension' && host[SINGLETON].mode !== 'extension')) {
    registerButton(host[SINGLETON].open);
    return host[SINGLETON];
  }
  if (host[SINGLETON]?.busy) throw Error('预设更新器正在处理任务，请等完成后再切换脚本版或扩展版。');
  // A failed v1.0.0 open could leave a detached dialog referenced by its singleton.
  try { host[SINGLETON]?.dispose?.(); host[SINGLETON]?.close?.(); } catch { /* Replace the stale UI instance below. */ }
  const doc = host.document;
  const context = () => host.SillyTavern?.getContext?.() || (typeof SillyTavern !== 'undefined' ? SillyTavern : null);
  let openai, adapter, store, initialization, initializedScope, detachButton, interfaceError = '', storageError = '';
  const resolveScope = () => resolveUpdaterScope({ core, context: context(), mode,
    readLegacy: mode === 'script' && typeof getVariables === 'function' ? () => getVariables({ type: 'global' }) : undefined,
    writeLegacy: mode === 'script' && typeof insertOrAssignVariables === 'function' ? value => insertOrAssignVariables(value, { type: 'global' }) : undefined });
  const memory = new Map();
  const memoryStore = () => ({ getBinding: async n => memory.get(n), putBinding: async b => memory.set(b.name, core.copy(b)), backups: async () => [] });
  function bounded(promise, ms, message, disposeLate) {
    return new Promise((resolve, reject) => {
      let expired = false;
      const timer = host.setTimeout(() => { expired = true; reject(Error(message)); }, ms);
      Promise.resolve(promise).then(value => {
        host.clearTimeout(timer);
        if (expired) { disposeLate?.(value); return; }
        resolve(value);
      }, error => { host.clearTimeout(timer); if (!expired) reject(error); });
    });
  }
  function initialize() {
    if (initialization) return initialization;
    initialization = (async () => {
      try {
        const url = new URL('scripts/openai.js', doc.baseURI);
        if (url.origin !== host.location.origin) throw Error('页面基础路径不在酒馆本地。');
        // Reuse the actual host module cache, never the helper iframe's module graph.
        openai = await bounded(host.Function('return import(' + JSON.stringify(url.href) + ')')(), 12000, '本地预设模块载入超时');
      } catch (e) { interfaceError = '没有载入酒馆本地的预设模块：' + (e?.message || e); }
      adapter = createHostAdapter({ host, context, openai, core });
      try {
        const scope = await resolveScope(); initializedScope = scope;
        store = await bounded(createUpdaterStore({ host, scope, core }), 8000, '备份数据库打开超时，原位写入已停用', value => value.close());
        // A host-side account/settings switch must never reuse another user's database.
        const withLock = store.withLock;
        store.withLock = action => withLock(async () => {
          if (await resolveScope() !== initializedScope) throw Error('当前用户的数据空间发生变化，请刷新酒馆后重新打开更新器。');
          return action();
        });
      } catch (e) { storageError = e?.message || String(e); }
      // A failed database never falls back to an unprotected preset write.
      if (!store) store = memoryStore();
      if (disposed) store.close?.();
    })();
    return initialization;
  }
  const state = { tab: 'update', snapshot: null, binding: null, oldFile: null, newFile: null, bindMap: null, localMap: null,
    remoteMap: null, choices: {}, plan: null, busy: false, offline: false, reviewed: false, massReviewed: false, followEnabled: false, backups: [], backupLimit: 30, notice: '' };
  let dialog, root, panel, status, note, busyMask;
  const el = (tag, text, cls) => {
    const x = doc.createElement(tag); if (text !== undefined && text !== null) x.textContent = String(text); if (cls) x.className = cls; return x;
  };
  const btn = (text, fn, cls = '') => {
    const b = el('button', text, cls); b.type = 'button'; b.addEventListener('click', () => run(fn)); return b;
  };
  const msg = (text, cls = 'muted') => el('p', text, cls);
  function showNote(text, bad = false) { state.notice = text; if (note) { note.textContent = text; note.className = bad ? 'note error' : 'note'; note.hidden = !text; } }
  async function run(fn) {
    if (state.busy) return;
    state.busy = true; if (busyMask) busyMask.hidden = false;
    try { await fn(); }
    catch (e) { showNote(e?.message || String(e), true); }
    finally { state.busy = false; if (busyMask) busyMask.hidden = true; updateStatus(); }
  }
  function close() {
    if (state.busy) return;
    if (dialog) { dialog.remove(); dialog = null; }
  }
  function fileInput(label, callback, subtitle) {
    const box = el('label', null, 'file'); box.append(el('span', label, 'file-title'));
    if (subtitle) box.append(el('small', subtitle));
    const input = el('input'); input.type = 'file'; input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files?.[0]; if (!file) return;
      run(async () => {
        if (file.size > 32 * 1024 * 1024) throw Error('文件大于 32 MiB，请先检查文件。');
        await callback(file, await file.text());
      });
    });
    box.append(input); return box;
  }
  function download(name, value) {
    const blob = new host.Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = host.URL.createObjectURL(blob), a = el('a');
    a.href = url; a.download = name.replace(/[\\/:*?"<>|]/g, '_'); a.hidden = true; doc.body.append(a); a.click(); a.remove();
    host.setTimeout(() => host.URL.revokeObjectURL(url), 60000);
    showNote('已请求导出文件。iPhone／TT 可能显示保存或分享面板，请完成保存。');
  }
  function details(title, build) {
    const d = el('details'), s = el('summary', title); d.append(s);
    d.addEventListener('toggle', () => { if (d.open && !d.dataset.loaded) { d.dataset.loaded = '1'; build(d); } });
    return d;
  }
  function diff(container, values) {
    const grid = el('div', null, 'diff');
    ['作者旧版', '我当前的', '作者新版'].forEach((title, i) => {
      const col = el('section'); col.append(el('strong', title));
      let v = values[i];
      let text = v === null || v === undefined || v?.$missing === true ? '（不存在）' : typeof v === 'string' ? v : JSON.stringify(v, null, 2);
      col.append(el('pre', text)); grid.append(col);
    }); container.append(grid);
  }
  async function confirmAction(title, text, label) {
    return new Promise(resolve => {
      const shade = el('div', null, 'confirm-shade'), card = el('section', null, 'confirm-card');
      card.setAttribute('role', 'alertdialog'); card.setAttribute('aria-label', title);
      card.append(el('h2', title), msg(text, 'confirm-text'));
      const actions = el('div', null, 'actions');
      const finish = value => { shade.remove(); resolve(value); };
      // This dialog is intentionally usable while the outer action holds the busy flag.
      const no = el('button', '先返回看看'), yes = el('button', label, 'primary');
      no.addEventListener('click', () => finish(false)); yes.addEventListener('click', () => finish(true));
      actions.append(no, yes); card.append(actions); shade.append(card); root.append(shade); yes.focus();
    });
  }
  function initialMap(info) {
    const map = {};
    for (const x of info.rows) map[x.baseId] = x.needsReview ? undefined : x.sideId;
    return map;
  }
  function mappingView(title, base, side, map, info, targetLabel = '当前缝合版') {
    const outer = el('section', null, 'mapping');
    outer.dataset.mappingTarget = targetLabel;
    outer.append(el('h3', title));
    const unresolved = () => base.prompts.filter(x => map[x.identifier] === undefined).length;
    const summary = msg(''); outer.append(summary);
    const refreshSummary = () => {
      const assigned = new Set(Object.values(map).filter(x => typeof x === 'string'));
      summary.textContent = '已对应 ' + assigned.size + ' 条；' + targetLabel + '中未对应条目 ' + side.prompts.filter(x => !assigned.has(x.identifier)).length + ' 条；待确认 ' + unresolved() + ' 项。';
    };
    refreshSummary();
    const normalizeSearch = text => String(text).normalize('NFKC').trim().toLowerCase();
    const searchField = (label, placeholder) => {
      const input = el('input', null, 'map-search-field'); input.type = 'search'; input.placeholder = placeholder;
      input.setAttribute('aria-label', label); input.autocomplete = 'off'; input.setAttribute('autocapitalize', 'off'); input.spellcheck = false;
      return input;
    };
    const sourceBox = el('label', null, 'map-source-search');
    const sourceSearch = searchField(title + '：查找旧版条目', '输入旧版条目关键词，如：三水');
    sourceBox.append(el('span', '查找要核对的旧版条目'), sourceSearch);
    const sourceCount = el('small', '', 'map-source-count'); sourceCount.setAttribute('role', 'status');
    outer.append(sourceBox, sourceCount);
    const unusual = new Set(info.rows.filter(x => x.method !== 'id' && x.method !== 'binding').map(x => x.baseId));
    const rowCache = new Map(), sideById = new Map(side.prompts.map(p => [p.identifier, p]));
    const makeRow = p => {
      if (rowCache.has(p.identifier)) return rowCache.get(p.identifier);
      const row = el('div', null, 'map-row'); row.dataset.baseId = p.identifier;
      const source = el('div', null, 'map-source'); source.append(el('small', '作者旧版条目'), el('span', p.name));
      const controls = el('div', null, 'map-controls'), select = el('select'); select.setAttribute('aria-label', title + '：' + p.name);
      const candidateSearch = searchField(title + '：搜索' + targetLabel + '候选条目：' + p.name, '搜索' + targetLabel + '名称，如：三水');
      candidateSearch.classList.add('map-candidate-search');
      const candidateCount = el('small', '', 'map-candidate-count'); candidateCount.setAttribute('role', 'status');
      const appendOption = (q, retained = false) => {
        const o = el('option', (retained ? '当前已选：' : '') + q.name + ' · ' + q.identifier.slice(0, 16));
        o.value = JSON.stringify(q.identifier); select.append(o);
      };
      const filterCandidates = () => {
        const keyword = normalizeSearch(candidateSearch.value);
        const matches = keyword ? side.prompts.filter(q => normalizeSearch(q.name).includes(keyword)) : side.prompts;
        const selectedId = map[p.identifier];
        select.replaceChildren();
        const pending = el('option', '请确认对应关系'); pending.value = '?'; select.append(pending);
        const absent = el('option', '不存在／已删除（另侧剩余条目独立保留）'); absent.value = 'null'; select.append(absent);
        // Filtering is a view operation. Keep an out-of-filter selection explicitly
        // visible so a native mobile select never silently changes the mapping.
        if (typeof selectedId === 'string' && sideById.has(selectedId) && !matches.some(q => q.identifier === selectedId)) appendOption(sideById.get(selectedId), true);
        for (const q of matches) appendOption(q);
        select.value = selectedId === undefined ? '?' : JSON.stringify(selectedId);
        candidateCount.textContent = keyword ? matches.length ? '找到 ' + matches.length + ' 个匹配项' : '没有匹配的名称，可换关键词或清空搜索。' : '';
        candidateCount.hidden = !keyword;
      };
      candidateSearch.addEventListener('input', filterCandidates);
      candidateSearch.addEventListener('search', filterCandidates);
      select.addEventListener('change', () => {
        map[p.identifier] = select.value === '?' ? undefined : JSON.parse(select.value);
        state.plan = null; state.choices = {}; state.reviewed = false; refreshSummary(); filterCandidates();
      });
      filterCandidates();
      controls.append(el('small', '在' + targetLabel + '中对应'), candidateSearch, candidateCount, select);
      row.append(source, controls); rowCache.set(p.identifier, row); return row;
    };
    const primaryRows = el('div', null, 'map-primary-rows'), matchedRows = el('div', null, 'map-matched-rows');
    const fillMatched = () => matchedRows.replaceChildren(...base.prompts.filter(x => !unusual.has(x.identifier)).map(makeRow));
    const matchedDetails = details('核对其他已匹配条目（可手动改对应）', d => { d.append(matchedRows); fillMatched(); });
    const filterSource = () => {
      const keyword = normalizeSearch(sourceSearch.value);
      const matches = base.prompts.filter(p => keyword ? normalizeSearch(p.name).includes(keyword) : unusual.has(p.identifier));
      primaryRows.replaceChildren(...matches.map(makeRow));
      matchedDetails.hidden = !!keyword;
      sourceCount.textContent = keyword ? '找到 ' + matches.length + ' 条旧版条目（包含已匹配条目）' : '';
      sourceCount.hidden = !keyword;
      if (keyword && !matches.length) primaryRows.append(msg('没有匹配的旧版条目，可换关键词或清空搜索。'));
      if (!keyword && matchedDetails.dataset.loaded) fillMatched();
    };
    sourceSearch.addEventListener('input', filterSource); sourceSearch.addEventListener('search', filterSource);
    outer.append(primaryRows, matchedDetails); filterSource();
    return outer;
  }
  function resolved(base, side, map) {
    if (!map || base.prompts.some(p => map[p.identifier] === undefined)) throw Error('还有待确认的条目对应关系，请先核对下拉框。');
    core.checkMap(base, side, map); return core.copy(map);
  }
  async function refreshCurrent() {
    if (initializedScope && !storageError && await resolveScope() !== initializedScope) throw Error('当前用户的数据空间发生变化，请刷新酒馆后重新打开更新器。');
    const previous = state.snapshot;
    if (state.offline) { if (!state.snapshot) throw Error('请先选择你当前修改版的 JSON。'); }
    else {
      if (interfaceError) throw Error(interfaceError);
      state.snapshot = await adapter.read();
    }
    if (previous && (previous.name !== state.snapshot.name || !core.equal(previous.raw, state.snapshot.raw))) state.bindMap = null;
    if (previous && previous.name !== state.snapshot.name) { state.oldFile = null; state.newFile = null; state.massReviewed = false; }
    state.binding = (await store.getBinding(state.snapshot.name)) || null;
    state.plan = null; state.choices = {}; state.localMap = null; state.remoteMap = null; state.reviewed = false;
    updateStatus();
  }
  async function ensureNoPending(name) {
    const pending = (await store.backups(name)).filter(x => ['prepared', 'uncertain'].includes(x.status));
    if (pending.length) throw Error('此预设有未核对的更新记录。请先到“备份恢复”点“核对保存结果”，再继续更新。');
  }
  function updateStatus() {
    if (!status) return;
    status.textContent = state.snapshot ? (state.offline ? '离线对比 · ' : '正在使用 · ') + state.snapshot.name + (state.binding ? '　已绑定：' + state.binding.label : '　尚未绑定作者旧版') : '尚未读取当前预设';
  }
  function offlinePicker(target) {
    target.append(fileInput('读取我当前修改版的预设 JSON（进入离线对比）', async (file, text) => {
      const raw = core.parse(text, file.name);
      state.offline = true; state.snapshot = { name: file.name.replace(/\.json$/i, ''), raw, saved: core.copy(raw), names: [] };
      await refreshCurrent(); render(); showNote('已进入离线对比，只能导出合并文件。回到酒馆读取当前预设后，才可原位更新。');
    }, '选择从酒馆导出的、包含你缝合条目的当前预设。'));
  }
  function renderBind() {
    panel.append(msg('先在酒馆里选中你正在使用的缝合预设，再选择它当时对应的作者旧版。绑定只记住来源，不改动预设。'));
    if (!state.snapshot || state.offline) offlinePicker(panel);
    panel.append(fileInput(state.oldFile ? '作者旧版：' + state.oldFile.name : '选择作者旧版 JSON', async (file, text) => {
      if (!state.snapshot) throw Error('请先读取当前预设，或选择当前修改版文件。');
      state.oldFile = { name: file.name, raw: core.parse(text, file.name) };
      const info = core.identify(state.oldFile.raw, state.snapshot.raw);
      state.bindMap = initialMap(info); render();
    }, '应当是你开始缝合时的作者原版，不要在这里选新版。'));
    if (!state.oldFile || !state.snapshot) return;
    const base = state.oldFile.raw, local = state.snapshot.raw, info = core.identify(base, local);
    if (!state.bindMap) state.bindMap = initialMap(info);
    panel.append(mappingView('作者旧版 → 我当前的条目', base, local, state.bindMap, info));
    panel.append(details('查看将保留为自定义条目的内容', d => {
      const assigned = new Set(Object.values(state.bindMap));
      const custom = local.prompts.filter(p => !assigned.has(p.identifier));
      if (!custom.length) d.append(msg('没有额外条目。'));
      for (const p of custom) d.append(details(p.name, x => x.append(el('pre', JSON.stringify(p, null, 2)))));
    }));
    const label = el('label', null, 'check'), check = el('input'); check.type = 'checkbox';
    label.append(check, el('span', '我确认这份作者旧版就是当前缝合预设的来源，并已核对上面的对应关系。')); panel.append(label);
    panel.append(btn(state.binding ? '重新绑定作者旧版' : '保存首次绑定', async () => {
      if (!check.checked) throw Error('请先确认旧版来源和条目对应关系。');
      const map = resolved(base, local, state.bindMap);
      const binding = core.makeBinding(state.snapshot.name, base, local, map, state.oldFile.name);
      if (state.binding && !await confirmAction('重新绑定作者基准', '将改为以这份作者旧版进行后续对比。当前预设正文保持现状，原绑定会备份。', '备份并重新绑定')) return;
      if (!storageError) {
        await store.withLock(async () => {
          await ensureNoPending(state.snapshot.name);
          if (!state.offline) {
            const fresh = await adapter.read();
            if (fresh.name !== state.snapshot.name || !core.equal(fresh.raw, state.snapshot.raw)) throw Error('当前预设已变化，请重新读取后绑定。');
          }
          const oldBinding = (await store.getBinding(binding.name)) || null;
          if (!core.equal(oldBinding, state.binding)) throw Error('绑定在另一个窗口发生变化，请重新读取。');
          const record = { id: core.uuid(host.crypto), name: binding.name, at: new Date().toISOString(), reason: state.binding ? '重新绑定' : '首次绑定',
            status: 'verified', before: core.copy(local), diskBefore: core.copy(state.snapshot.saved), intended: core.copy(local), beforeBinding: oldBinding, nextBinding: binding };
          await store.finish(record, binding);
        });
      } else await store.putBinding(binding);
      state.binding = binding; state.tab = 'update'; state.plan = null; render();
      showNote(storageError ? '已临时绑定。本次只能离线对比导出，关闭后需重新绑定。' : '绑定好了。下次选择作者新版即可做三方对比。');
    }, 'primary'));
  }
  function setupUpdateMaps() {
    const b = state.binding.base, l = state.snapshot.raw, r = state.newFile.raw;
    if (!state.localMap) state.localMap = initialMap(core.identify(b, l, state.binding.authorMap));
    if (!state.remoteMap) state.remoteMap = initialMap(core.identify(b, r));
  }
  function renderUpdate() {
    if (!state.snapshot) { panel.append(msg('读取当前预设后开始。')); offlinePicker(panel); return; }
    if (!state.binding) { panel.append(msg('首次使用需要绑定作者旧版，才能分清哪些是你自己的条目。')); panel.append(btn('去首次绑定', async () => { state.tab = 'bind'; render(); }, 'primary')); return; }
    panel.append(msg('对照作者旧版、你当前的版本、作者新版。你的自定义条目完整保留，现有开关默认保留。支持的折叠分组会一并对比，并提供分组预览。连接配置保持当前；其他扩展内容单独确认。'));
    panel.append(fileInput(state.newFile ? '作者新版：' + state.newFile.name : '选择作者新版 JSON', async (file, text) => {
      state.newFile = { name: file.name, raw: core.parse(text, file.name) }; state.localMap = null; state.remoteMap = null;
      state.plan = null; state.choices = {}; state.reviewed = false; state.massReviewed = false; render();
    }));
    if (!state.newFile) return;
    setupUpdateMaps();
    const b = state.binding.base, l = state.snapshot.raw, r = state.newFile.raw;
    panel.append(mappingView('核对我当前的条目', b, l, state.localMap, core.identify(b, l, state.binding.authorMap)));
    panel.append(mappingView('核对作者新版的条目', b, r, state.remoteMap, core.identify(b, r), '作者新版'));
    const lowMatch = Object.values(state.remoteMap).filter(x => typeof x === 'string').length < b.prompts.length * .4;
    if (lowMatch) {
      panel.append(msg('新版与作者旧版能对应的条目少于 40%。这可能是大幅改版，也可能选错了文件；请特别核对新增和删除的内容。', 'warn'));
      const mass = el('label', null, 'check'), mc = el('input'); mc.type = 'checkbox'; mc.checked = state.massReviewed;
      mc.addEventListener('change', () => { state.massReviewed = mc.checked; });
      mass.append(mc, el('span', '我确认这是同一预设的作者新版，并接受这次大幅变更。')); panel.append(mass);
    }
    const toggle = el('label', null, 'check'), check = el('input'); check.type = 'checkbox'; check.checked = state.followEnabled;
    toggle.append(check, el('span', '让作者更新现有条目的默认开关（通常保持不勾选）'));
    check.addEventListener('change', () => { state.followEnabled = check.checked; state.plan = null; state.choices = {}; }); panel.append(toggle);
    panel.append(btn('生成三方合并预览', async () => {
      resolved(b, l, state.localMap); resolved(b, r, state.remoteMap);
      if (lowMatch && !state.massReviewed) throw Error('请先核对并确认新版来源；当前对应比例较低。');
      if (!state.offline) {
        const fresh = await adapter.read();
        if (fresh.name !== state.snapshot.name || !core.equal(fresh.raw, state.snapshot.raw) || !core.equal(fresh.saved, state.snapshot.saved)) {
          await refreshCurrent(); state.bindMap = null; render(); throw Error('读取后你又调整了预设，已刷新当前数据。请核对对应关系后重新生成预览。');
        }
      }
      state.plan = core.merge({ binding: state.binding, local: l, remote: r, localMap: state.localMap, remoteMap: state.remoteMap,
        choices: state.choices, followAuthorEnabled: state.followEnabled });
      state.reviewed = false; render(); showNote('预览已生成，酒馆里的预设还没有改变。');
    }, 'primary'));
    if (state.plan) renderPlan();
  }
  function renderPlan() {
    const plan = state.plan, wrap = el('section', null, 'plan'); wrap.append(el('h2', '合并预览'));
    const labels = { added: '作者新增', modified: '作者修改', deleted: '作者删除', custom: '我的条目', grouping: '折叠分组变化', setting: '参数变化', extension: '扩展变化', connection: '保留连接配置' };
    const chips = el('div', null, 'chips');
    for (const [kind, label] of Object.entries(labels)) {
      const count = plan.changes.filter(x => x.kind === kind).length;
      if (count || ['added', 'modified', 'deleted', 'custom'].includes(kind)) chips.append(el('span', label + ' ' + count, 'chip ' + kind));
    } wrap.append(chips);
    const decisions = el('div'); wrap.append(decisions);
    const decisionStatus = el('p', null, 'decision-status'); decisions.append(decisionStatus);
    const paintDecisionStatus = () => { decisionStatus.textContent = state.plan.unresolved ? '还有 ' + state.plan.unresolved + ' 项冲突需要选择。' : '必选冲突已处理。可以继续核对变化和最终顺序。'; };
    paintDecisionStatus();
    for (const c of plan.conflicts) {
      const card = el('section', null, 'decision'), select = el('select'); select.setAttribute('aria-label', c.title);
      const empty = el('option', '请选择如何处理'); empty.value = ''; select.append(empty);
      for (const o of c.options) { const option = el('option', o.label); option.value = o.value; select.append(option); }
      select.value = c.choice;
      select.addEventListener('change', () => {
        state.choices[c.key] = select.value; state.reviewed = false;
        try {
          state.plan = core.merge({ binding: state.binding, local: state.snapshot.raw, remote: state.newFile.raw, localMap: state.localMap,
            remoteMap: state.remoteMap, choices: state.choices, followAuthorEnabled: state.followEnabled });
          // A group-format or correspondence choice can reveal further conflicts.
          // Rebuild all decisions as well as the result, retaining the panel position.
          const scroll = panel.scrollTop; wrap.remove(); renderPlan(); panel.scrollTop = scroll;
        } catch (e) { state.plan = null; showNote(e.message, true); }
      });
      card.append(el('strong', c.title), select, details('展开三方原文', d => diff(d, [c.base, c.local, c.remote]))); decisions.append(card);
    }
    for (const [kind, label] of Object.entries(labels)) {
      const items = plan.changes.filter(x => x.kind === kind); if (!items.length) continue;
      wrap.append(details(label + ' · ' + items.length + ' 项', d => {
        for (const x of items) d.append(details(x.name + (x.rekeyed ? '（编号变化，已对应）' : ''), q => diff(q, [x.base, x.local, x.remote])));
      }));
    }
    for (const n of plan.notices) wrap.append(msg(n, 'warn'));
    function makeResultBox() {
      const d = el('div');
      if (state.plan?.foldingGroups) d.append(details('查看合并后的折叠分组（大条码）', target => {
        const plan = state.plan; if (!plan) return;
        const names = new Map(plan.output.prompts.map(p => [p.identifier, p.name]));
        const item = id => el('li', names.get(id) + (plan.customIds.includes(id) ? ' · 我的条目' : ''));
        target.append(msg('以下按主要条目列表显示分组归属。组内条目依照合并后的列表顺序排列；分组总开关单独保留。其他列表及未使用条目的已有分组记录也会保留。'));
        for (const g of plan.foldingGroups.groups) {
          target.append(el('h3', g.name + ' · ' + g.identifiers.length + ' 条 · 总开关' + (g.enabled === false ? '关闭' : '开启')));
          const list = el('ol'); for (const id of g.identifiers) list.append(item(id)); target.append(list);
        }
        target.append(el('h3', '分组外的独立条目 · ' + plan.foldingGroups.ungrouped.length + ' 条'));
        const list = el('ol'); for (const id of plan.foldingGroups.ungrouped) list.append(item(id)); target.append(list);
      }));
      d.append(details('查看合并后的实际顺序与开关', target => {
        if (!state.plan) { target.append(msg('对应关系或选项发生变化，请重新生成预览。')); return; }
        const names = new Map(state.plan.output.prompts.map(p => [p.identifier, p.name]));
        for (const g of state.plan.output.prompt_order) {
          target.append(el('h3', '顺序组 ' + g.character_id));
          const list = el('ol');
          for (const row of g.order) list.append(el('li', (row.enabled === false ? '○ ' : '● ') + names.get(row.identifier) + (state.plan.customIds.includes(row.identifier) ? ' · 我的条目' : '')));
          target.append(list);
        }
      })); d.dataset.result = '1'; return d;
    }
    wrap.append(makeResultBox());
    const review = el('label', null, 'check'), reviewCheck = el('input'); reviewCheck.type = 'checkbox';
    reviewCheck.addEventListener('change', () => { state.reviewed = reviewCheck.checked; });
    review.append(reviewCheck, el('span', '我已核对作者的新增、删除、对应关系和上面的处理选项。')); wrap.append(review);
    const actions = el('div', null, 'actions');
    actions.append(btn('导出合并预设', async () => {
      if (!state.plan || state.plan.unresolved) throw Error('请先处理全部冲突，再导出。');
      download(state.snapshot.name + '.json', state.plan.output);
    }));
    const apply = btn('备份并原位更新', async () => {
      if (storageError || state.offline || interfaceError) throw Error('当前处于离线或受限模式，只能导出合并文件。');
      if (!state.plan || state.plan.unresolved || !state.reviewed) throw Error('请处理全部冲突，并勾选已核对。');
      const p = state.plan, n = p.changes.filter(x => x.kind === 'deleted').length;
      if (!await confirmAction('原位更新现有预设', '目标：' + state.snapshot.name + '\n作者新版：' + state.newFile.name + '\n作者报告删除 ' + n + ' 条；你的 ' + p.customIds.length + ' 条自定义条目将保留。\n会先自动备份，再保存到这个已有名称。', '确认备份并更新')) return;
      const binding = { ...core.copy(state.binding), base: core.copy(state.newFile.raw), authorMap: core.copy(p.nextMap), label: state.newFile.name, updatedAt: new Date().toISOString() };
      await store.withLock(async () => {
        await ensureNoPending(state.snapshot.name);
        await adapter.commit({ expected: state.snapshot, raw: p.output, binding, beforeBinding: state.binding, store });
      });
      state.newFile = null; await refreshCurrent(); render(); showNote('已原位更新「' + state.snapshot.name + '」，并核对了后端保存结果。更新前备份可在“备份恢复”中查看。');
    }, 'primary');
    apply.disabled = !!storageError || state.offline || !!interfaceError; actions.append(apply); wrap.append(actions); panel.append(wrap);
  }
  async function restore(record) {
    if (storageError || state.offline || interfaceError) throw Error('恢复需要在酒馆里读取当前预设，并确保备份数据库可用。');
    const current = await adapter.read();
    if (current.name !== record.name) throw Error('请先在酒馆选中「' + record.name + '」，再恢复。不会创建新的预设。');
    core.validate(record.before, '备份');
    const beforeBinding = (await store.getBinding(record.name)) || null;
    if (!await confirmAction('恢复备份', '将「' + record.name + '」恢复到 ' + new Date(record.at).toLocaleString('zh-CN') + ' 更新前的完整状态，包括顺序、开关和当时的作者基准。\n恢复前的现状也会先备份，可以再恢复回来。', '备份现状并恢复')) return;
    await store.withLock(async () => {
      await adapter.commit({ expected: current, raw: record.before, binding: record.beforeBinding || null, beforeBinding, store, reason: '恢复备份' });
      // A manual restore resolves earlier interrupted records for this exact target.
      for (const old of await store.backups(record.name)) if (['prepared', 'uncertain'].includes(old.status)) {
        old.status = 'resolved-by-restore'; await store.putBackup(old);
      }
    });
    await refreshCurrent(); state.backups = await store.backups(); render(); showNote('已恢复「' + record.name + '」；恢复之前的版本也已备份。');
  }
  function renderBackups() {
    panel.append(msg('备份包含完整原始预设和当时的作者基准。保留在当前酒馆的数据空间内；清除应用数据或换设备前，请导出完整恢复包。备份不会自动删除。'));
    panel.append(btn('刷新备份列表', async () => { state.backups = await store.backups(); render(); }));
    panel.append(fileInput('从文件打开完整恢复包', async (file, text) => {
      let data; try { data = JSON.parse(text); } catch { throw Error('恢复包不是有效 JSON。'); }
      core.assertSafe(data);
      if (data?.format !== 'preset-smart-updater-backup' || data.version !== 1 || !data.record || typeof data.record.name !== 'string' || typeof data.record.at !== 'string') throw Error('这不是本更新器导出的完整恢复包。');
      core.validate(data.record.before, '恢复包');
      if (data.record.beforeBinding) {
        const b = data.record.beforeBinding; core.validate(b.base, '恢复包作者基准');
        if (!b.authorMap || typeof b.authorMap !== 'object' || Array.isArray(b.authorMap) || b.schema !== 1
          || b.base.prompts.some(p => !Object.prototype.hasOwnProperty.call(b.authorMap, p.identifier) || !(b.authorMap[p.identifier] === null || typeof b.authorMap[p.identifier] === 'string'))) throw Error('恢复包的作者对应关系无效。');
        if (b.name !== data.record.name) throw Error('恢复包的预设名称与作者基准不一致。');
      }
      await restore(data.record);
    }));
    if (!state.backups.length) panel.append(msg('还没有备份记录。首次绑定和每次更新、恢复前都会建立备份。'));
    for (const record of state.backups.slice(0, state.backupLimit)) {
      const card = el('section', null, 'backup');
      card.append(el('strong', record.name), msg(new Date(record.at).toLocaleString('zh-CN') + ' · ' + record.reason + ' · ' + ({ verified: '已校验', prepared: '尚未核对', uncertain: '保存结果待核对', cancelled: '写入前已取消', 'resolved-by-restore': '已通过恢复处理' }[record.status] || record.status)));
      const actions = el('div', null, 'actions');
      actions.append(btn('恢复这一版', () => restore(record)), btn('导出完整恢复包', async () => download(record.name + '-恢复包-' + record.at.replace(/[:.]/g, '-') + '.json', { format: 'preset-smart-updater-backup', version: 1, record })),
        btn('导出备份预设', async () => download(record.name + '.json', record.before)));
      if (['prepared', 'uncertain'].includes(record.status)) actions.append(btn('核对保存结果', async () => {
        if (state.offline || storageError) throw Error('请先读取酒馆里的当前预设。');
        await store.withLock(async () => {
          const disk = await adapter.disk(record.name);
          if (core.equal(disk, record.intended)) { record.status = 'verified'; await store.finish(record, record.nextBinding || null); showNote('保存结果与预期一致，已恢复对应作者基准。请重新选中目标预设或刷新酒馆。'); }
          else if (core.equal(disk, record.diskBefore)) { record.status = 'cancelled'; await store.putBackup(record); showNote('磁盘仍是更新前的版本，本次写入已标记为取消。'); }
          else throw Error('磁盘内容与更新前、预期结果都不同。请核对其他窗口的修改；可导出备份后选择恢复，不会自动覆盖。');
        });
        state.backups = await store.backups(); render();
      }));
      card.append(actions); panel.append(card);
    }
    if (state.backups.length > state.backupLimit) panel.append(btn('显示更早的备份', async () => { state.backupLimit += 30; render(); }));
  }
  function renderHelp() {
    const text = [
      ['第一次使用', '把本脚本导入“酒馆助手 → 脚本库 → 全局脚本”，启用后点击“预设更新器”。先选中正在使用的缝合预设，绑定它对应的作者旧版。'],
      ['以后更新', '选中同一个预设，选择作者新版，生成预览，处理冲突并确认后原位更新。成功后会把作者新版记为下一次的基准。'],
      ['条目识别', '优先编号；编号变化时，仅唯一且名称、正文、角色和类型完全相同的条目可自动对应。仅名称相同不会自动覆盖；在对应关系中手动核对。'],
      ['自定义条目', '不属于作者基准的本地条目完整保留，包括未加入顺序列表的条目。顺序尽量跟随原来的前一条作者条目；前一条消失时找下一条。锚点都消失时仅保证自定义条目之间的顺序。'],
      ['开关与参数', '默认保留现有条目的启用开关。其他字段按三方对比合并；双方修改同一字段时必须选择。连接、模型和地址保持当前设置。'],
      ['正则与脚本', '扩展数据默认保留当前。可逐项确认采用作者整项扩展；这会替换该扩展项，包括它自己的自定义内容。脚本不会在对比阶段执行，采用扩展并加载预设后会按酒馆规则运行。'],
      ['备份与撤销', '每次写入前先提交完整备份，写入后从后端读取校验。恢复也会先备份现状，因此可以再恢复回来。数据库失败或未完成记录尚未核对时，停止原位更新。'],
      ['兼容边界', '支持含 prompts / prompt_order 的原始 Chat Completion 预设。扩展版可独立运行，JSON 脚本版使用酒馆助手脚本库；两者均检查实际预设接口。Text Completion、世界书和角色卡不在此版范围。缺少可靠接口时只能离线对比导出。'],
      ['同时编辑', '更新器窗口之间有互斥锁，且保存前检查当前选择、未保存设置和磁盘内容。酒馆保存接口没有原子版本锁；请勿在保存过程中从另一台设备、原生编辑器或同步程序修改同一预设。'],
      ['未保存编辑', '当前界面已经提交到设置中的改动会纳入合并和备份。条目编辑弹窗中还没按“保存”的文字无法读取；请先保存编辑弹窗，再打开更新器。'],
      ['改名与换设备', '绑定按酒馆现有预设名称保存。手动给预设改名后需重新绑定。换设备或清除应用数据前导出完整恢复包；离线导出的合并文件不会自动推进原位更新的作者基准。'],
      ['隐私', '比较和备份在酒馆本地完成，不调用模型 API，不上传预设内容，也不加载远程脚本。'],
    ];
    for (const [title, body] of text) { panel.append(el('h3', title), msg(body)); }
    panel.append(msg('酒馆预设智能更新器 v' + VERSION + ' · 支持对应关系关键词搜索、柏宝箱及兼容 entryGrouping 折叠分组合并。可展开分组预览核对新增条目归属。运行前仍会检查实际可用接口。'));
  }
  function render() {
    if (!panel) return;
    panel.replaceChildren();
    for (const b of root.querySelectorAll('nav button')) b.classList.toggle('active', b.dataset.tab === state.tab);
    if (storageError) panel.append(msg('备份数据库不可用：' + storageError + '。原位写入已停用。', 'warn'));
    if (interfaceError && !state.offline) panel.append(msg(interfaceError + '。可用离线文件对比。', 'warn'));
    if (state.offline) panel.append(msg('离线对比模式：可以预览、导出；原位写入已停用。', 'warn'));
    if (state.tab === 'bind') renderBind(); else if (state.tab === 'backups') renderBackups(); else if (state.tab === 'help') renderHelp(); else renderUpdate();
    updateStatus();
  }
  async function open() {
    if (dialog?.isConnected) { if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal(); dialog.focus(); return; }
    dialog = el('dialog'); dialog.setAttribute('aria-label', '酒馆预设智能更新器');
    dialog.style.cssText = 'padding:0;border:1px solid #52616d;border-radius:18px;background:#111a24;color:#e8eef4;width:min(960px,96vw);max-width:96vw;height:min(880px,92dvh);max-height:92dvh;overflow:hidden;box-shadow:0 24px 100px #000b;';
    // <dialog> is not a valid shadow host in the DOM standard. Its child <div> is.
    const surface = el('div'); surface.dataset.presetUpdaterSurface = VERSION;
    surface.style.cssText = 'display:block;position:relative;width:100%;height:100%;min-height:0;overflow:hidden;';
    dialog.append(surface);
    root = surface.attachShadow({ mode: 'open' });
    const style = el('style'); style.textContent = `
      :host{color-scheme:dark;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-sizing:border-box}*{box-sizing:border-box}h1{font-size:21px;margin:0}h2{font-size:19px;margin:22px 0 12px}h3{font-size:16px;margin:16px 0 8px}p{margin:8px 0 14px;white-space:pre-wrap}button,input,select{font:inherit}button{border:1px solid #475b6b;background:#253544;color:#edf4fc;border-radius:9px;padding:9px 14px;cursor:pointer;line-height:1.35}button:hover{background:#344b60}button:disabled{opacity:.4;cursor:not-allowed}.primary{background:#b9daca;color:#122d25;border-color:#b9daca;font-weight:650}.primary:hover{background:#d7eee3}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid #c9e0ba;outline-offset:3px}.shell{height:100%;display:flex;flex-direction:column;min-height:0}.head{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;padding:19px 22px 10px}.status{font-size:12px;color:#b1c6d8;overflow-wrap:anywhere}.toolbar{display:flex;gap:8px;padding:0 22px 10px;flex-wrap:wrap}.toolbar button{font-size:12px;padding:7px 10px}nav{display:flex;gap:4px;padding:0 17px;border-bottom:1px solid #354859}nav button{border:0;background:transparent;border-radius:8px 8px 0 0;color:#bacbda;font-size:14px;padding:12px}nav button.active{background:#243744;color:#cce6d2;box-shadow:inset 0 -2px #b8dbc6}.panel{overflow-y:auto;overscroll-behavior:contain;padding:16px 22px 30px;flex:1;min-height:0}.muted,small{color:#b9c9d6}.warn{color:#ffdb9a;background:#423522;padding:12px;border-radius:9px}.note{padding:10px 22px;background:#263e35;color:#d2ecdc;font-size:13px;white-space:pre-wrap;max-height:130px;overflow:auto;flex:none}.error{background:#4d2a32;color:#ffdae2}.file{display:block;border:1px dashed #5d788c;padding:15px;border-radius:12px;background:#1a2a38;margin:12px 0}.file-title{display:block;font-weight:650;overflow-wrap:anywhere}.file small{display:block;margin:5px 0}.file input{display:block;width:100%;font-size:13px;margin-top:12px}.mapping{border-top:1px solid #354859;margin-top:20px;padding-top:4px}.map-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:12px;align-items:center;padding:9px 0;border-bottom:1px solid #263744}.map-row span{overflow-wrap:anywhere}select{width:100%;min-width:0;background:#192b3a;color:#e9f1fa;border:1px solid #577084;border-radius:8px;padding:8px;font-size:14px}.check{display:flex;gap:10px;align-items:flex-start;padding:12px 0;margin:7px 0}.check input{margin-top:5px;flex:none;width:17px;height:17px;accent-color:#b9daca}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}details{border:1px solid #344b5e;border-radius:10px;margin:10px 0;padding:0 12px}summary{cursor:pointer;padding:11px 0;overflow-wrap:anywhere}details>details{margin:8px 0}pre{white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:360px;font:12px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;background:#0d1620;padding:12px;border-radius:8px;tab-size:2}.diff{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding-bottom:10px}.diff strong{font-size:12px;color:#bdcfdf}.diff section{min-width:0}.chips{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}.chip{padding:5px 10px;border-radius:20px;font-size:12px;background:#243c50}.chip.deleted{background:#50323b;color:#ffe0e4}.chip.custom{background:#264239;color:#c5ecd7}.decision,.backup{padding:14px;border:1px solid #4d6475;border-radius:12px;margin:12px 0}.decision>strong{display:block;margin-bottom:9px}.decision-status{color:#e1ddb7}.confirm-shade{position:absolute;inset:0;z-index:4;background:#000b;display:grid;place-items:center;padding:20px}.confirm-card{background:#1d2c3b;border:1px solid #779185;border-radius:16px;padding:22px;width:min(540px,100%);max-height:85dvh;overflow:auto}.confirm-text{white-space:pre-wrap}.busy-mask{position:absolute;inset:0;z-index:3;background:#111a2422;cursor:wait}.busy-mask[hidden],.note[hidden]{display:none}ol{padding-left:26px}li{padding:3px 0;overflow-wrap:anywhere}@media(max-width:600px){:host{font-size:14px}.head{padding:15px 14px 8px}.toolbar{padding-left:14px}.panel{padding:12px 14px 24px}.map-row{grid-template-columns:1fr;gap:5px}.diff{grid-template-columns:1fr}.diff pre{max-height:240px}nav{padding:0 7px}nav button{font-size:13px;padding:10px}.note{padding:10px 14px}.confirm-card{padding:17px}button{padding:9px 11px}}`;
    style.textContent += `
      .map-source-search{display:flex;flex-direction:column;gap:6px;margin:12px 0 6px}.map-source-search>span{font-size:13px;color:#bdcfdf}.map-search-field{display:block;width:100%;min-width:0;min-height:42px;font:inherit;font-size:16px;line-height:1.4;padding:9px 11px;border:1px solid #5d788c;border-radius:8px;background:#132433;color:#e9f1fa;box-sizing:border-box}.map-search-field::placeholder{color:#94adbe}.map-controls{min-width:0;display:grid;gap:7px}.map-source{min-width:0;display:grid;gap:3px}.map-source small,.map-controls>small{font-size:12px;color:#b0c4d5}.map-source-count{font-size:12px;color:#b0c4d5}.map-source-count[hidden],.map-candidate-count[hidden]{display:none}.map-primary-rows{min-width:0}
    `;
    const shell = el('div', null, 'shell'), head = el('header', null, 'head'), title = el('div');
    title.append(el('h1', '酒馆预设智能更新器')); status = el('div', '', 'status'); title.append(status);
    const closeBtn = el('button', '关闭'); closeBtn.addEventListener('click', close); head.append(title, closeBtn); shell.append(head);
    const toolbar = el('div', null, 'toolbar');
    toolbar.append(btn('重新读取当前预设', async () => {
      state.offline = false; interfaceError = ''; state.oldFile = null; state.newFile = null; state.bindMap = null;
      try { await refreshCurrent(); } catch (e) { interfaceError = e.message; state.snapshot = null; state.binding = null; }
      render(); if (interfaceError) throw Error(interfaceError); showNote('已重新读取当前预设。');
    })); shell.append(toolbar);
    const nav = el('nav');
    for (const [tab, name] of [['update', '更新预设'], ['bind', '首次绑定'], ['backups', '备份恢复'], ['help', '说明']]) {
      const b = btn(name, async () => { state.tab = tab; if (tab === 'backups') state.backups = await store.backups(); render(); }); b.dataset.tab = tab; nav.append(b);
    } shell.append(nav);
    note = el('div', '', 'note'); note.hidden = true; shell.append(note); panel = el('main', null, 'panel'); shell.append(panel);
    busyMask = el('div', null, 'busy-mask'); busyMask.hidden = true; root.append(style, shell, busyMask); doc.body.append(dialog);
    dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); dialog.style.position = 'fixed'; dialog.style.inset = '3vh auto auto 2vw'; dialog.style.zIndex = '2147483640'; }
    render();
    if (!state.snapshot || !state.offline) await run(async () => {
      showNote('正在读取当前预设并检查备份功能…');
      await initialize();
      if (disposed) return;
      try { await refreshCurrent(); } catch (e) { interfaceError = e.message; state.snapshot = null; state.binding = null; }
      render();
      showNote(interfaceError ? interfaceError + '。原位写入已停用，可选择离线文件对比。' : storageError ? storageError + '。可以离线对比导出。' : '', !!interfaceError || !!storageError);
    });
  }
  async function safeOpen() {
    try { await open(); }
    catch (e) {
      const text = '预设更新器无法打开：' + (e?.message || String(e));
      console.error('[预设更新器]', e);
      // Errors before DOM creation cannot use the dialog's internal note area.
      if (dialog?.isConnected && note) showNote(text, true);
      else {
        dialog?.remove(); dialog = null;
        const toast = host.toastr || window.toastr;
        if (typeof toast?.error === 'function') toast.error(text, '预设更新器');
        else host.alert(text);
      }
    }
  }
  let disposed = false;
  const cleanup = () => { if (disposed) return; disposed = true; if (dialog) dialog.remove(); detachButton?.(); store?.close?.(); if (host[SINGLETON]?.open === safeOpen) delete host[SINGLETON]; };
  const instance = { version: VERSION, mode, open: safeOpen, close, dispose: cleanup, get busy() { return state.busy; } };
  host[SINGLETON] = instance;
  window.addEventListener('pagehide', cleanup, { once: true });
  window.addEventListener('unload', cleanup, { once: true });
  // Register immediately: slow imports or WKWebView IndexedDB must not swallow clicks.
  detachButton = registerButton(safeOpen);
  // Run only when requested: enabling the global script does not pop up a window or write presets.
  return instance;
}



// The installable extension runs in the host page and does not need TavernHelper.
async function startNativeUpdater(host = window) {
  const doc = host.document, ID = 'preset-smart-updater-native-controls';
  const runtime = {
    host, mode: 'extension',
    registerButton(open) {
      if (doc.getElementById(ID)) return () => {};
      const section = doc.createElement('section'); section.id = ID;
      section.style.cssText = 'padding:10px 0;display:flex;flex-direction:column;gap:8px;';
      const title = doc.createElement('strong'); title.textContent = '酒馆预设智能更新器';
      const button = doc.createElement('button'); button.type = 'button';
      button.className = 'menu_button menu_button_icon'; button.textContent = '打开预设更新器';
      button.style.cssText = 'width:100%;margin:0;justify-content:center;min-height:38px;';
      button.addEventListener('click', open);
      const note = doc.createElement('small'); note.textContent = '选择作者新版，保留缝合条目，核对后备份并原位更新。';
      section.append(title, button, note);
      let observer, timer;
      const mount = () => {
        const target = doc.getElementById('extensions_settings') || doc.getElementById('extensions_settings2');
        if (!target) return false;
        if (!doc.getElementById(ID)) target.prepend(section);
        observer?.disconnect(); host.clearTimeout(timer); return true;
      };
      if (!mount()) {
        observer = new host.MutationObserver(mount);
        observer.observe(doc.documentElement, { childList: true, subtree: true });
        timer = host.setTimeout(() => {
          observer.disconnect();
          if (!mount()) {
            const message = '预设更新器未找到扩展面板入口，请等待酒馆加载完成后刷新。';
            host.console.error('[预设更新器]', message); host.toastr?.error?.(message);
          }
        }, 15000);
      }
      return () => { observer?.disconnect(); host.clearTimeout(timer); button.removeEventListener('click', open); section.remove(); };
    },
  };
  return startUpdater(runtime);
}

startNativeUpdater().catch(e => { console.error("[预设更新器]", e); window.toastr?.error?.(e.message || String(e), "预设更新器未启动"); });
})();
