'use strict';
/**
 * Spring 接口路径查找器
 *
 * 解决的问题：
 *   前端代码里写 /kxgdnl/WJDetail，后端却把路径拆成
 *   类上的 @RequestMapping("/kxgdnl") + 方法上的 @GetMapping("/WJDetail")，
 *   用 VS Code 全局搜索整串永远搜不到。
 *
 * 本插件建立"类路径 + 方法路径"的接口索引，于是：
 *   1. 选中/粘贴接口路径 -> 快捷键 -> 直接跳到 Controller 方法
 *   2. 在前端字符串里 Ctrl+点击（F12）-> 直接跳到 Controller 方法
 *   3. 悬停显示对应后端接口
 *   4. Controller 方法上方显示完整路径，可一键复制 / 反查前端调用
 */

const path = require('path');
const vscode = require('vscode');
const { EndpointIndex } = require('./src/endpointIndex');
const { isProbablyPath, SCORE, isExcludedPath: isExcludedByGlobs } = require('./src/pathMatcher');
const { stringRanges, findPathAt } = require('./src/lineScan');
const { createEndpointTreeProvider } = require('./src/treeProvider');

const JAVA_GLOB = '**/*.{java,kt}';
const CONFIG_GLOB = '**/application*.{yml,yaml,properties}';
const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/target/**',
  '**/build/**',
  '**/out/**',
  '**/dist/**',
  '**/.git/**',
  '**/bin/**',
];
const FRONTEND_LANGS = [
  'javascript', 'javascriptreact', 'typescript', 'typescriptreact',
  'vue', 'svelte', 'astro', 'html', 'json', 'jsonc', 'htm',
];
const USAGE_GLOB = '**/*.{js,jsx,mjs,cjs,ts,tsx,vue,svelte,astro,html,htm,json,http,rest,jsp,ftl,vm,xml,java,kt,py,cs,go}';

/** @type {EndpointIndex} */
let index;
let output;
let statusBar;
let tree;
let treeView;
let ensurePromise = null;
const pendingUpdates = new Map();

/** 刷新侧边栏接口树 + 活动栏角标 */
function refreshTree() {
  if (!tree) return;
  tree.refresh();
  if (treeView) {
    treeView.badge = index.built && index.size
      ? { value: index.size, tooltip: `${index.size} 个接口` }
      : undefined;
  }
}

function cfg() {
  return vscode.workspace.getConfiguration('springApi');
}

function getExcludeGlob() {
  const extra = cfg().get('exclude') || [];
  return '{' + DEFAULT_EXCLUDE.concat(extra).join(',') + '}';
}

function toFile(uri) {
  return { key: uri.toString(), fsPath: uri.fsPath, display: uri.toString() };
}

/**
 * 判断某个文件是否在排除目录里。
 * 用于文件监听：初始扫描已按 glob 排除，但监听事件可能来自 target/ 这类目录，
 * 不能因为改了一个编译产物就把接口塞进索引。
 */
function isExcludedPath(fsPath) {
  return isExcludedByGlobs(fsPath, DEFAULT_EXCLUDE.concat(cfg().get('exclude') || []));
}

function createHost() {
  return {
    async findJavaFiles() {
      const uris = await vscode.workspace.findFiles(JAVA_GLOB, getExcludeGlob());
      return uris.map(toFile);
    },
    async findConfigFiles() {
      const uris = await vscode.workspace.findFiles(CONFIG_GLOB, getExcludeGlob());
      return uris.map(toFile);
    },
    async readText(file) {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(file.key));
      return Buffer.from(bytes).toString('utf8');
    },
    relativePath(fsPath) {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
      if (!folder) return fsPath;
      return path.relative(folder.uri.fsPath, fsPath).split(path.sep).join('/');
    },
  };
}

// ---------------------------------------------------------------- 索引管理

