'use strict';
/**
 * 激活冒烟测试：用 VS Code API 桩真正 activate 一次插件，
 * 然后走一遍"前端字符串 -> 后端 Controller"的定义跳转，确保插件级代码没写错。
 * 运行：node test/activation-smoke.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const FIXTURE = path.join(__dirname, 'fixtures', 'demo');
const REAL = path.join(__dirname, '..', '..', 'testApi', 'src', 'main', 'java');

const stub = require('./vscode-stub').create({
  roots: [FIXTURE, REAL].filter((p) => fs.existsSync(p)),
  inputValue: '/gw/kxgdnl/WJDetail',
});

// 注入 vscode 模块
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return stub;
  return originalLoad.apply(this, arguments);
};

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failed++;
    console.log('  \u2717 ' + name + '\n      ' + e.message);
  }
}

/** 用真实文件内容造一个假 document */
function fakeDocument(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  return {
    uri: stub.Uri.file(filePath),
    languageId: 'javascript',
    lineCount: lines.length,
    lineAt(line) {
      return { text: lines[line] || '' };
    },
    getText() {
      return lines.join('\n');
    },
  };
}

function findLineWith(doc, needle) {
  for (let i = 0; i < doc.lineCount; i++) {
    const idx = doc.lineAt(i).text.indexOf(needle);
    if (idx !== -1) return { line: i, col: idx + Math.floor(needle.length / 2) };
  }
  return null;
}

