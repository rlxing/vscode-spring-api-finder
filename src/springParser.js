'use strict';
/**
 * Spring Controller 解析器（纯文本 / 正则 + 括号配平，不依赖 Java 编译器）
 *
 * 能处理：
 *   @RestController
 *   @RequestMapping("/kxgdnl")            <- 类上
 *   public class XxxController {
 *       @GetMapping("/WJDetail")          <- 方法上
 *       public Object wjDetail() {...}
 *   }
 * 最终拼出 /kxgdnl/WJDetail
 *
 * 还支持：
 *   - @RequestMapping(value={"/a","/b"}, method=RequestMethod.POST)
 *   - @PostMapping(path = "/a")
 *   - 字符串常量：private static final String PREFIX = "/kxgdnl"; @RequestMapping(PREFIX + "/wj")
 *   - 多行注解、注解与签名同一行
 *   - 嵌套类（父子类路径会叠加）
 *   - 常量解析不出来时用 ** 兜底，保证"至少能被搜到"
 */

/** Spring 自带映射注解 -> 默认动词标签（空数组 = 由 method= 决定，取不到就 ANY） */
const BUILTIN_MAPPINGS = {
  RequestMapping: [],
  GetMapping: ['GET'],
  PostMapping: ['POST'],
  PutMapping: ['PUT'],
  DeleteMapping: ['DELETE'],
  PatchMapping: ['PATCH'],
};

/** 从注解参数里取路径时，默认认这些属性名 */
const DEFAULT_PATH_ATTRIBUTES = ['value', 'path', 'url', 'uri'];

/**
 * 把 { Name: ['GET'] } / { Name: {methods, basePaths} } / {'com.a.B': ['GET']} 统一成
 * { Name: {methods:[], basePaths?:[]} }，键一律用简单名（取最后一段）。
 */
function normalizeRegistry(map) {
  const out = {};
  for (const [name, value] of Object.entries(map || {})) {
    if (!name) continue;
    const simple = String(name).split('.').pop();
    if (!simple) continue;
    if (Array.isArray(value)) {
      out[simple] = { methods: value.slice() };
    } else if (value && typeof value === 'object') {
      out[simple] = {
        methods: Array.isArray(value.methods) ? value.methods.slice() : [],
        basePaths: Array.isArray(value.basePaths) && value.basePaths.length ? value.basePaths.slice() : undefined,
      };
    }
  }
  return out;
}

/**
 * 解析用户配置的自定义映射注解清单。
 * 支持：'ZmqRequestMapping'、'ZmqRequestMapping:ZMQ'、'ZmqRequestMapping:POST,GET'、
 *      'com.dfe.kserver.annotation.ZmqRequestMapping:ZMQ'
 * 冒号后面是**自由文本动词标签**（不限于 HTTP 动词，写 ZMQ/RPC 都行）。
 */
function parseMappingAnnotationSpec(specs) {
  const map = {};
  for (const raw of specs || []) {
    const spec = String(raw).trim();
    if (!spec) continue;
    const idx = spec.lastIndexOf(':');
    let name = spec;
    let verbs = [];
    if (idx > 0) {
      name = spec.slice(0, idx).trim();
      verbs = spec.slice(idx + 1).split(/[,|\s]+/).map((s) => s.trim()).filter(Boolean);
    }
    const simple = name.split('.').pop();
    if (!simple) continue;
    map[simple] = { methods: verbs };
  }
  return map;
}

const MAPPING_ANNOTATIONS = normalizeRegistry(BUILTIN_MAPPINGS);

const MODIFIER_RE = /^(?:public|protected|private|static|final|abstract|sealed|non-sealed|strictfp|default|synchronized|native|transient|volatile)$/;

