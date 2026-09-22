'use strict';
/**
 * 侧边栏（活动栏）接口树
 *
 * 结构：
 *   🔍 搜索接口路径…              <- 点一下就打开搜索框（等于按 Ctrl+Alt+F）
 *   📦 KxgdnlController.java  4    <- 按 Controller 分组
 *       GET  /kxgdnl/WJDetail      <- 点一下跳到后端方法
 *       POST /kxgdnl/WJ/save
 *
 * 节点的右键菜单 / 行内按钮：复制完整路径、查找前端调用。
 */

const vscode = require('vscode');

const HTTP_ICON = {
  GET: 'arrow-down',
  POST: 'arrow-up',
  PUT: 'edit',
  PATCH: 'edit',
  DELETE: 'trash',
};

/** 单个接口节点 */
function makeEndpointNode(endpoint) {
  const item = new vscode.TreeItem(
    `${endpoint.httpMethods.join('/')}  ${endpoint.rawPath}`,
    vscode.TreeItemCollapsibleState.None
  );
  item.description = `#${endpoint.methodName}`;
  item.tooltip = [
    `${endpoint.className}#${endpoint.methodName}`,
    `${endpoint.relPath}:${endpoint.line + 1}`,
    endpoint.pathKnown ? '' : '⚠ 路径含未解析常量，可能不完整',
  ].filter(Boolean).join('\n');
  item.iconPath = new vscode.ThemeIcon(HTTP_ICON[endpoint.httpMethods[0]] || 'symbol-method');
  item.contextValue = 'endpoint';
  item.command = {
    command: 'springApi.openEndpoint',
    title: '打开 Controller 方法',
    arguments: [endpoint],
  };
  return { kind: 'endpoint', item, endpoint };
}

/** Controller 文件节点 */
function makeControllerNode(group) {
  const name = group.relPath.split('/').pop() || group.relPath;
  const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Collapsed);
  item.description = `${group.endpoints.length}`;
  item.tooltip = `${group.relPath}\n共 ${group.endpoints.length} 个接口`;
  item.iconPath = new vscode.ThemeIcon('symbol-class');
  item.contextValue = 'controller';
  item.command = {
    command: 'springApi.openEndpoint',
    title: '打开',
    arguments: [group.endpoints[0]],
  };
  return { kind: 'controller', item, endpoints: group.endpoints };
}

/** 顶部"搜索接口路径"入口 */
function makeSearchNode() {
  const item = new vscode.TreeItem('搜索接口路径…', vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('search');
  item.tooltip = '点一下即可搜索，例如 /kxgdnl/WJDetail（等价于 Ctrl+Alt+F）';
  item.contextValue = 'action';
  item.command = { command: 'springApi.search', title: '搜索接口路径' };
  return { kind: 'action', item };
}

/** 索引还没建立时的提示节点 */
function makeHintNode(label, tooltip) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('info');
  item.tooltip = tooltip || label;
  item.contextValue = 'hint';
  return { kind: 'hint', item };
}

/**
 * 创建树数据提供者
 * @param {import('./endpointIndex').EndpointIndex} index
 */
function createEndpointTreeProvider(index) {
  const emitter = new vscode.EventEmitter();
  const provider = {
    onDidChangeTreeData: emitter.event,
    getTreeItem(node) {
      return node.item;
    },
    getChildren(node) {
      if (!node) {
        if (!index.built) return [];
        const groups = index.groups;
        if (!groups.length) {
          return [makeHintNode('没有找到任何接口，点这里重建索引', '执行 springApi.reindex')];
        }
        return [makeSearchNode(), ...groups.map(makeControllerNode)];
      }
      if (node.kind === 'controller') {
        return node.endpoints.map(makeEndpointNode);
      }
      return [];
    },
  };
  return {
    provider,
    refresh() {
      emitter.fire();
    },
    dispose() {
      emitter.dispose();
    },
  };
}

module.exports = { createEndpointTreeProvider, HTTP_ICON };
