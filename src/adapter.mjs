export function createHostAdapter({ host, context, openai, core }) {
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
