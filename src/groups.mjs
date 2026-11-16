// Schema-aware folding groups for BaiBai Toolkit and its entryGrouping import format.
// Grouping is independent from ST's prompt_order character_id lists.
export function createPresetGrouping({ base, local, remote, localMap, remoteMap, decision, mergeValue, copy, equal, weave, notices }) {
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
