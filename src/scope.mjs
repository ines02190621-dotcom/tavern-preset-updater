// Shared per-user namespace for native extensions and TavernHelper scripts.
export async function resolveUpdaterScope({ core, context, mode, readLegacy, writeLegacy }) {
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