/** 把配置里的忽略前缀 / 自定义映射注解同步到索引 */
function applyConfigToIndex() {
  index.extraPrefixes = (cfg().get('ignorePrefixes') || []).filter(Boolean);
  index.mappingAnnotations = (cfg().get('extraMappingAnnotations') || []).filter(Boolean);
  index.pathAttributes = (cfg().get('pathAttributeNames') || []).filter(Boolean);
  index.discoverComposed = cfg().get('discoverComposedAnnotations', true) !== false;
}

/** 索引建立后把自定义注解的使用情况写到输出面板，便于排查"为什么没搜到" */
function logCustomAnnotations() {
  const configured = index.mappingAnnotations || [];
  if (configured.length) {
    output.appendLine(`[自定义映射注解] 配置生效: ${configured.join(', ')}`);
  }
  const found = index.discoveredAnnotations || [];
  if (found.length) {
    output.appendLine(`[自动识别组合注解] ${found.map((d) => `${d.name}(继承 ${d.via}${d.methods && d.methods.length ? ' ' + d.methods.join('/') : ''}${d.basePaths && d.basePaths.length ? ' 路径 ' + d.basePaths.join(',') : ''})`).join('、')}`);
  }
}

async function ensureIndexed(withProgress) {
  if (index.built) return;
  if (ensurePromise) return ensurePromise;
  applyConfigToIndex();
  ensurePromise = (async () => {
    const run = async (progress, token) => {
      progress.report({ message: '扫描 @RequestMapping / @GetMapping ...' });
      const begin = Date.now();
      const ok = await index.rebuild(token, (done, total) => {
        progress.report({ message: `已解析 ${done}/${total} 个 Java/Kotlin 文件` });
      });
      if (!ok) return;
      output.appendLine(`[索引] ${index.size} 个接口，用时 ${Date.now() - begin}ms，忽略前缀: ${index.contextPaths.join(', ') || '(无)'}`);
      logCustomAnnotations();
    };
    if (withProgress) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '建立 Spring 接口索引', cancellable: true },
        run
      );
    } else {
      await index.rebuild(undefined);
      logCustomAnnotations();
    }
    updateStatusBar();
    refreshTree();
  })().finally(() => {
    ensurePromise = null;
  });
  return ensurePromise;
}

async function forceReindex() {
  index.clear();
  await ensureIndexed(true);
  vscode.window.setStatusBarMessage(`$(check) Spring 接口索引已重建：${index.size} 个接口`, 4000);
}

function updateStatusBar() {
  if (!statusBar) return;
  if (!cfg().get('showStatusBar', true)) {
    statusBar.hide();
    return;
  }
  if (!index.built) {
    statusBar.text = '$(symbol-method) 接口索引未建立';
    statusBar.tooltip = '点击建立索引并搜索接口';
  } else {
    statusBar.text = `$(symbol-method) 接口 ${index.size}`;
    statusBar.tooltip = '点击搜索接口路径（类路径 + 方法路径已合并）';
  }
  statusBar.command = 'springApi.search';
  statusBar.show();
}

function scheduleFileUpdate(uri) {
  if (isExcludedPath(uri.fsPath)) return;
  const key = uri.toString();
  if (pendingUpdates.has(key)) clearTimeout(pendingUpdates.get(key));
  pendingUpdates.set(
    key,
    setTimeout(() => {
      pendingUpdates.delete(key);
      if (!index.built) return;
      index.updateFile(toFile(uri)).then(() => {
        updateStatusBar();
        refreshTree();
      }, () => {});
    }, 400)
  );
}

// ---------------------------------------------------------------- 结果展示

function methodIcon(methods) {
  const m = (methods && methods[0]) || 'ANY';
  switch (m) {
    case 'GET': return '$(arrow-down)';
    case 'POST': return '$(arrow-up)';
    case 'PUT': return '$(edit)';
    case 'DELETE': return '$(trash)';
    default: return '$(symbol-method)';
  }
}

