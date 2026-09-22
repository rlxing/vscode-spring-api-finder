'use strict';
/**
 * 极简 VS Code API 桩，用于在 node 里跑"激活 + 定义跳转"冒烟测试。
 * 只实现插件实际用到的那部分 API。
 */
const fs = require('fs');
const path = require('path');

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}
class Selection extends Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') super(new Position(a, b), new Position(c, d));
    else super(a, b);
  }
}
class Location {
  constructor(uri, position) {
    this.uri = uri;
    this.range = position && position.line !== undefined ? new Range(position, position) : position;
  }
}
class CodeLens {
  constructor(range, command) {
    this.range = range;
    this.command = command;
  }
}
class MarkdownString {
  constructor() {
    this.value = '';
  }
  appendMarkdown(text) {
    this.value += text;
    return this;
  }
}
class Hover {
  constructor(contents) {
    this.contents = contents;
  }
}
class DocumentLink {
  constructor(range, target) {
    this.range = range;
    this.target = target;
  }
}
class EventEmitter {
  constructor() {
    this._listeners = [];
  }
  get event() {
    return (listener) => {
      this._listeners.push(listener);
      return { dispose() {} };
    };
  }
  fire(value) {
    this.fired = (this.fired || 0) + 1;
    for (const l of this._listeners) l(value);
  }
  dispose() {}
}
class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
class Uri {
  constructor(fsPath, scheme) {
    this.scheme = scheme || 'file';
    this.fsPath = fsPath;
  }
  static file(fsPath) {
    return new Uri(fsPath, 'file');
  }
  static parse(value) {
    if (typeof value === 'string' && value.startsWith('file:///')) {
      const p = value.slice('file:///'.length).split('/').join(path.sep);
      return new Uri(p, 'file');
    }
    return new Uri(value, 'command');
  }
  toString() {
    if (this.scheme === 'file') return 'file:///' + this.fsPath.split(path.sep).join('/');
    return this.fsPath;
  }
}

