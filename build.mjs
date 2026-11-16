import fs from 'node:fs';
import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const parts = ['groups', 'core', 'adapter', 'storage', 'ui'].map(n => fs.readFileSync(path.join(root, 'src', n + '.mjs'), 'utf8').replace(/^import .* from '\.\/groups\.mjs';\r?\n/m, '').replace(/^export /gm, ''));
const content = '(function () {\n"use strict";\n' + parts.join('\n\n') + '\nstartUpdater().catch(e => { console.error("[预设更新器]", e); const t = window.parent?.toastr || window.toastr; if (t) t.error(e.message || String(e), "预设更新器未启动"); });\n})();\n';
const script = {
  type: 'script', enabled: true, name: '酒馆预设智能更新器 v' + version, id: 'd2470acb-baa2-4c06-b65f-bd8738e2d910', content,
  info: '将本脚本导入酒馆助手的【全局脚本】并启用，点击【预设更新器】。首次绑定作者旧版与当前缝合版；后续选择作者新版进行三方合并。支持原始 Chat Completion 预设。自动备份后按原名称保存；保留自定义条目、开关及相对位置。v' + version + ' 新增柏宝箱及兼容 entryGrouping 折叠分组合并：处理新增条目归属，保留自定义条目的分组与分组总开关，重映射条目编号，并提供分组预览。新版缺少分组记录时需明确选择新增条目的分组。沿用关键词搜索、已保存绑定与备份。其他扩展仍默认保留。接口不全时只允许离线预览导出。源码核对：2026-11-16；实际设备兼容以运行时检测和本机验证为准。',
  button: { enabled: true, buttons: [{ name: '预设更新器', visible: true }] }, data: {}, export_with: { data: false, button: true },
};
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const destination = path.join(root, 'dist', '酒馆预设智能更新器-v' + version + '.json');
fs.writeFileSync(destination, JSON.stringify(script, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'dist', 'script-check.js'), content);
console.log(destination, fs.statSync(destination).size + ' bytes');
