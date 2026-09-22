'use strict';
/**
 * 路径归一化 + 模糊匹配
 *
 * 解决的核心问题：
 *   前端写的是  /kxgdnl/WJDetail
 *   后端写成了 类上 @RequestMapping("/kxgdnl") + 方法上 @GetMapping("/WJDetail")
 *   全文搜索整串永远搜不到，这里把两边都归一化后做"带容错"的匹配。
 */

/** 匹配得分档位（越高越可信） */
const SCORE = {
  EXACT: 1000,          // 完全相同
  EXACT_CI: 990,        // 忽略大小写相同
  PREFIX_STRIPPED: 975, // 去掉网关/context-path 前缀后相同
  TEMPLATE: 930,        // 含 * / {id} 之类的通配匹配
  SUFFIX: 860,          // 接口路径是候选路径的后缀（前端只写了后半截）
  CONTAINS: 700,        // 包含关系
  SEGMENTS: 520,        // 各段按顺序出现（非连续）
  FUZZY: 330,           // 字符子序列
};

/**
 * 归一化路径：去引号、去 http://host、去 ?query#hash、占位符统一成 *、合并斜杠。
 * @param {string} input
 * @returns {string} 以 / 开头（根路径为 '/'）的路径
 */
function normalizePath(input) {
  if (input === undefined || input === null) return '';
  let s = String(input).trim();
  if (!s) return '';
  // 去掉首尾引号（可能从代码里选中的是 '/xxx' 或 `/xxx`）
  s = s.replace(/^[`'"]+/, '').replace(/[`'"]+$/, '').trim();
  // 去掉协议 + 主机 + 端口
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, '');
  // 去掉 query / hash
  s = s.replace(/[?#].*$/, '');
  // 各类占位符统一成 *：${id} / {{id}} / {id}
  s = s.replace(/\$\{[^}]*\}/g, '*');
  s = s.replace(/\{\{[^}]*\}\}/g, '*');
  s = s.replace(/\{[^}]*\}/g, '*');
  // Vue/Express 风格的 :id -> *
  s = s.replace(/(^|\/):[A-Za-z_$][\w$]*/g, '$1*');
  // 合并重复斜杠
  s = s.replace(/\/{2,}/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  // 去掉一前一后的空白（例如 /a b 这种误选）
  return s.trim() || '/';
}

/** 拼接类路径与方法路径（保留占位符原样，供展示） */
function joinPaths(...parts) {
  const segs = [];
  for (const p of parts) {
    if (p === undefined || p === null) continue;
    let s = String(p).trim();
    if (!s) continue;
    s = s.replace(/^\/+/, '').replace(/\/+$/, '');
    if (s) segs.push(s);
  }
  const joined = segs.join('/').replace(/\/{2,}/g, '/');
  return '/' + joined;
}

/**
 * 拆成路径段（不含前导斜杠）。'/' -> []
 * 注意：这里假设已经过 normalizePath
 */
function splitSegments(path) {
  if (!path || path === '/') return [];
  return path.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
}

/** 通配段 -> 正则片段 */
function segmentToRegexSource(seg) {
  return seg
    .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
}

/** 单个路径段匹配（支持 * 通配、大小写不敏感） */
function segmentMatches(candSeg, querySeg) {
  if (candSeg === querySeg) return true;
  if (candSeg.toLowerCase() === querySeg.toLowerCase()) return true;
  if (candSeg === '*' || candSeg === '**' || querySeg === '*' || querySeg === '**') return true;
  try {
    if (candSeg.includes('*')) {
      if (new RegExp('^' + segmentToRegexSource(candSeg) + '$', 'i').test(querySeg)) return true;
    }
    if (querySeg.includes('*')) {
      if (new RegExp('^' + segmentToRegexSource(querySeg) + '$', 'i').test(candSeg)) return true;
    }
  } catch (e) {
    return false;
  }
  return false;
}

/**
 * 模板段序列匹配查询段序列。
 * ** 可以吞掉任意多段（用于"路径里含常量、无法解析"的兜底）。
 */
function segmentsMatchTemplate(candSegs, querySegs) {
  let i = 0;
  let j = 0;
  while (i < candSegs.length && j < querySegs.length) {
    const c = candSegs[i];
    if (c === '**') {
      if (i === candSegs.length - 1) return true;
      for (let k = j; k <= querySegs.length; k++) {
        if (segmentsMatchTemplate(candSegs.slice(i + 1), querySegs.slice(k))) return true;
      }
      return false;
    }
    if (!segmentMatches(c, querySegs[j])) return false;
    i++;
    j++;
  }
  while (i < candSegs.length && candSegs[i] === '**') i++;
  return i === candSegs.length && j === querySegs.length;
}

/** 查询的每一段按顺序出现在候选路径里（允许中间插别的段） */
function orderedSegmentsIncluded(candSegs, querySegs) {
  if (!querySegs.length) return false;
  let i = 0;
  for (const qs of querySegs) {
    let found = false;
    while (i < candSegs.length) {
      const cur = candSegs[i];
      i++;
      if (segmentMatches(cur, qs)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/** 字符级子序列匹配（最后一档兜底） */
function fuzzyScore(candLower, queryLower) {
  if (!queryLower) return 0;
  let i = 0;
  for (const ch of queryLower) {
    if (ch === ' ' || ch === '/') continue;
    const idx = candLower.indexOf(ch, i);
    if (idx === -1) return 0;
    i = idx + 1;
  }
  return SCORE.FUZZY;
}

/**
 * 给「候选接口路径」对「用户输入」打分。
 * @param {string} candidatePath 后端拼出来的接口路径（可含 {id}、**）
 * @param {string} queryPath 用户输入（前端代码里的路径）
 * @param {string[]} prefixes 需要忽略的前缀，如 context-path、网关前缀
 * @returns {number} 0 表示不匹配
 */
function scoreMatch(candidatePath, queryPath, prefixes = []) {
  const c = normalizePath(candidatePath);
  const q = normalizePath(queryPath);
  if (!c || !q) return 0;
  if (c === q) return SCORE.EXACT;
  const cl = c.toLowerCase();
  const ql = q.toLowerCase();
  if (cl === ql) return SCORE.EXACT_CI;

  // 网关 / context-path 前缀：前端 URL 里带着它，而 Controller 的映射通常不带。
  // 两个方向都试一次，避免前端 baseURL 里配了前缀、代码里又写了一遍的情况。
  for (const p of prefixes) {
    const rp = normalizePath(p);
    if (!rp || rp === '/' || rp === cl || rp === ql) continue;
    if (ql.startsWith(rp + '/') && cl === ql.slice(rp.length)) return SCORE.PREFIX_STRIPPED;
    if (cl.startsWith(rp + '/') && ql === cl.slice(rp.length)) return SCORE.PREFIX_STRIPPED;
  }

  const cSegs = splitSegments(c);
  const qSegs = splitSegments(q);
  if (qSegs.length && segmentsMatchTemplate(cSegs, qSegs)) return SCORE.TEMPLATE;
  if (ql.length > 1 && cl.endsWith(ql)) return SCORE.SUFFIX;
  if (ql.length > 1 && cl.includes(ql)) return SCORE.CONTAINS;
  if (qSegs.length && orderedSegmentsIncluded(cSegs, qSegs)) return SCORE.SEGMENTS;
  return fuzzyScore(cl, ql);
}

/** 通配符越多越不可信，用于排序时降权 */
function wildcardPenalty(path) {
  if (!path) return 0;
  const m = path.match(/\*/g);
  return m ? m.length : 0;
}

/** 判断一段文本像不像接口路径（用来决定要不要给 Ctrl+点击 / 悬停提示） */
function isProbablyPath(text) {
  if (!text) return false;
  const s = String(text).trim();
  if (s.length < 2 || s.length > 500) return false;
  if (/\s/.test(s)) return false;
  if (!/[A-Za-z\u4e00-\u9fa5]/.test(s)) return false;
  if (!s.includes('/')) return false;
  // 前端别名 / 相对路径，不是接口
  if (/^(\.{1,2}\/|~\/|@\/|#)/.test(s)) return false;
  // 静态资源
  if (/\.(png|jpe?g|gif|svg|webp|css|less|scss|sass|woff2?|ttf|eot|ico|mp4|mp3|pdf|zip)$/i.test(s)) return false;
  // 纯 import 路径（没有协议头也不是 / 开头的一般不是接口，除非能匹配上，交给调用方判断）
  return true;
}

/**
 * 判断文件路径是否命中排除 glob（用于文件监听时挡住 target/ 这类目录）。
 * 只做"目录名/文件名片段"级别的判断，够用且不依赖 VS Code 的 glob 实现。
 * @param {string} fsPath
 * @param {string[]} globs 例如 ['**\/target/**', '**\/generated/**']
 */
function isExcludedPath(fsPath, globs) {
  if (!fsPath) return false;
  const p = '/' + String(fsPath).replace(/\\/g, '/').toLowerCase() + '/';
  for (const glob of globs || []) {
    const core = String(glob)
      .replace(/\*\*\//g, '')
      .replace(/\/\*\*$/g, '')
      .replace(/\*\*/g, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (!core) continue;
    if (p.includes('/' + core + '/')) return true;
  }
  return false;
}

module.exports = {
  SCORE,
  normalizePath,
  joinPaths,
  splitSegments,
  segmentMatches,
  segmentsMatchTemplate,
  scoreMatch,
  wildcardPenalty,
  isProbablyPath,
  isExcludedPath,
};