function create(options = {}) {
  const roots = options.roots || [];
  const state = {
    commands: new Map(),
    definitionProvider: null,
    hoverProvider: null,
    linkProvider: null,
    codeLensProviders: [],
    openedPaths: [],
    watchers: 0,
    treeViews: [],
    inputValue: options.inputValue,
    infoMessages: [],
    warnings: [],
  };

  const allFiles = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else allFiles.push(p);
    }
  };
  roots.forEach(walk);
  const rootDir = roots[0] || process.cwd();

  const toUri = (p) => Uri.file(p);
  const disposable = () => ({ dispose() {} });

  const vscode = {
    version: '1.75.0-stub',
    Position,
    Range,
    Selection,
    Location,
    CodeLens,
    MarkdownString,
    Hover,
    DocumentLink,
    EventEmitter,
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri,
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    CancellationTokenSource: class {
      constructor() {
        this.token = { isCancellationRequested: false, onCancellationRequested: () => disposable() };
      }
      cancel() {
        this.token.isCancellationRequested = true;
      }
      dispose() {}
    },
    env: {
      clipboard: {
        async writeText() {},
        async readText() {
          return options.clipboardText || '';
        },
      },
    },
    window: {
      activeTextEditor: options.activeTextEditor || undefined,
      createOutputChannel() {
        return { appendLine() {}, append() {}, show() {}, dispose() {} };
      },
      createStatusBarItem() {
        return { text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} };
      },
      async showInputBox() {
        return state.inputValue;
      },
      async showQuickPick() {
        return undefined;
      },
      createQuickPick() {
        const qp = {
          items: [],
          value: '',
          title: '',
          placeholder: '',
          selectedItems: [],
          _accept: [],
          _hide: [],
          _change: [],
          show() {
            // 模拟用户：列表出现后选中第一项并回车
            setImmediate(() => {
              if (!qp.items.length) {
                qp.hide();
                return;
              }
              qp.selectedItems = [qp.items[0]];
              for (const cb of qp._accept) cb();
            });
          },
          hide() {
            for (const cb of qp._hide) cb();
          },
          dispose() {},
          onDidChangeValue(cb) { qp._change.push(cb); return disposable(); },
          onDidAccept(cb) { qp._accept.push(cb); return disposable(); },
          onDidHide(cb) { qp._hide.push(cb); return disposable(); },
        };
        return qp;
      },
      async withProgress(_opts, task) {
        return task({ report() {} }, { isCancellationRequested: false });
      },
      async showInformationMessage(msg) {
        state.infoMessages.push(msg);
        return undefined;
      },
      async showWarningMessage(msg) {
        state.warnings.push(msg);
        return undefined;
      },
      setStatusBarMessage() {
        return disposable();
      },
      createTreeView(id, options) {
        const view = {
          id,
          options,
          badge: undefined,
          title: '',
          description: '',
          visible: true,
          onDidChangeVisibility(cb) {
            view._visibility = cb;
            return disposable();
          },
          reveal() {},
          dispose() {},
        };
        state.treeViews.push(view);
        return view;
      },
      registerTreeDataProvider(id, provider) {
        state.treeViews.push({ id, options: { treeDataProvider: provider } });
        return disposable();
      },
      async showTextDocument(doc) {
        state.openedPaths.push(doc.uri.fsPath);
        return {
          selection: null,
          revealRange() {},
          document: doc,
        };
      },
    },
    workspace: {
      async findFiles(include) {
        if (/\{java,kt\}/.test(include)) {
          return allFiles.filter((f) => /\.(java|kt)$/.test(f)).map(toUri);
        }
        if (/application/.test(include)) {
          return allFiles.filter((f) => /application.*\.(ya?ml|properties)$/.test(f)).map(toUri);
        }
        return allFiles.map(toUri);
      },
      fs: {
        async readFile(uri) {
          return Buffer.from(fs.readFileSync(uri.fsPath));
        },
      },
      getWorkspaceFolder() {
        return { uri: Uri.file(rootDir), name: path.basename(rootDir), index: 0 };
      },
      asRelativePath(uri) {
        const p = typeof uri === 'string' ? uri : uri.fsPath;
        return path.relative(rootDir, p).split(path.sep).join('/');
      },
      createFileSystemWatcher() {
        state.watchers++;
        return {
          onDidCreate: () => disposable(),
          onDidChange: () => disposable(),
          onDidDelete: () => disposable(),
          dispose() {},
        };
      },
      onDidChangeConfiguration: () => disposable(),
      onDidChangeWorkspaceFolders: () => disposable(),
      onDidSaveTextDocument: () => disposable(),
      async openTextDocument(uri) {
        const target = typeof uri === 'string' ? uri : uri.fsPath;
        const lines = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').split(/\r?\n/) : [];
        return {
          uri: typeof uri === 'string' ? Uri.file(uri) : uri,
          languageId: path.extname(target).replace('.', ''),
          lineCount: lines.length,
          lineAt(line) {
            return { text: lines[line] || '' };
          },
          getText() {
            return lines.join('\n');
          },
        };
      },
      async findTextInFiles() {
        return { limitHit: false };
      },
      getConfiguration() {
        return {
          get(key, def) {
            return def;
          },
        };
      },
    },
    commands: {
      registerCommand(id, handler) {
        state.commands.set(id, handler);
        return disposable();
      },
      async executeCommand() {
        return undefined;
      },
    },
    languages: {
      registerDefinitionProvider(_langs, provider) {
        state.definitionProvider = provider;
        return disposable();
      },
      registerHoverProvider(_langs, provider) {
        state.hoverProvider = provider;
        return disposable();
      },
      registerDocumentLinkProvider(_langs, provider) {
        state.linkProvider = provider;
        return disposable();
      },
      registerCodeLensProvider(_selector, provider) {
        state.codeLensProviders.push(provider);
        return disposable();
      },
    },
    _state: state,
    _allFiles: allFiles,
  };
  return vscode;
}

module.exports = { create };
