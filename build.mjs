import fs from 'node:fs';
import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const part = n => fs.readFileSync(path.join(root, 'src', n + '.mjs'), 'utf8').replace(/^import .* from '\.\/[\w-]+\.mjs';\r?\n/gm, '').replace(/^export /gm, '');
const parts = ['scope', 'groups', 'core', 'adapter', 'storage', 'ui'].map(part);
const content = '(function () {\n"use strict";\n' + parts.join('\n\n') + '\nstartUpdater().catch(e => { console.error("[预设更新器]", e); const t = window.parent?.toastr || window.toastr; if (t) t.error(e.message || String(e), "预设更新器未启动"); });\n})();\n';
const script = {
  type: 'script', enabled: true, name: '酒馆预设智能更新器 v' + version, id: 'd2470acb-baa2-4c06-b65f-bd8738e2d910', content,
  info: '将本脚本导入酒馆助手的【全局脚本】并启用，点击【预设更新器】。首次绑定作者旧版与当前缝合版；后续选择作者新版进行三方合并。支持原始 Chat Completion 预设。自动备份后按原名称保存；保留自定义条目、开关、相对位置及支持的柏宝箱分组。v' + version + ' 同时提供可从 Git 仓库 URL 安装的原生扩展版；扩展面板中点击【打开预设更新器】，无需导入脚本。两版在同一浏览器、同一酒馆地址和用户下共用绑定和备份。请关闭旧版脚本并刷新后再使用扩展。沿用关键词搜索、分组预览与冲突确认。接口不全时只允许离线预览导出。源码核对：2026-11-16；实际设备兼容以运行时检测和本机验证为准。',
  button: { enabled: true, buttons: [{ name: '预设更新器', visible: true }] }, data: {}, export_with: { data: false, button: true },
};
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const destination = path.join(root, 'dist', '酒馆预设智能更新器-v' + version + '.json');
fs.writeFileSync(destination, JSON.stringify(script, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'dist', 'script-check.js'), content);
const nativeContent = '(function () {\n"use strict";\n' + parts.join('\n\n') + '\n\n' + part('extension') + '\nstartNativeUpdater().catch(e => { console.error("[预设更新器]", e); window.toastr?.error?.(e.message || String(e), "预设更新器未启动"); });\n})();\n';
fs.writeFileSync(path.join(root, 'index.js'), nativeContent);
const manifest = {
  display_name: '酒馆预设智能更新器', loading_order: 100, requires: [], optional: [],
  js: 'index.js', author: 'Preset Smart Updater contributors', version,
  homePage: 'https://github.com/ines02190621-dotcom/tavern-preset-updater', auto_update: false,
};
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(destination, fs.statSync(destination).size + ' bytes');
console.log(path.join(root, 'index.js'), Buffer.byteLength(nativeContent) + ' bytes');
