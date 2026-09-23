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

const { parseJavaFile, MAPPING_ANNOTATIONS, parseMappingAnnotationSpec } = require('./springParser');
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
    /** 配置：自定义映射注解清单，如 ['ZmqRequestMapping:ZMQ'] */
    this.mappingAnnotations = [];
    /** 配置：从注解参数里认哪些属性名是路径，如 ['value','path','url','uri'] */
    this.pathAttributes = [];
    /** 配置：是否自动识别组合注解（被 @PostMapping 标注的 @interface） */
    this.discoverComposed = true;
    /** 自动识别到的组合注解：name -> {name, methods, basePaths, via, line} */
    this.discovered = new Map();
    this.discoveredAnnotations = [];
    this.built = false;
  }

  /** 当前生效的映射注解表：Spring 内置 + 用户配置 + 自动识别到的组合注解 */
  buildRegistry() {
    const reg = Object.assign({}, MAPPING_ANNOTATIONS, parseMappingAnnotationSpec(this.mappingAnnotations));
    for (const [name, d] of this.discovered) {
      reg[name] = { methods: d.methods || [], basePaths: d.basePaths };
    }
    return reg;
  }

  /** 传给解析器的参数 */
  parseOptions() {
    return {
      mappingAnnotations: this.buildRegistry(),
      pathAttributes: this.pathAttributes && this.pathAttributes.length ? this.pathAttributes : undefined,
      discoverComposed: this.discoverComposed !== false,
    };
  }

  get size() {
    return this.all.length;
  }

  /** 清空索引（配置变更/重建用） */
  clear() {
    this.byFile.clear();
    this.discovered = new Map();
    this.discoveredAnnotations = [];
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
    const records = new Map();
    this.discovered = new Map();
    this.discoveredAnnotations = [];
    let done = 0;
    const total = files.length;
    const queue = files.slice();

    /** 读文件 + 解析，并把新发现的组合注解收进注册表 */
    const readParse = async (file) => {
      let text;
      try {
        text = await this.host.readText(file);
      } catch (e) {
        return null; // 单个文件失败不影响整体
      }
      const result = parseJavaFile(text, this.parseOptions());
      for (const d of result.discovered) {
        if (!this.discovered.has(d.name)) this.discovered.set(d.name, d);
      }
      return result;
    };

    const worker = async () => {
      for (;;) {
        if (token && token.isCancellationRequested) return;
        const file = queue.shift();
        if (!file) return;
        const result = await readParse(file);
        if (result) records.set(file.key, { file, result });
        done++;
        if (onProgress && (done % 20 === 0 || done === total)) onProgress(done, total);
      }
    };
    await Promise.all(new Array(Math.min(READ_CONCURRENCY, Math.max(1, total))).fill(0).map(worker));
    if (token && token.isCancellationRequested) return false;

    // 组合注解可能"定义在 A 文件、用在 B 文件"，把用到它们的文件重解析一遍（链式注解最多几轮）
    for (let round = 0; round < 4 && this.discovered.size; round++) {
      const known = new Set(this.discovered.keys());
      const affected = [];
      for (const rec of records.values()) {
        const used = rec.result.annotationNames || [];
        if (used.some((n) => known.has(n))) affected.push(rec);
      }
      if (!affected.length) break;
      let grew = false;
      for (const rec of affected) {
        const sizeBefore = this.discovered.size;
        const result = await readParse(rec.file);
        if (!result) continue;
        rec.result = result;
        if (this.discovered.size > sizeBefore) grew = true;
      }
      if (!grew) break;
    }

    const next = new Map();
    for (const rec of records.values()) {
      if (!rec.result.endpoints.length) continue;
      next.set(rec.file.key, {
        file: rec.file,
        endpoints: rec.result.endpoints.map((e) => this.decorate(e, rec.file)),
      });
    }
    this.byFile = next;
    this._dirty = true;
    this._pathDirty = true;
    this.discoveredAnnotations = [...this.discovered.values()];
    this.contextPaths = await this.detectContextPaths().catch(() => []);
    this.built = true;
    return true;
  }

  /** 单文件增量刷新 */
  async updateFile(file) {
    try {
      const text = await this.host.readText(file);
      const result = parseJavaFile(text, this.parseOptions());
      let discoveredNew = false;
      for (const d of result.discovered) {
        if (!this.discovered.has(d.name)) {
          this.discovered.set(d.name, d);
          discoveredNew = true;
        }
      }
      if (discoveredNew) this.discoveredAnnotations = [...this.discovered.values()];
      if (result.endpoints.length) {
        this.byFile.set(file.key, { file, endpoints: result.endpoints.map((e) => this.decorate(e, file)) });
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