function toItem(match) {
  const ep = match.endpoint;
  const where = ep.className ? `${ep.className}${ep.methodName ? '#' + ep.methodName : ''}` : ep.methodName;
  return {
    label: `${methodIcon(ep.httpMethods)} ${ep.httpMethods.join('/')}  ${ep.rawPath}`,
    description: where,
    detail: `${ep.relPath}:${ep.line + 1}${ep.pathKnown ? '' : '   ⚠ 路径含未解析常量'}`,
    endpoint: ep,
  };
}

async function openEndpoint(ep) {
  if (!ep) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ep.filePath));
  const viewColumn = cfg().get('openBeside', false) ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
  const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn });
  const pos = new vscode.Position(ep.line, Math.max(0, ep.character || 0));
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** 用 VS Code 内置全局搜索兜底（索引里找不到时） */
function nativeSearch(query) {
  const segs = String(query || '')
    .split(/[/?#]/)
    .map((s) => s.trim())
    .filter((s) => s && !/^[\d*{}$:.-]+$/.test(s));
  let pattern = String(query || '').replace(/^[`'"]+|[`'"]+$/g, '');
  if (segs.length > 1) {
    pattern = '(' + segs.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
  } else if (segs.length === 1) {
    pattern = segs[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  vscode.commands.executeCommand('workbench.action.findInFiles', {
    query: pattern,
    isRegex: segs.length > 1,
    triggerSearch: true,
  });
}

function showPicker(initialValue) {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.title = 'Spring 接口查找';
    qp.placeholder = '输入接口路径，例如 /kxgdnl/WJDetail（只写后半段也能搜到）';
    qp.value = initialValue || '';
    let timer = null;
    let resolved = false;
    let accepted = false;
    const done = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    const refresh = () => {
      const value = qp.value.trim();
      const matches = index.query(value, { limit: 100 });
      if (!matches.length) {
        qp.items = [{
          label: '$(search) 索引中没有匹配，改用 VS Code 全局搜索',
          detail: '会按路径片段做或（OR）搜索',
          alwaysShow: true,
          action: 'native',
          query: value,
        }];
        return;
      }
      qp.items = matches.map(toItem);
    };
    qp.onDidChangeValue(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 60);
    });
    qp.onDidAccept(() => {
      accepted = true; // 先置位，避免 hide() 触发的 onDidHide 把结果冲掉
      const picked = qp.selectedItems[0];
      if (!picked) {
        qp.hide();
        return done(undefined);
      }
      if (picked.action === 'native') {
        nativeSearch(picked.query);
        qp.hide();
        return done(undefined);
      }
      qp.hide();
      done(picked.endpoint);
    });
    qp.onDidHide(() => {
      if (timer) clearTimeout(timer);
      qp.dispose();
      if (!accepted) done(undefined);
    });
    refresh();
    qp.show();
  });
}

async function runSearch(text) {
  const query = String(text === undefined || text === null ? '' : text).trim();
  if (!query) {
    vscode.window.showInformationMessage('没有可搜索的接口路径。');
    return;
  }
  await ensureIndexed(true);
  const matches = index.query(query, { limit: 100 });
  if (!matches.length) {
    const pick = await vscode.window.showWarningMessage(
      `接口索引里找不到「${query}」。`,
      '用 VS Code 全局搜索片段'
    );
    if (pick) nativeSearch(query);
    return;
  }
  const best = matches[0];
  if (matches.length === 1 && best.score >= SCORE.SUFFIX && cfg().get('autoOpenSingleMatch', true)) {
    await openEndpoint(best.endpoint);
    vscode.window.setStatusBarMessage(
      `$(check) ${best.endpoint.httpMethods.join('/')} ${best.endpoint.rawPath} → ${best.endpoint.relPath}:${best.endpoint.line + 1}`,
      4000
    );
    return;
  }
  const picked = await showPicker(query);
  if (picked) await openEndpoint(picked);
}

// ---------------------------------------------------------------- 从编辑器取路径

function getSelectionText(editor) {
  if (!editor) return '';
  const sel = editor.selection;
  if (!sel.isEmpty) return editor.document.getText(sel);
  const word = editor.document.getWordRangeAtPosition(sel.active, /[^\s'"`,;()\[\]{}]+/);
  return word ? editor.document.getText(word) : '';
}

/** 取光标所在的"接口路径"文本；取不到返回 '' */
function extractPathAt(document, position) {
  return findPathAt(document.lineAt(position.line).text, position.character);
}

// ---------------------------------------------------------------- 前端 -> 后端

const definitionProvider = {
  async provideDefinition(document, position) {
    if (!cfg().get('enableDefinition', true)) return undefined;
    const text = extractPathAt(document, position);
    if (!text) return undefined;
    await ensureIndexed(false);
    const matches = index.query(text, { limit: 20 });
    if (!matches.length) return undefined;
    const startsWithSlash = text.trim().startsWith('/');
    const threshold = startsWithSlash ? SCORE.SUFFIX : SCORE.EXACT_CI;
    if (matches[0].score < threshold) return undefined;
    const best = matches[0].score;
    const locations = [];
    for (const m of matches) {
      if (m.score < best) break;
      locations.push(new vscode.Location(
        vscode.Uri.file(m.endpoint.filePath),
        new vscode.Position(m.endpoint.line, Math.max(0, m.endpoint.character || 0))
      ));
      if (locations.length >= 10) break;
    }
    return locations.length ? locations : undefined;
  },
};

const hoverProvider = {
  async provideHover(document, position) {
    if (!cfg().get('enableHover', true)) return undefined;
    const text = extractPathAt(document, position);
    if (!text) return undefined;
    await ensureIndexed(false);
    const matches = index.query(text, { limit: 5, minScore: SCORE.CONTAINS });
    if (!matches.length) return undefined;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**后端接口**（来自 Spring 注解拼接）\n\n`);
    for (const m of matches) {
      const ep = m.endpoint;
      md.appendMarkdown(`- \`${ep.httpMethods.join('/')}\` **${ep.rawPath}**  \n  \`${ep.className}${ep.methodName ? '.' + ep.methodName : ''}\` — ${ep.relPath}:${ep.line + 1}\n`);
    }
    md.appendMarkdown(`\n_按 F12 / Ctrl+点击 跳转到 Controller_`);
    return new vscode.Hover(md);
  },
};

const documentLinkProvider = {
  async provideDocumentLinks(document) {
    if (!cfg().get('enableDocumentLink', false)) return [];
    await ensureIndexed(false);
    const links = [];
    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i).text;
      for (const r of stringRanges(line)) {
        const text = line.slice(r.start, r.end);
        if (!isProbablyPath(text)) continue;
        const matches = index.query(text, { limit: 1 });
        if (!matches.length || matches[0].score < SCORE.SUFFIX) continue;
        const ep = matches[0].endpoint;
        const range = new vscode.Range(i, r.start, i, r.end);
        const args = encodeURIComponent(JSON.stringify([ep]));
        const link = new vscode.DocumentLink(range, vscode.Uri.parse(`command:springApi.openEndpoint?${args}`));
        link.tooltip = `跳转：${ep.httpMethods.join('/')} ${ep.rawPath} (${ep.relPath}:${ep.line + 1})`;
        links.push(link);
      }
    }
    return links;
  },
};

