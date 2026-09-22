'use strict';
/**
 * 从一行前端代码里找出"光标所在的接口路径"。
 * 纯函数，不依赖 VS Code，方便单测。
 */

const { isProbablyPath } = require('./pathMatcher');

/** 找出一行里所有字符串/模板字面量的内容区间（不含引号本身） */
function stringRanges(lineText) {
  const ranges = [];
  let i = 0;
  while (i < lineText.length) {
    const ch = lineText[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const start = i;
      i++;
      while (i < lineText.length) {
        if (lineText[i] === '\\') { i += 2; continue; }
        if (lineText[i] === quote) break;
        i++;
      }
      ranges.push({ start: start + 1, end: Math.min(i, lineText.length), quote });
      i++;
      continue;
    }
    i++;
  }
  return ranges;
}

/**
 * 取偏移 col 处的接口路径文本。
 * 优先字符串字面量；不在字符串里时退化为"光标所在片段"。
 * @returns {string} '' 表示这里不像接口路径
 */
function findPathAt(lineText, col) {
  if (typeof lineText !== 'string' || !lineText) return '';
  for (const r of stringRanges(lineText)) {
    if (col >= r.start && col <= r.end) {
      const text = lineText.slice(r.start, r.end);
      return isProbablyPath(text) ? text : '';
    }
  }
  const re = /[A-Za-z0-9_\-/{}$.:*]+/g;
  let m;
  while ((m = re.exec(lineText)) !== null) {
    if (col >= m.index && col <= m.index + m[0].length) {
      return isProbablyPath(m[0]) ? m[0] : '';
    }
  }
  return '';
}

module.exports = { stringRanges, findPathAt };