/** 把字符串/字符字面量与注释替换成等长空白（保留换行），只留代码骨架 */
function maskCode(text) {
  const out = new Array(text.length);
  const n = text.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) out[k] = text[k] === '\n' ? '\n' : ' ';
  };
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const start = i;
      while (i < n && text[i] !== '\n') i++;
      blank(start, i);
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      blank(start, i);
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i++;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) { i++; break; }
        if (text[i] === '\n') break; // 容错：未闭合
        i++;
      }
      blank(start, i);
      continue;
    }
    out[i] = ch;
    i++;
  }
  return out.join('');
}

/** 每行起始偏移 */
function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** 偏移 -> 行号（0 基） */
function offsetToLine(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 每行开始处的大括号深度（用屏蔽后的代码算） */
function computeLineDepth(masked, lineStarts) {
  const depths = new Array(lineStarts.length).fill(0);
  let depth = 0;
  let line = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '\n') {
      line++;
      if (line < depths.length) depths[line] = depth;
    } else if (masked[i] === '{') depth++;
    else if (masked[i] === '}') depth = Math.max(0, depth - 1);
  }
  return depths;
}

/** 找出所有注解（含参数），参数文本取自原始代码，保留字符串字面量 */
function findAnnotations(masked, original) {
  const annotations = [];
  const re = /@[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    let end = m.index + m[0].length;
    let j = end;
    while (j < masked.length && /\s/.test(masked[j])) j++;
    let argsText = null;
    if (masked[j] === '(') {
      let depth = 0;
      let k = j;
      for (; k < masked.length; k++) {
        const c = masked[k];
        if (c === '(') depth++;
        else if (c === ')') {
          depth--;
          if (depth === 0) { k++; break; }
        }
      }
      argsText = original.slice(j + 1, k - 1);
      end = k;
    }
    annotations.push({
      start: m.index,
      end,
      name: m[0].slice(1).split('.').pop(),
      argsText,
    });
    re.lastIndex = end;
  }
  return annotations;
}

/** 找出类/接口/枚举声明（含注解类型 @interface） */
function findClassDeclarations(masked, lineStarts, lineDepth) {
  const classes = [];
  const re = /\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    // 排除 Xxx.class 这种字面量
    let p = m.index - 1;
    while (p >= 0 && /\s/.test(masked[p])) p--;
    if (p >= 0 && masked[p] === '.') continue;
    // public @interface Foo  ->  注解类型声明
    const isAnnotationType = m[1] === 'interface' && p >= 0 && masked[p] === '@';
    const line = offsetToLine(lineStarts, m.index);
    classes.push({
      start: m.index,
      atStart: isAnnotationType ? p : undefined,
      name: m[2],
      kind: m[1],
      isAnnotationType,
      line,
      depth: lineDepth[line],
    });
  }
  return classes;
}

/** 取某条注解在声明链里的起始偏移；@interface 要从 @ 开始算（否则 public @ 不算"修饰符+空白"） */
function classDeclStart(cls) {
  return cls && cls.atStart !== undefined ? cls.atStart : (cls ? cls.start : 0);
}

/** 判断两个位置之间是否只有修饰符/空白（用来判断注解属于谁） */
function isAttachGap(gap) {
  if (!gap || !gap.trim()) return true;
  const tokens = gap.trim().split(/\s+/);
  return tokens.every((t) => MODIFIER_RE.test(t));
}

/** 取紧贴在某个声明前面的注解链 */
function attachedAnnotations(annotations, declStart, masked) {
  const chain = [];
  let pos = declStart;
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (a.start >= pos) continue;
    if (a.end > pos) break;
    const gap = masked.slice(a.end, pos);
    if (!isAttachGap(gap)) break;
    chain.unshift(a);
    pos = a.start;
  }
  return chain;
}

/** 某个偏移所属的类（按大括号深度找最近的一层） */
function findEnclosingClass(classes, offset, lineStarts, lineDepth) {
  const line = offsetToLine(lineStarts, offset);
  const depth = lineDepth[line];
  let best = null;
  for (const c of classes) {
    if (c.start >= offset) continue;
    const cd = lineDepth[c.line];
    if (cd >= depth) continue;
    if (!best || cd > best.depth || (cd === best.depth && c.start > best.start)) {
      best = { start: c.start, name: c.name, kind: c.kind, line: c.line, depth: cd };
    }
  }
  return best;
}

