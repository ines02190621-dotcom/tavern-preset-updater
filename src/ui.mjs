export async function startUpdater() {
  const core = createUpdaterCore();
  let host = window.parent;
  try { void host.document.body; } catch { host = window; }
  const SINGLETON = '__presetSmartUpdaterV1';
  const VERSION = '1.0.3';
  if (host[SINGLETON]?.version === VERSION) {
    eventOn(getButtonEvent('预设更新器'), host[SINGLETON].open);
    return;
  }
  // A failed v1.0.0 open could leave a detached dialog referenced by its singleton.
  try { host[SINGLETON]?.dispose?.(); host[SINGLETON]?.close?.(); } catch { /* Replace the stale UI instance below. */ }
  const doc = host.document;
  const context = () => host.SillyTavern?.getContext?.() || (typeof SillyTavern !== 'undefined' ? SillyTavern : null);
  let openai, adapter, store, initialization, interfaceError = '', storageError = '';
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
        if (typeof getVariables !== 'function' || typeof insertOrAssignVariables !== 'function') throw Error('酒馆助手缺少全局变量接口。');
        const key = '__preset_smart_updater_scope_v1';
        let scope = getVariables({ type: 'global' })[key];
        if (typeof scope !== 'string' || !/^[a-zA-Z0-9-]{10,80}$/.test(scope)) {
          scope = core.uuid(host.crypto);
          insertOrAssignVariables({ [key]: scope }, { type: 'global' });
        }
        store = await bounded(createUpdaterStore({ host, scope, core }), 8000, '备份数据库打开超时，原位写入已停用', value => value.close());
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
      ['兼容边界', '支持含 prompts / prompt_order 的原始 Chat Completion 预设。需要酒馆助手脚本库和两边共有的预设管理接口。Text Completion、世界书和角色卡不在此版范围。缺少可靠接口时只能离线对比导出。'],
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
  const cleanup = () => { if (disposed) return; disposed = true; if (dialog) dialog.remove(); store?.close?.(); if (host[SINGLETON]?.open === safeOpen) delete host[SINGLETON]; };
  host[SINGLETON] = { version: VERSION, open: safeOpen, close, dispose: cleanup };
  window.addEventListener('pagehide', cleanup, { once: true });
  window.addEventListener('unload', cleanup, { once: true });
  // Register immediately: slow imports or WKWebView IndexedDB must not swallow clicks.
  if (typeof eventOn === 'function' && typeof getButtonEvent === 'function') eventOn(getButtonEvent('预设更新器'), safeOpen);
  else throw Error('酒馆助手脚本按钮接口不可用，请更新酒馆助手。');
  // Run only when requested: enabling the global script does not pop up a window or write presets.
}
