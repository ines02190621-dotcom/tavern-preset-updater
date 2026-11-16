import { startUpdater } from './ui.mjs';

// The installable extension runs in the host page and does not need TavernHelper.
export async function startNativeUpdater(host = window) {
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