/** 从注解结束位置往后找声明头（到 { 或 ; 或 = 为止） */
function declarationHead(masked, from) {
  let i = from;
  while (i < masked.length) {
    const c = masked[i];
    if (c === '{' || c === ';' || c === '=' || c === '}') break;
    i++;
  }
  return { head: masked.slice(from, i), start: from, end: i };
}

/** 从声明头里取方法名 */
function methodNameFromHead(head) {
  const close = head.lastIndexOf(')');
  if (close === -1) return null;
  let depth = 0;
  let open = -1;
  for (let i = close; i >= 0; i--) {
    const c = head[i];
    if (c === ')') depth++;
    else if (c === '(') {
      depth--;
      if (depth === 0) { open = i; break; }
    }
  }
  if (open === -1) return null;
  const before = head.slice(0, open);
  const m = /([A-Za-z_$][\w$]*)\s*$/.exec(before);
  return m ? m[1] : null;
}

/** 按顶层分隔符切分（忽略括号/花括号/中括号内的分隔符） */
function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let cur = '';
  let inStr = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      cur += ch;
      if (ch === '\\') { cur += text[i + 1] || ''; i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; cur += ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[' || ch === '<') depth++;
    if (ch === ')' || ch === '}' || ch === ']' || ch === '>') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** Java 字符串转义还原 */
function unescapeJava(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (all, esc) => {
    if (esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16));
    switch (esc) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case '"': return '"';
      case "'": return "'";
      case '\\': return '\\';
      default: return esc;
    }
  });
}

/** 去掉最外层成对括号 */
function stripOuterParens(expr) {
  let s = expr.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let ok = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') {
        depth--;
        if (depth === 0 && i !== s.length - 1) { ok = false; break; }
      }
    }
    if (!ok) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * 求字符串表达式（支持字面量、常量、常量拼接）
 * @returns {string|undefined} undefined 表示解析不出来
 */
function evaluateStringExpression(expr, constants, depth = 0) {
  if (expr === undefined || expr === null || depth > 6) return undefined;
  let e = stripOuterParens(String(expr).replace(/\/\/.*$/, '').trim());
  if (!e) return undefined;
  const lit = /^"((?:[^"\\]|\\.)*)"$/.exec(e);
  if (lit) return unescapeJava(lit[1]);
  const chLit = /^'((?:[^'\\]|\\.)*)'$/.exec(e);
  if (chLit) return unescapeJava(chLit[1]);
  // 纯标识符（可能是常量）
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(e)) {
    const simple = e.split('.').pop();
    if (Object.prototype.hasOwnProperty.call(constants, simple)) return constants[simple];
    return undefined;
  }
  // 字符串拼接
  const parts = splitTopLevel(e, '+');
  if (parts.length > 1) {
    let out = '';
    for (const p of parts) {
      const v = evaluateStringExpression(p, constants, depth + 1);
      if (v === undefined) return undefined;
      out += v;
    }
    return out;
  }
  return undefined;
}

/** 提取文件里的 String 常量（静态常量优先） */
function extractConstants(masked, original) {
  const constants = {};
  const re = /\bString\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g;
  let m;
  const pending = [];
  while ((m = re.exec(original)) !== null) {
    const name = m[1];
    const rawSlice = m[0];
    // 用屏蔽后的代码校验：声明确实在代码里而不是注释里
    const maskedSlice = masked.slice(m.index, m.index + rawSlice.length);
    if (!/\bString\b/.test(maskedSlice) || !maskedSlice.includes('=')) continue;
    const isStaticFinal = /\bstatic\b/.test(maskedSlice) && /\bfinal\b/.test(maskedSlice);
    pending.push({ name, value: m[2], strong: isStaticFinal });
  }
  for (const c of pending) {
    const v = evaluateStringExpression(c.value, constants);
    if (v === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(constants, c.name) || c.strong) constants[c.name] = v;
  }
  return constants;
}

