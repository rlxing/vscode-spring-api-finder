'use strict';
/**
 * 插件清单自检：确保 package.json 里引用的命令、视图、图标文件都真实存在。
 * 运行：node test/manifest-check.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const c = pkg.contributes || {};

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failed++;
    console.log('  \u2717 ' + name + '\n      ' + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const commandIds = new Set((c.commands || []).map((x) => x.command));
const viewIds = new Set();
for (const list of Object.values(c.views || {})) {
  for (const v of list) viewIds.add(v.id);
}

console.log('\n[9] package.json 清单自检');

check('命令 id 唯一且非空', () => {
  const seen = new Set();
  for (const cmd of c.commands || []) {
    assert(cmd.command && cmd.title, '命令缺少 command/title');
    assert(!seen.has(cmd.command), '命令重复: ' + cmd.command);
    seen.add(cmd.command);
  }
  assert(seen.size >= 6, '命令数量异常: ' + seen.size);
});

check('快捷键指向已注册的命令', () => {
  for (const kb of c.keybindings || []) {
    assert(commandIds.has(kb.command), `快捷键指向不存在的命令: ${kb.command}`);
  }
});

// VS Code 内置命令允许直接引用；当前没用到，一旦要用必须在这里登记，
// 否则会重现 "菜单项引用未在命令部分进行定义的命令" 这类运行时报错
const ALLOWED_BUILTIN_COMMANDS = new Set([]);

check('菜单项引用的命令都已声明（含 workbench.*）', () => {
  for (const [group, items] of Object.entries(c.menus || {})) {
    for (const item of items) {
      if (ALLOWED_BUILTIN_COMMANDS.has(item.command)) continue;
      assert(
        commandIds.has(item.command),
        `${group} 里引用了未在 contributes.commands 声明的命令: ${item.command}`
      );
    }
  }
});

check('菜单 when 里的视图 id 都已声明', () => {
  for (const [group, items] of Object.entries(c.menus || {})) {
    if (!group.startsWith('view')) continue;
    for (const item of items) {
      const m = /view\s*==\s*([\w.]+)/.exec(item.when || '');
      if (m) assert(viewIds.has(m[1]), `${group} 引用了未声明的视图: ${m[1]}`);
    }
  }
});

check('viewsWelcome 指向已声明的视图', () => {
  for (const w of c.viewsWelcome || []) {
    assert(viewIds.has(w.view), 'viewsWelcome 指向未声明的视图: ' + w.view);
  }
});

check('图标文件真实存在', () => {
  for (const list of Object.values(c.viewsContainers || {})) {
    for (const vc of list) {
      assert(fs.existsSync(path.join(root, vc.icon)), `活动栏图标不存在: ${vc.icon}`);
    }
  }
  for (const list of Object.values(c.views || {})) {
    for (const v of list) {
      if (v.icon) assert(fs.existsSync(path.join(root, v.icon)), `视图图标不存在: ${v.icon}`);
    }
  }
});

check('插件入口文件存在且 engines 已声明', () => {
  assert(pkg.main && fs.existsSync(path.join(root, pkg.main)), 'main 入口不存在: ' + pkg.main);
  assert(pkg.engines && pkg.engines.vscode, '缺少 engines.vscode');
});

check('所有配置项都以 springApi. 开头并有 description', () => {
  const props = (c.configuration && c.configuration.properties) || {};
  for (const [key, def] of Object.entries(props)) {
    assert(key.startsWith('springApi.'), '配置项命名不规范: ' + key);
    assert(def.description, '配置项缺少说明: ' + key);
  }
  assert(Object.keys(props).length >= 8, '配置项数量异常');
});

check('README 里没有写死的旧版本号（避免"以为装的是旧版"）', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const found = readme.match(/spring-api-finder-0\.0\.\d+/g) || [];
  for (const f of found) {
    assert(
      f === `spring-api-finder-${pkg.version}`,
      `README 里写死了旧版本号 ${f}（package.json 当前是 ${pkg.version}），应改成动态获取版本`
    );
  }
});

console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
