import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createUpdaterCore } from '../src/core.mjs';
let playwright;
try { playwright = createRequire(import.meta.url)('playwright'); }
catch { playwright = createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + '/loader.cjs')('playwright'); }
const { chromium } = playwright;
const core = createUpdaterCore();
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
const script = JSON.parse(fs.readFileSync(new URL('../dist/酒馆预设智能更新器-v' + version + '.json', import.meta.url)));
const make = () => ({ temperature: 1, custom_url: 'http://mine.invalid', prompts: [
  { identifier: 'a', name: '作者正文', role: 'system', content: '作者旧版正文', system_prompt: false },
  { identifier: 'b', name: '作者规则', role: 'system', content: '规则', system_prompt: false },
], prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: true }] }], extensions: {} });
const old = make(), modified = make(), newer = make();
modified.prompts.push({ identifier: 'custom', name: '我缝进去的条目', role: 'user', content: '<img src=x onerror="parent.__injected=true">\n自定义正文', injection_depth: 6, extra: { flag: false } });
modified.prompt_order[0].order.splice(1, 0, { identifier: 'custom', enabled: false, unknown: 42 });
newer.prompts[0].content = '作者新版正文'; newer.prompts.push({ identifier: 'new', name: '作者新增', content: '新内容' }); newer.prompt_order[0].order.push({ identifier: 'new', enabled: false });
const sessions = new Map();
const moduleText = `export function getChatCompletionPreset(){ if(window!==window.top) throw Error('wrong module realm'); return structuredClone(window.hostState.live); }
export function getPresetApplicationPromise(){return Promise.resolve();}`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    const id = crypto.randomUUID(), mode = url.searchParams.get('mode') || 'st';
    const disk = core.copy(modified); sessions.set(id, { disk, writes: [], mode });
    res.setHeader('Content-Type', 'text/html;charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated host harness</title><style>body{background:#101721;color:white;font-family:sans-serif}iframe{display:none}</style><p>隔离测试宿主（不是真实酒馆）</p><script>
window.hostState={id:${JSON.stringify(id)},mode:${JSON.stringify(mode)},live:${JSON.stringify(disk)},saved:${JSON.stringify(disk)},variables:{},events:{},saveNames:[]};
const manager={getSelectedPresetName:()=> '我的缝合预设',getSelectedPreset:()=> '0',getPresetList:()=>({presets:[hostState.saved],preset_names:{'我的缝合预设':0},settings:hostState.live}),
async savePreset(name,raw,options){const r=await fetch('/api/presets/save',{method:'POST',headers:ctx.getRequestHeaders(),body:JSON.stringify({name,apiId:'openai',preset:raw})});if(!r.ok)throw Error('save failed');await r.json();hostState.saveNames.push(name);},
updateList(name,raw){hostState.saved=structuredClone(raw);hostState.live=structuredClone(raw);}};
const ctx={mainApi:'openai',getPresetManager:()=>manager,getRequestHeaders:()=>({'Content-Type':'application/json','X-Test-Session':hostState.id})};
window.SillyTavern={getContext:()=>ctx};window.toastr={error:(m)=>{window.startError=m;console.error(m)}};
${mode === 'tt' ? `const nativeFetch=window.fetch;window.fetch=function(...args){window.hostFetchCalls=(window.hostFetchCalls||0)+1;return nativeFetch.apply(window,args);};` : ''}
</script><iframe src="/frame.html"></iframe>`); return;
  }
  if (url.pathname === '/frame.html') { res.setHeader('Content-Type', 'text/html'); res.end(`<script>window.getVariables=()=>parent.hostState.variables;window.insertOrAssignVariables=(v)=>Object.assign(parent.hostState.variables,v);window.getButtonEvent=n=>n;window.eventOn=(n,fn)=>{parent.hostState.events[n]=fn;};</script>`); return; }
  if (url.pathname === '/scripts/openai.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(moduleText); return; }
  const s = sessions.get(req.headers['x-test-session']); if (!s) { res.writeHead(404).end(); return; }
  if (url.pathname === '/api/settings/get') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ openai_setting_names: ['我的缝合预设'], openai_settings: [s.mode === 'st' ? JSON.stringify(s.disk) : s.disk] })); return; }
  if (url.pathname === '/api/presets/save') {
    let data = ''; for await (const chunk of req) data += chunk;
    const body = JSON.parse(data); assert.equal(body.apiId, 'openai'); assert.equal(body.name, '我的缝合预设'); s.disk = body.preset; s.writes.push(core.copy(body));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ name: body.name })); return;
  }
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const errors = [];
try {
  for (const mode of ['st', 'tt']) {
    const context = await browser.newContext({ viewport: mode === 'tt' ? { width: 390, height: 844 } : { width: 1200, height: 950 }, isMobile: mode === 'tt', deviceScaleFactor: 1 });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(mode + ': ' + e.message));
    await page.goto('http://127.0.0.1:' + port + '/?mode=' + mode);
    const frame = page.frames().find(f => f.url().endsWith('/frame.html')); await frame.waitForFunction(() => typeof window.eventOn === 'function');
    await frame.evaluate(content => window.eval(content), script.content);
    await page.waitForFunction(() => typeof window.hostState.events['预设更新器'] === 'function');
    await page.evaluate(() => { window.hostState.events['预设更新器'](); });
    const dlg = page.getByRole('dialog', { name: '酒馆预设智能更新器' }); await dlg.getByText('尚未绑定作者旧版').waitFor();
    await dlg.getByRole('button', { name: '去首次绑定' }).click();
    await dlg.locator('input[type=file]').setInputFiles({ name: '作者旧版.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
    await dlg.getByLabel('我确认这份作者旧版就是当前缝合预设的来源，并已核对上面的对应关系。').check();
    await dlg.getByRole('button', { name: '保存首次绑定', exact: true }).click();
    await dlg.getByText('绑定好了。下次选择作者新版即可做三方对比。').waitFor();
    const id = await page.evaluate(() => hostState.id); assert.equal(sessions.get(id).writes.length, 0, 'binding does not write a preset');
    await dlg.locator('input[type=file]').setInputFiles({ name: '作者新版.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(newer)) });
    await dlg.getByRole('button', { name: '生成三方合并预览' }).click();
    await dlg.getByRole('heading', { name: '合并预览' }).waitFor();
    await dlg.getByText('我的条目 1', { exact: true }).waitFor();
    await dlg.getByText('查看合并后的实际顺序与开关').click();
    await dlg.getByText('○ 我缝进去的条目 · 我的条目', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => !!window.__injected), false);
    await dlg.getByLabel('我已核对作者的新增、删除、对应关系和上面的处理选项。').check();
    await page.screenshot({ path: new URL('../research/ui-' + mode + '.png', import.meta.url).pathname, fullPage: true });
    const overflow = await dlg.evaluate(x => { const root=x.querySelector('[data-preset-updater-surface]').shadowRoot; return { panel: root.querySelector('.panel').scrollWidth > root.querySelector('.panel').clientWidth + 2, dialog: x.getBoundingClientRect().right > innerWidth + 2 }; });
    assert.deepEqual(overflow, { panel: false, dialog: false });
    await dlg.getByRole('button', { name: '备份并原位更新', exact: true }).click();
    await dlg.getByRole('button', { name: '确认备份并更新', exact: true }).click();
    await dlg.getByText(/已原位更新「我的缝合预设」/).waitFor();
    const s = sessions.get(id); assert.equal(s.writes.length, 1); assert.equal(s.disk.prompts.find(p => p.identifier === 'a').content, '作者新版正文');
    assert.deepEqual(s.disk.prompts.find(p => p.identifier === 'custom'), modified.prompts.find(p => p.identifier === 'custom'));
    assert.deepEqual(s.disk.prompt_order[0].order.find(p => p.identifier === 'custom'), modified.prompt_order[0].order.find(p => p.identifier === 'custom'));
    assert.deepEqual(await page.evaluate(() => hostState.saveNames), ['我的缝合预设']);
    if (mode === 'tt') assert.ok(await page.evaluate(() => hostFetchCalls > 0));
    await dlg.getByRole('button', { name: '备份恢复', exact: true }).click();
    const updatedBackup = dlg.locator('.backup').filter({ hasText: ' · 更新 · ' }).first();
    await updatedBackup.getByRole('button', { name: '恢复这一版' }).click();
    await dlg.getByRole('button', { name: '备份现状并恢复' }).click();
    await dlg.getByText('已恢复「我的缝合预设」；恢复之前的版本也已备份。').waitFor();
    assert.ok(core.equal(s.disk, modified), 'restore recovers exact full pre-update content');
    const restoreBackup = dlg.locator('.backup').filter({ hasText: ' · 恢复备份 · ' }).first();
    await restoreBackup.getByRole('button', { name: '恢复这一版' }).click();
    await dlg.getByRole('button', { name: '备份现状并恢复' }).click();
    await page.waitForFunction(() => hostState.saveNames.length === 3);
    assert.equal(s.disk.prompts.find(p => p.identifier === 'a').content, '作者新版正文', 'restore of restore returns to revision without an API call');
    await dlg.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => { window.hostState.events['预设更新器'](); });
    await dlg.getByRole('button', { name: '更新预设', exact: true }).click();
    await dlg.getByText(/已绑定：作者新版.json/).waitFor();
    console.log(mode + ': binding → preview → in-place update → restore → undo restore → reopen passed; no duplicate presets; mobile overflow check passed');
    await context.close();
  }
  assert.deepEqual(errors, []); console.log('Browser page errors: 0.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