/** RequestMethod.XXX */
function extractRequestMethods(argsText) {
  const out = [];
  if (!argsText) return out;
  const re = /RequestMethod\.([A-Z]+)/g;
  let m;
  while ((m = re.exec(argsText)) !== null) out.push(m[1]);
  return out;
}

/**
 * 从注解参数里取路径。
 * @param {string} argsText 注解括号里的原文
 * @param {object} constants 文件内 String 常量
 * @param {string[]} [pathAttributes] 认哪些属性名是路径，默认 value/path/url/uri
 * @returns {{paths: string[], known: boolean}}
 */
function extractPaths(argsText, constants, pathAttributes) {
  const result = { paths: [], known: true };
  if (argsText === undefined || argsText === null) return result;
  const args = argsText.trim();
  if (!args) return result;
  const attrs = pathAttributes && pathAttributes.length ? pathAttributes : DEFAULT_PATH_ATTRIBUTES;

  let target = null;
  const named = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*=/.exec(args);
  if (named) {
    if (attrs.includes(named[1])) {
      // 命中了路径属性，例如 value = "/a", method = ...
      target = args.slice(named.index + named[0].length);
    } else {
      // 第一个具名参数不是路径属性：看它前面有没有位置参数（@X("/a", topic = "t")）
      const before = args.slice(0, named.index).replace(/,\s*$/, '').trim();
      if (!before) return result;
      target = before;
    }
  } else {
    target = args;
  }

  const first = splitTopLevel(target, ',')[0].trim();
  let items;
  if (first.startsWith('{')) {
    const inner = first.replace(/^\{/, '').replace(/\}\s*$/, '');
    items = splitTopLevel(inner, ',');
  } else {
    items = [first];
  }
  for (const raw of items) {
    if (!raw.trim()) continue;
    const v = evaluateStringExpression(raw, constants);
    if (v === undefined) {
      result.known = false;
      continue;
    }
    result.paths.push(v);
  }
  if (!result.paths.length) result.known = false;
  return result;
}

/** 取紧贴在类声明前的 mapping 注解 */
function attachedMappingAnnotation(annotations, declStart, masked, registry) {
  const chain = attachedAnnotations(annotations, declStart, masked);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (registry[chain[i].name]) return chain[i];
  }
  return null;
}

/**
 * 跳过紧跟其后的其它注解（@ApiOperation、@PreAuthorize...），
 * 否则 @ApiOperation(value = "x") 里的 = 会截断方法签名，导致方法名识别不出来。
 */
function skipForwardAnnotations(annotations, from, masked) {
  let pos = from;
  for (const a of annotations) {
    if (a.start < pos) continue;
    if (a.end <= pos) continue;
    if (masked.slice(pos, a.start).trim()) break; // 中间还有别的代码，说明注解链结束
    pos = a.end;
  }
  return pos;
}

/**
 * 识别"组合注解"：某个自定义注解自己标了 Spring 映射注解，例如
 *
 *   @PostMapping
 *   public @interface AjaxPostMapping { String value() default ""; }
 *
 * 就把 AjaxPostMapping 也当成映射注解，并继承 @PostMapping 的动词（POST）。
 * 支持链式（自定义注解标在另一个自定义注解上），迭代到不动点。
 * 注意：自定义注解本身不带 @RequestMapping 之类的元注解时（例如框架自带的 ZmqRequestMapping），
 * 这里识别不到，需要用配置 springApi.extraMappingAnnotations 显式声明。
 */
