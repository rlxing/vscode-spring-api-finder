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

const MAPPING_ANNOTATIONS = {
  RequestMapping: [],
  GetMapping: ['GET'],
  PostMapping: ['POST'],
  PutMapping: ['PUT'],
  DeleteMapping: ['DELETE'],
  PatchMapping: ['PATCH'],
};

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

/** 找出类/接口/枚举声明 */
function findClassDeclarations(masked, lineStarts, lineDepth) {
  const classes = [];
  const re = /\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    // 排除 Xxx.class 这种字面量
    let p = m.index - 1;
    while (p >= 0 && /\s/.test(masked[p])) p--;
    if (p >= 0 && masked[p] === '.') continue;
    const line = offsetToLine(lineStarts, m.index);
    classes.push({ start: m.index, name: m[2], kind: m[1], line, depth: lineDepth[line] });
  }
  return classes;
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
 * @returns {{paths: string[], known: boolean}}
 */
function extractPaths(argsText, constants) {
  const result = { paths: [], known: true };
  if (argsText === undefined || argsText === null) return result;
  const args = argsText.trim();
  if (!args) return result;

  let target = null;
  const named = /(?:^|,)\s*(?:value|path)\s*=/.exec(args);
  if (named) {
    target = args.slice(named.index + named[0].length);
  } else {
    const firstTop = splitTopLevel(args, ',')[0].trim();
    const asNamed = /^([A-Za-z_$][\w$]*)\s*=/.exec(firstTop);
    if (asNamed && asNamed[1] !== 'value' && asNamed[1] !== 'path') return result;
    target = firstTop;
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
function attachedMappingAnnotation(annotations, declStart, masked) {
  const chain = attachedAnnotations(annotations, declStart, masked);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (MAPPING_ANNOTATIONS[chain[i].name]) return chain[i];
  }
  return null;
}

/**
 * 解析一个 Java/Kotlin 文件
 * @param {string} text
 * @returns {{endpoints: Array, classCount: number}}
 */
function parseJavaFile(text) {
  const endpoints = [];
  if (!text || !text.includes('@')) return { endpoints, classCount: 0 };

  const masked = maskCode(text);
  const lineStarts = computeLineStarts(text);
  const lineDepth = computeLineDepth(masked, lineStarts);
  const annotations = findAnnotations(masked, text);
  if (!annotations.length) return { endpoints, classCount: 0 };
  const classes = findClassDeclarations(masked, lineStarts, lineDepth);
  const constants = extractConstants(masked, originalOf(text));

  // 挂在类上的注解（如类级 @RequestMapping）不能当成接口方法
  const classLevelAnnotationStarts = new Set();
  const classChainCache = new Map();
  const chainOfClass = (cls) => {
    if (classChainCache.has(cls.start)) return classChainCache.get(cls.start);
    const chain = attachedAnnotations(annotations, cls.start, masked);
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
    const ann = attachedMappingAnnotation(annotations, cls.start, masked);
    if (ann) {
      const r = extractPaths(ann.argsText, constants);
      if (r.known) result.paths.push(...r.paths);
      else result.known = false;
    }
    classBaseCache.set(cls.start, result);
    return result;
  };

  for (const a of annotations) {
    const mappingMethods = MAPPING_ANNOTATIONS[a.name];
    if (!mappingMethods) continue;
    if (classLevelAnnotationStarts.has(a.start)) continue; // 类级注解，跳过

    const annLine = offsetToLine(lineStarts, a.start);
    const cls = findEnclosingClass(classes, a.start, lineStarts, lineDepth);
    const base = classBasePaths(cls);

    const methodPaths = extractPaths(a.argsText, constants);
    let httpMethods = mappingMethods.length ? mappingMethods.slice() : extractRequestMethods(a.argsText);
    if (!httpMethods.length) httpMethods = ['ANY'];

    const head = declarationHead(masked, a.end);
    const methodName = methodNameFromHead(head.head);
    const signature = head.head.replace(/\s+/g, ' ').trim();
    const methodLine = methodName
      ? offsetToLine(lineStarts, head.start + Math.max(0, head.head.lastIndexOf(methodName)))
      : annLine;

    // 常量解析不出来时用 ** 兜底，保证还能按剩余片段搜到
    const baseList = base.known ? (base.paths.length ? base.paths : ['']) : ['**'];
    const methodList = methodPaths.known ? (methodPaths.paths.length ? methodPaths.paths : ['']) : ['**'];

    const seen = new Set();
    for (const b of baseList) {
      for (const mp of methodList) {
        const rawPath = joinRawPathForParser(b, mp);
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
          methodPath: mp,
          pathKnown: base.known && methodPaths.known,
          line: annLine,
          character: a.start - lineStarts[annLine],
          methodLine,
          signature,
        });
      }
    }
  }
  return { endpoints, classCount: classes.length };
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
  maskCode,
  parseJavaFile,
  extractPaths,
  evaluateStringExpression,
  extractConstants,
  splitTopLevel,
  findAnnotations,
};
