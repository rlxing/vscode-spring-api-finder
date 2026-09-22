'use strict';
/**
 * 工作区接口索引
 *
 * 与 VS Code 解耦：所有文件读写通过 host 注入，方便单测。
 * host 接口：
 *   findJavaFiles(): Promise<Array<{key, fsPath, display}>>
 *   findConfigFiles(): Promise<Array<{key, fsPath, display}>>
 *   readText(file): Promise<string>
 *   relativePath(fsPath): string
 */

const { parseJavaFile } = require('./springParser');
const { normalizePath, scoreMatch, wildcardPenalty } = require('./pathMatcher');

const READ_CONCURRENCY = 8;

class EndpointIndex {
  constructor(host) {
    this.host = host;
    /** @type {Map<string, {file: object, endpoints: Array}>} */
    this.byFile = new Map();
    this._flat = [];
    this._dirty = true;
    this._pathMap = new Map();
    this._pathDirty = true;
    this.contextPaths = [];
    this.extraPrefixes = [];
    this.built = false;
  }

  get size() {
    return this.all.length;
  }

  /** 清空索引（配置变更/重建用） */
  clear() {
    this.byFile.clear();
    this._dirty = true;
    this._pathDirty = true;
    this.built = false;
  }

  /** fsPath -> endpoints，供 CodeLens 快速查询 */
  get pathMap() {
    if (!this._pathDirty) return this._pathMap;
    const m = new Map();
    for (const rec of this.byFile.values()) m.set(rec.file.fsPath, rec.endpoints);
    this._pathMap = m;
    this._pathDirty = false;
    return m;
  }

  get all() {
    if (this._dirty) {
      const flat = [];
      for (const rec of this.byFile.values()) flat.push(...rec.endpoints);
      this._flat = flat;
      this._dirty = false;
    }
    return this._flat;
  }

  /** 全量重建索引 */
  async rebuild(token, onProgress) {
    const files = await this.host.findJavaFiles();
    const next = new Map();
    let done = 0;
    const total = files.length;
    const queue = files.slice();
    const worker = async () => {
      for (;;) {
        if (token && token.isCancellationRequested) return;
        const file = queue.shift();
        if (!file) return;
        try {
          const text = await this.host.readText(file);
          const { endpoints } = parseJavaFile(text);
          if (endpoints.length) {
            const prepared = endpoints.map((e) => this.decorate(e, file));
            next.set(file.key, { file, endpoints: prepared });
          }
        } catch (e) {
          // 单个文件失败不影响整体
        }
        done++;
        if (onProgress && (done % 20 === 0 || done === total)) onProgress(done, total);
      }
    };
    await Promise.all(new Array(Math.min(READ_CONCURRENCY, Math.max(1, total))).fill(0).map(worker));
    if (token && token.isCancellationRequested) return false;
    this.byFile = next;
    this._dirty = true;
    this._pathDirty = true;
    this.contextPaths = await this.detectContextPaths().catch(() => []);
    this.built = true;
    return true;
  }

  /** 单文件增量刷新 */
  async updateFile(file) {
    try {
      const text = await this.host.readText(file);
      const { endpoints } = parseJavaFile(text);
      if (endpoints.length) {
        this.byFile.set(file.key, { file, endpoints: endpoints.map((e) => this.decorate(e, file)) });
      } else {
        this.byFile.delete(file.key);
      }
      this._dirty = true;
      this._pathDirty = true;
      this.built = true;
    } catch (e) {
      this.byFile.delete(file.key);
      this._dirty = true;
      this._pathDirty = true;
    }
  }

  removeFile(file) {
    if (this.byFile.delete(file.key)) {
      this._dirty = true;
      this._pathDirty = true;
    }
  }

  /** 补上派生字段 */
  decorate(endpoint, file) {
    const normPath = normalizePath(endpoint.rawPath);
    return Object.assign({}, endpoint, {
      fileKey: file.key,
      filePath: file.fsPath,
      relPath: this.host.relativePath(file.fsPath),
      normPath,
    });
  }

  entriesForFile(fsPath) {
    return this.pathMap.get(fsPath) || [];
  }

  /** 按 Controller 文件分组（侧边栏树用），按相对路径排序 */
  get groups() {
    const list = [];
    for (const rec of this.byFile.values()) {
      if (!rec.endpoints.length) continue;
      list.push({
        file: rec.file,
        relPath: rec.endpoints[0].relPath,
        endpoints: rec.endpoints.slice().sort((a, b) => a.line - b.line),
      });
    }
    list.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return list;
  }

  /** 需要忽略的前缀：配置里的 ignorePrefixes + 自动识别的 context-path */
  getPrefixes() {
    const list = [];
    for (const p of this.extraPrefixes) if (p && !list.includes(p)) list.push(p);
    for (const p of this.contextPaths) if (p && !list.includes(p)) list.push(p);
    return list;
  }

  /**
   * 查询接口
   * @param {string} text 用户输入/前端代码里的路径
   * @param {{limit?: number, minScore?: number, prefixes?: string[]}} options
   * @returns {Array<{endpoint: object, score: number}>}
   */
  query(text, options = {}) {
    const limit = options.limit || 50;
    const minScore = options.minScore === undefined ? 1 : options.minScore;
    const q = String(text === undefined || text === null ? '' : text).trim();
    const prefixes = options.prefixes || this.getPrefixes();
    const list = this.all;
    if (!q) return list.slice(0, limit).map((endpoint) => ({ endpoint, score: 0 }));

    const out = [];
    for (const endpoint of list) {
      const base = scoreMatch(endpoint.normPath, q, prefixes);
      if (base < minScore) continue;
      out.push({ endpoint, score: base - wildcardPenalty(endpoint.normPath) * 6 });
    }
    out.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.endpoint.normPath.length !== b.endpoint.normPath.length) {
        return a.endpoint.normPath.length - b.endpoint.normPath.length;
      }
      if (a.endpoint.relPath !== b.endpoint.relPath) return a.endpoint.relPath.localeCompare(b.endpoint.relPath);
      return a.endpoint.line - b.endpoint.line;
    });
    return out.slice(0, limit);
  }

  /** 从配置文件里识别 context-path / 网关前缀，前端往往带着这些前缀 */
  async detectContextPaths() {
    const prefixes = [];
    let files = [];
    try {
      files = await this.host.findConfigFiles();
    } catch (e) {
      return prefixes;
    }
    for (const file of files.slice(0, 20)) {
      let text = '';
      try {
        text = await this.host.readText(file);
      } catch (e) {
        continue;
      }
      const patterns = [
        /context-path\s*[:=]\s*["']?([^\s"',#]+)/gi,
        /contextPath\s*[:=]\s*["']?([^\s"',#]+)/gi,
        /Path\s*=\s*(\/[^\s,)"']+)/gi, // Spring Cloud Gateway: Path=/api/**
      ];
      for (const re of patterns) {
        let m;
        while ((m = re.exec(text)) !== null) {
          let p = String(m[1]).trim();
          p = p.replace(/\/\*\*$/, '').replace(/\/+$/, '');
          if (!p.startsWith('/') || p === '/') continue;
          if (!prefixes.includes(p)) prefixes.push(p);
        }
      }
    }
    return prefixes;
  }
}

module.exports = { EndpointIndex };