function discoverComposedAnnotations(masked, annotations, classes, registry, constants, pathAttributes) {
  const found = [];
  const local = Object.assign({}, registry);
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (const cls of classes) {
      if (!cls.isAnnotationType || !cls.name || local[cls.name]) continue;
      const declStart = cls.atStart === undefined ? cls.start : cls.atStart;
      const chain = attachedAnnotations(annotations, declStart, masked);
      let meta = null;
      for (let i = chain.length - 1; i >= 0; i--) {
        if (local[chain[i].name]) {
          meta = chain[i];
          break;
        }
      }
      if (!meta) continue;
      const entry = local[meta.name];
      const methods = entry.methods && entry.methods.length
        ? entry.methods.slice()
        : extractRequestMethods(meta.argsText);
      const metaPaths = extractPaths(meta.argsText, constants, pathAttributes);
      const info = {
        name: cls.name,
        methods,
        basePaths: metaPaths.paths.length ? metaPaths.paths : undefined,
        via: meta.name,
        line: cls.line,
      };
      local[cls.name] = { methods: info.methods, basePaths: info.basePaths };
      found.push(info);
      changed = true;
    }
    if (!changed) break;
  }
  return found;
}

/**
 * 解析一个 Java/Kotlin 文件
 * @param {string} text
 * @param {object} [options]
 * @param {object} [options.mappingAnnotations] 额外认哪些注解是映射注解，{Name:{methods,basePaths}}
 * @param {string[]} [options.pathAttributes] 认哪些属性名是路径
 * @param {boolean} [options.discoverComposed] 是否自动识别组合注解，默认 true
 * @returns {{endpoints: Array, classCount: number, discovered: Array, annotationNames: string[]}}
 */