(async () => {
  console.log('\n[8] 插件激活冒烟测试（VS Code API 桩）');
  const context = { subscriptions: [] };
  const ext = require('../extension.js');

  test('activate() 不抛异常', () => {
    ext.activate(context);
  });

  const commands = [...stub._state.commands.keys()];
  test('注册了全部 6 个命令', () => {
    for (const id of [
      'springApi.search',
      'springApi.searchSelection',
      'springApi.findFrontendUsages',
      'springApi.reindex',
      'springApi.copyEndpointPath',
      'springApi.openEndpoint',
    ]) {
      assert.ok(commands.includes(id), `缺少命令 ${id}，实际: ${commands.join(', ')}`);
    }
  });
  test('注册了定义/悬停/链接/CodeLens provider', () => {
    assert.ok(stub._state.definitionProvider, '缺 definition provider');
    assert.ok(stub._state.hoverProvider, '缺 hover provider');
    assert.ok(stub._state.linkProvider, '缺 document link provider');
    assert.ok(stub._state.codeLensProviders.length >= 1, '缺 codelens provider');
  });
  test('注册了 java/kt 文件监听', () => {
    assert.ok(stub._state.watchers >= 2, `watcher 数量: ${stub._state.watchers}`);
  });

  const feDoc = fakeDocument(path.join(FIXTURE, 'frontend.js'));

  // 前端写 /gw/kxgdnl/WJDetail（带 context-path） -> Ctrl+点击
  const hit1 = findLineWith(feDoc, '/gw/kxgdnl/WJDetail');
  let locs = [];
  test('fixture 前端代码里能定位到 /gw/kxgdnl/WJDetail', () => {
    assert.ok(hit1, 'fixture 里没找到该路径');
  });
  locs = await stub._state.definitionProvider.provideDefinition(
    feDoc,
    new stub.Position(hit1.line, hit1.col)
  );
  test('定义跳转返回了 Controller 位置', () => {
    assert.ok(locs && locs.length, '没有返回 Location');
    assert.ok(
      locs[0].uri.fsPath.endsWith('KxgdnlController.java'),
      '跳错文件: ' + locs[0].uri.fsPath
    );
    assert.strictEqual(locs[0].range.start.line, 15, '应跳到 @GetMapping("/WJDetail") 那一行');
  });

  // 模板字符串 /kxgdnl/list/${type}
  const hit2 = findLineWith(feDoc, 'kxgdnl/list/${type}');
  locs = await stub._state.definitionProvider.provideDefinition(
    feDoc,
    new stub.Position(hit2.line, hit2.col)
  );
  test('模板字符串 /kxgdnl/list/${type} -> 跳到 list 方法', () => {
    assert.ok(locs && locs.length > 0, '没有返回 Location');
    assert.ok(locs[0].uri.fsPath.endsWith('KxgdnlController.java'));
  });

  // 常量拼接 /kxgdnl/WJ/save
  const hit3 = findLineWith(feDoc, 'kxgdnl/WJ/save');
  locs = await stub._state.definitionProvider.provideDefinition(
    feDoc,
    new stub.Position(hit3.line, hit3.col)
  );
  test('常量拼接 /kxgdnl/WJ/save -> 跳到 save 方法', () => {
    assert.ok(locs && locs.length > 0, '没有返回 Location');
  });

  // 不该跳的地方
  const hit4 = findLineWith(feDoc, '@/utils/request');
  locs = await stub._state.definitionProvider.provideDefinition(
    feDoc,
    new stub.Position(hit4.line, hit4.col)
  );
  test('@/utils/request 这种别名不会被当成接口', () => {
    assert.ok(!locs, '不应该返回 Location');
  });
  locs = await stub._state.definitionProvider.provideDefinition(
    feDoc,
    new stub.Position(hit4.line, 0)
  );
  test('光标在代码（非路径）上时不拦截 Ctrl+点击', () => {
    assert.ok(!locs, '不应该返回 Location');
  });

  // 悬停
  const hover = await stub._state.hoverProvider.provideHover(
    feDoc,
    new stub.Position(hit1.line, hit1.col)
  );
  test('悬停显示拼接后的完整接口路径', () => {
    assert.ok(hover, '没有 Hover');
    assert.ok(hover.contents.value.includes('/kxgdnl/WJDetail'), hover.contents.value);
  });

  // Java CodeLens
  const javaDoc = fakeDocument(path.join(FIXTURE, 'KxgdnlController.java'));
  javaDoc.uri = stub.Uri.file(path.join(FIXTURE, 'KxgdnlController.java'));
  const lenses = await stub._state.codeLensProviders[0].provideCodeLenses(javaDoc);
  test('Controller 上方生成 CodeLens（复制路径 / 前端调用）', () => {
    assert.strictEqual(lenses.length, 8, `期望 4 个接口 x 2 个 CodeLens，实际 ${lenses.length}`);
    assert.ok(lenses.some((l) => /WJDetail/.test(l.command.title)), '缺少 /kxgdnl/WJDetail 的 CodeLens');
    assert.ok(lenses.some((l) => l.command.title.includes('前端调用')), '缺少"前端调用"按钮');
  });

  // 搜索命令全流程（输入框返回 /gw/kxgdnl/WJDetail，唯一命中应直接跳转）
  await stub._state.commands.get('springApi.search')();
  test('搜索命令：唯一命中直接打开 Controller', () => {
    const last = stub._state.openedPaths[stub._state.openedPaths.length - 1];
    assert.ok(last && last.endsWith('KxgdnlController.java'), '实际打开: ' + last);
  });

  // 多个匹配时走 QuickPick，选中第一项后仍应正确跳转（回归：hide() 不能吞掉结果）
  stub._state.inputValue = 'WJDetail';
  const before = stub._state.openedPaths.length;
  await stub._state.commands.get('springApi.search')();
  test('搜索命令：多个匹配走 QuickPick 也能跳转', () => {
    assert.ok(stub._state.openedPaths.length > before, 'QuickPick 选择后没有打开文件');
    const last = stub._state.openedPaths[stub._state.openedPaths.length - 1];
    assert.ok(last.endsWith('KxgdnlController.java'), '实际打开: ' + last);
  });

  // 选中文本搜索命令
  stub._state.commands.get('springApi.copyEndpointPath')({
    rawPath: '/kxgdnl/WJDetail',
    normPath: '/kxgdnl/WJDetail',
    filePath: path.join(FIXTURE, 'KxgdnlController.java'),
    relPath: 'KxgdnlController.java',
    httpMethods: ['GET'],
    line: 15,
    character: 4,
    methodName: 'wjDetail',
    className: 'KxgdnlController',
    pathKnown: true,
  });
  test('复制接口路径命令可用', () => {
    assert.ok(stub._state.commands.has('springApi.copyEndpointPath'));
  });

  // 左侧活动栏接口树
  const treeView = stub._state.treeViews.find((v) => v.id === 'springApi.endpoints');
  const treeProvider = treeView && treeView.options.treeDataProvider;
  test('注册了左侧活动栏视图 springApi.endpoints', () => {
    assert.ok(treeView, '没有创建 springApi.endpoints 树视图');
    assert.ok(treeProvider, '树视图没有数据提供者');
  });
  const rootNodes = treeProvider.getChildren(undefined);
  test('树根节点 = 搜索入口 + 各 Controller', () => {
    assert.ok(rootNodes.length >= 2, `根节点太少: ${rootNodes.length}`);
    assert.strictEqual(rootNodes[0].item.command.command, 'springApi.search', '第一个节点应该是"搜索接口路径"入口');
    assert.ok(rootNodes.some((n) => n.item.label === 'KxgdnlController.java'), '缺少 KxgdnlController.java 节点');
  });
  test('点接口节点 = 跳到 Controller 方法', () => {
    const ctrl = rootNodes.find((n) => n.item.label === 'KxgdnlController.java');
    const kids = treeProvider.getChildren(ctrl);
    assert.strictEqual(kids.length, 4, `期望 4 个接口，实际 ${kids.length}`);
    const wj = kids.find((k) => k.item.label.includes('/kxgdnl/WJDetail'));
    assert.ok(wj, '缺少 /kxgdnl/WJDetail 节点');
    assert.strictEqual(wj.item.command.command, 'springApi.openEndpoint');
    assert.strictEqual(wj.item.command.arguments[0].methodName, 'wjDetail');
    assert.strictEqual(wj.item.contextValue, 'endpoint', '右键/行内按钮靠 contextValue 匹配');
  });
  test('活动栏图标显示接口数量角标', () => {
    assert.ok(treeView.badge && treeView.badge.value >= 4, `badge: ${JSON.stringify(treeView.badge)}`);
  });
  test('未知常量接口在树上标注警告', () => {
    const ctrl = rootNodes.find((n) => n.item.label === 'KxgdnlController.java');
    const kids = treeProvider.getChildren(ctrl);
    const unknown = kids.find((k) => k.item.label.includes('**'));
    assert.ok(unknown, '缺少未知常量接口节点');
    assert.ok(/未解析常量/.test(unknown.item.tooltip), '悬停提示里应有警告: ' + unknown.item.tooltip);
  });
  test('树节点刷新后仍可读取（回归）', () => {
    treeProvider.getTreeItem(rootNodes[0]);
    assert.ok(true);
  });

  Module._load = originalLoad;
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('冒烟测试崩溃:', e);
  process.exit(1);
});