// ---------------------------------------------------------------- 后端 -> 前端

const codeLensProvider = {
  async provideCodeLenses(document) {
    if (!cfg().get('showCodeLens', true)) return [];
    await ensureIndexed(false);
    const entries = index.entriesForFile(document.uri.fsPath);
    const lenses = [];
    for (const ep of entries) {
      const range = new vscode.Range(ep.line, 0, ep.line, 0);
      lenses.push(new vscode.CodeLens(range, {
        title: `$(clippy) ${ep.httpMethods.join('/')} ${ep.rawPath}`,
        tooltip: '复制完整接口路径',
        command: 'springApi.copyEndpointPath',
        arguments: [ep],
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: '$(references) 前端调用',
        tooltip: '在项目中查找调用该接口的前端代码',
        command: 'springApi.findFrontendUsages',
        arguments: [ep],
      }));
    }
    return lenses;
  },
};

function endpointAtCursor(editor) {
  if (!editor) return null;
  const entries = index.entriesForFile(editor.document.uri.fsPath);
  if (!entries.length) return null;
  const line = editor.selection.active.line;
  let best = null;
  for (const ep of entries) {
    if (ep.line <= line + 2 && (!best || ep.line >= best.line)) best = ep;
  }
  return best;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findFrontendUsages(ep) {
  if (!ep) {
    const editor = vscode.window.activeTextEditor;
    ep = endpointAtCursor(editor);
    if (!ep) {
      const text = getSelectionText(editor);
      if (text) return runSearch(text);
      vscode.window.showInformationMessage('把光标放在某个 @GetMapping/@PostMapping 方法上再试。');
      return;
    }
  }
  const segs = ep.normPath.replace(/^\//, '').split('/').filter((s) => s && s !== '*' && s !== '**');
  if (!segs.length) {
    vscode.window.showInformationMessage('该接口没有可用于搜索的路径片段。');
    return;
  }
  const last = segs[segs.length - 1];
  const tail = segs.length > 1 ? `${segs[segs.length - 2]}/${last}` : last;
  const pattern = segs.length > 1 ? `(${escapeRegex(tail)}|${escapeRegex(last)})` : escapeRegex(last);

  if (typeof vscode.workspace.findTextInFiles !== 'function') {
    nativeSearch(tail);
    return;
  }

  const hits = [];
  try {
    await vscode.workspace.findTextInFiles(
      { pattern, isRegExp: true, isCaseSensitive: false },
      {
        include: USAGE_GLOB,
        exclude: getExcludeGlob(),
        maxResults: 300,
        previewOptions: { matchLines: 1, charsPerLine: 160 },
      },
      (result) => {
        if (!result || !result.uri) return;
        const ranges = Array.isArray(result.ranges) ? result.ranges : [];
        const first = ranges[0];
        hits.push({
          uri: result.uri,
          line: first && first.start ? first.start.line : 0,
          column: first && first.start ? first.start.character : 0,
          rel: vscode.workspace.asRelativePath(result.uri, false),
        });
      }
    );
  } catch (e) {
    output.appendLine(`[查找前端调用] 失败: ${e && e.message}`);
    nativeSearch(tail);
    return;
  }

  if (!hits.length) {
    const pick = await vscode.window.showInformationMessage(
      `没有找到调用「${tail}」的前端代码。`,
      '用 VS Code 全局搜索'
    );
    if (pick) nativeSearch(tail);
    return;
  }

  const items = hits.map((h) => ({
    label: `${vscode.workspace.asRelativePath(h.uri, false)}:${h.line + 1}`,
    description: `匹配 ${pattern}`,
    hit: h,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: `调用 ${ep.httpMethods.join('/')} ${ep.rawPath} 的位置（${items.length}）`,
    placeHolder: '选择后跳转',
    matchOnDescription: true,
  });
  if (!picked) return;
  const doc = await vscode.workspace.openTextDocument(picked.hit.uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const pos = new vscode.Position(picked.hit.line, picked.hit.column);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// ---------------------------------------------------------------- 激活

function activate(context) {
  output = vscode.window.createOutputChannel('Spring 接口查找');
  index = new EndpointIndex(createHost());
  applyConfigToIndex();

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  context.subscriptions.push(statusBar);

  // 左侧活动栏：接口树（不想记快捷键就直接点这里）
  tree = createEndpointTreeProvider(index);
  treeView = vscode.window.createTreeView('springApi.endpoints', {
    treeDataProvider: tree.provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView, { dispose: () => tree.dispose() });
  treeView.onDidChangeVisibility((e) => {
    // 点开侧边栏时，如果索引还没建立就自动建一次
    if (e.visible && !index.built) {
      ensureIndexed(true).then(refreshTree, () => {});
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('springApi.search', async () => {
      const editor = vscode.window.activeTextEditor;
      let seed = getSelectionText(editor);
      // 没选中时，如果剪贴板里正好是一条接口路径，直接预填（复制前端路径 -> 按快捷键 -> 回车）
      if (!seed) {
        try {
          const clip = (await vscode.env.clipboard.readText()).trim();
          if (clip && clip.length <= 300 && isProbablyPath(clip)) seed = clip;
        } catch (e) {
          // 剪贴板不可用时忽略
        }
      }
      const input = await vscode.window.showInputBox({
        title: '搜索接口路径',
        prompt: '可直接粘贴前端里的路径，例如 /kxgdnl/WJDetail；只写后半段也行',
        value: /^[\x20-\x7e\u4e00-\u9fa5]+$/.test(seed) && seed.length <= 300 ? seed : '',
      });
      if (input === undefined) return;
      await runSearch(input);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('springApi.searchSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      const text = getSelectionText(editor);
      if (!text || !/[A-Za-z0-9_/]/.test(text)) {
        await vscode.commands.executeCommand('springApi.search');
        return;
      }
      await runSearch(text);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('springApi.reindex', forceReindex)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('springApi.copyEndpointPath', async (arg) => {
      const ep = arg && arg.normPath ? arg : null;
      if (!ep) return;
      await vscode.env.clipboard.writeText(ep.rawPath);
      vscode.window.setStatusBarMessage(`$(clippy) 已复制 ${ep.rawPath}`, 3000);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('springApi.openEndpoint', openEndpoint)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('springApi.findFrontendUsages', async (arg) => {
      // 从侧边栏树点进来时，收到的可能是节点对象而不是接口对象
      let ep = arg && arg.normPath ? arg : null;
      if (!ep && arg && Array.isArray(arg.endpoints) && arg.endpoints.length) {
        ep = arg.endpoints[0];
      }
      await findFrontendUsages(ep);
    })
  );

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(FRONTEND_LANGS, definitionProvider),
    vscode.languages.registerHoverProvider(FRONTEND_LANGS, hoverProvider),
    vscode.languages.registerDocumentLinkProvider(FRONTEND_LANGS, documentLinkProvider),
    vscode.languages.registerCodeLensProvider({ language: 'java' }, codeLensProvider),
    vscode.languages.registerCodeLensProvider({ language: 'kotlin' }, codeLensProvider)
  );

  const javaWatcher = vscode.workspace.createFileSystemWatcher(JAVA_GLOB);
  javaWatcher.onDidCreate(scheduleFileUpdate);
  javaWatcher.onDidChange(scheduleFileUpdate);
  javaWatcher.onDidDelete((uri) => {
    index.removeFile(toFile(uri));
    updateStatusBar();
    refreshTree();
  });
  context.subscriptions.push(javaWatcher);

  const cfgWatcher = vscode.workspace.createFileSystemWatcher(CONFIG_GLOB);
  const refreshPrefixes = () => {
    if (!index.built) return;
    index.detectContextPaths().then((paths) => {
      index.contextPaths = paths;
    }, () => {});
  };
  cfgWatcher.onDidCreate(refreshPrefixes);
  cfgWatcher.onDidChange(refreshPrefixes);
  context.subscriptions.push(cfgWatcher);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('springApi.exclude') ||
        e.affectsConfiguration('springApi.extraMappingAnnotations') ||
        e.affectsConfiguration('springApi.pathAttributeNames') ||
        e.affectsConfiguration('springApi.discoverComposedAnnotations')
      ) {
        forceReindex();
      } else if (e.affectsConfiguration('springApi.ignorePrefixes')) {
        applyConfigToIndex();
        updateStatusBar();
      } else {
        updateStatusBar();
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      forceReindex();
    })
  );

  updateStatusBar();
  if (cfg().get('indexOnActivation', true)) {
    ensureIndexed(false).catch(() => {});
  }
}

function deactivate() {
  for (const t of pendingUpdates.values()) clearTimeout(t);
  pendingUpdates.clear();
}

module.exports = { activate, deactivate };