function parseJavaFile(text, options) {
  const opts = options || {};
  const endpoints = [];
  const base = { endpoints, classCount: 0, discovered: [], annotationNames: [] };
  if (!text || !text.includes('@')) return base;

  const registry = Object.assign({}, MAPPING_ANNOTATIONS, normalizeRegistry(opts.mappingAnnotations));
  const pathAttributes = opts.pathAttributes && opts.pathAttributes.length
    ? opts.pathAttributes
    : DEFAULT_PATH_ATTRIBUTES;

  const masked = maskCode(text);
  const lineStarts = computeLineStarts(text);
  const lineDepth = computeLineDepth(masked, lineStarts);
  const annotations = findAnnotations(masked, text);
  if (!annotations.length) return base;
  const classes = findClassDeclarations(masked, lineStarts, lineDepth);
  const constants = extractConstants(masked, originalOf(text));
  const annotationNames = [...new Set(annotations.map((a) => a.name))];

  // 自动识别本文件里定义的组合注解，并让本文件随后的解析就能用上
  const discovered = opts.discoverComposed === false
    ? []
    : discoverComposedAnnotations(masked, annotations, classes, registry, constants, pathAttributes);
  for (const d of discovered) {
    if (!registry[d.name]) registry[d.name] = { methods: d.methods, basePaths: d.basePaths };
  }

  // 挂在类上的注解（如类级 @RequestMapping）不能当成接口方法
  const classLevelAnnotationStarts = new Set();
  const classChainCache = new Map();
  const chainOfClass = (cls) => {
    if (classChainCache.has(cls.start)) return classChainCache.get(cls.start);
    const chain = attachedAnnotations(annotations, classDeclStart(cls), masked);
    classChainCache.set(cls.start, chain);
    for (const a of chain) classLevelAnnotationStarts.add(a.start);
    return chain;
  };
  for (const c of classes) chainOfClass(c);

  const classBaseCache = new Map();
  /** 类（含父类）路径链 */
  const classBasePaths = (cls) => {
    if (!cls) return { paths: [], known: true };
    if (classBaseCache.has(cls.start)) return classBaseCache.get(cls.start);
    const result = { paths: [], known: true };
    // 先算父类
    const parent = findEnclosingClass(classes, cls.start, lineStarts, lineDepth);
    if (parent) {
      const pr = classBasePaths(parent);
      if (pr.known) result.paths.push(...pr.paths);
      else result.known = false;
    }
    const ann = attachedMappingAnnotation(annotations, classDeclStart(cls), masked, registry);
    if (ann) {
      const r = extractPaths(ann.argsText, constants, pathAttributes);
      const entry = registry[ann.name];
      const metaBases = entry && entry.basePaths && entry.basePaths.length ? entry.basePaths : null;
      if (!r.known) {
        result.known = false;
      } else if (metaBases) {
        // 组合注解自带固定路径（如 @RequestMapping("/ajax") @interface AjaxBaseMapping）
        const own = r.paths.length ? r.paths : [''];
        for (const mb of metaBases) {
          for (const p of own) result.paths.push(joinRawPathForParser(mb, p));
        }
      } else {
        result.paths.push(...r.paths);
      }
    }
    classBaseCache.set(cls.start, result);
    return result;
  };

  for (const a of annotations) {
    const mapping = registry[a.name];
    if (!mapping) continue;
    if (classLevelAnnotationStarts.has(a.start)) continue; // 类级注解，跳过

    const annLine = offsetToLine(lineStarts, a.start);
    const cls = findEnclosingClass(classes, a.start, lineStarts, lineDepth);
    const baseRes = classBasePaths(cls);

    const methodPaths = extractPaths(a.argsText, constants, pathAttributes);
    let httpMethods = mapping.methods && mapping.methods.length
      ? mapping.methods.slice()
      : extractRequestMethods(a.argsText);
    if (!httpMethods.length) httpMethods = ['ANY'];

    // @ApiOperation(value="x") 这类注解会被跳过，保证方法名能取到
    const head = declarationHead(masked, skipForwardAnnotations(annotations, a.end, masked));
    const methodName = methodNameFromHead(head.head);
    const signature = head.head.replace(/\s+/g, ' ').trim();
    const methodLine = methodName
      ? offsetToLine(lineStarts, head.start + Math.max(0, head.head.lastIndexOf(methodName)))
      : annLine;

    // 常量解析不出来时用 ** 兜底，保证还能按剩余片段搜到
    const prefixList = baseRes.known ? (baseRes.paths.length ? baseRes.paths : ['']) : ['**'];
    const annBases = baseRes.known && mapping.basePaths && mapping.basePaths.length
      ? mapping.basePaths
      : [''];
    const methodList = methodPaths.known ? (methodPaths.paths.length ? methodPaths.paths : ['']) : ['**'];

    const seen = new Set();
    for (const b of prefixList) {
      for (const ab of annBases) {
        for (const mp of methodList) {
          const rawPath = joinRawPathForParser(joinRawPathForParser(b, ab), mp);
          if (seen.has(rawPath)) continue;
          seen.add(rawPath);
          endpoints.push({
            className: cls ? cls.name : '',
            classNameLine: cls ? cls.line : annLine,
            methodName: methodName || '(未知)',
            annotation: a.name,
            httpMethods,
            rawPath,
            classPath: b,
            annotationPath: ab,
            methodPath: mp,
            pathKnown: baseRes.known && methodPaths.known,
            line: annLine,
            character: a.start - lineStarts[annLine],
            methodLine,
            signature,
          });
        }
      }
    }
  }
  return { endpoints, classCount: classes.length, discovered, annotationNames };
}

/** 简化版路径拼接（避免循环依赖 pathMatcher） */
function joinRawPathForParser(base, sub) {
  const parts = [];
  for (const p of [base, sub]) {
    if (p === undefined || p === null) continue;
    const s = String(p).trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (s) parts.push(s);
  }
  return '/' + parts.join('/');
}

/** 保留原始文本（供常量提取使用，便于读取字符串值） */
function originalOf(text) {
  return text;
}

module.exports = {
  MAPPING_ANNOTATIONS,
  BUILTIN_MAPPINGS,
  DEFAULT_PATH_ATTRIBUTES,
  normalizeRegistry,
  parseMappingAnnotationSpec,
  maskCode,
  parseJavaFile,
  discoverComposedAnnotations,
  extractPaths,
  evaluateStringExpression,
  extractConstants,
  splitTopLevel,
  findAnnotations,
  findClassDeclarations,
};
