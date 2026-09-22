'use strict';
/**
 * 无依赖自测脚本：node test/run-tests.js
 * 覆盖：注解解析、常量拼接、多行注解、嵌套类、路径匹配打分
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseJavaFile } = require('../src/springParser');
const { scoreMatch, normalizePath, isProbablyPath, isExcludedPath, SCORE } = require('../src/pathMatcher');
const { EndpointIndex } = require('../src/endpointIndex');

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

function pathsOf(text) {
  return parseJavaFile(text).endpoints.map((e) => `${e.httpMethods.join('|')} ${e.rawPath}`);
}

console.log('\n[1] 基础：类路径 + 方法路径（就是你的 /kxgdnl/WJDetail 场景）');
const basic = `
package com.demo;

@RestController
@RequestMapping("/kxgdnl")
public class WjController {

    @GetMapping("/WJDetail")
    public Object wjDetail(@RequestParam String id) {
        return null;
    }
}
`;
test('拼出 /kxgdnl/WJDetail', () => {
  const list = pathsOf(basic);
  assert.deepStrictEqual(list, ['GET /kxgdnl/WJDetail']);
});
test('记录类名/方法名/行号', () => {
  const ep = parseJavaFile(basic).endpoints[0];
  assert.strictEqual(ep.className, 'WjController');
  assert.strictEqual(ep.methodName, 'wjDetail');
  assert.strictEqual(ep.line, 7);
  assert.strictEqual(ep.methodLine, 8);
});
test('类级 @RequestMapping 不会自己变成接口', () => {
  assert.strictEqual(parseJavaFile(basic).endpoints.length, 1);
});

console.log('\n[2] 参数写法');
const variants = `
@RestController
@RequestMapping(value = "/a", method = RequestMethod.POST)
class A {
    @PostMapping(path = "/b")
    void b() {}

    @RequestMapping(value = {"/c", "/d"}, method = {RequestMethod.GET, RequestMethod.POST})
    void cd() {}

    @GetMapping({"/e", "/f"})
    void ef() {}

    @GetMapping("g")
    void g() {}

    @GetMapping
    void noPath() {}
}
`;
test('value=/path=/数组/无前导斜杠/无路径', () => {
  const list = pathsOf(variants);
  assert.deepStrictEqual(list, [
    'POST /a/b',
    'GET|POST /a/c',
    'GET|POST /a/d',
    'GET /a/e',
    'GET /a/f',
    'GET /a/g',
    'GET /a',
  ]);
});

console.log('\n[3] →String 常量拼接');
const consts = `
@RestController
class C {
    private static final String PREFIX = "/kxgdnl";
    public static final String WJ = "/WJDetail";

    @GetMapping(PREFIX + WJ)
    Object a() { return null; }

    @GetMapping(PREFIX + "/list")
    Object b() { return null; }

    @GetMapping(OtherConst.UNKNOWN)
    Object c() { return null; }
}
`;
test('常量识别与拼接', () => {
  const list = pathsOf(consts);
  assert.deepStrictEqual(list, ['GET /kxgdnl/WJDetail', 'GET /kxgdnl/list', 'GET /**']);
});
test('解析不出来的常量标为 pathKnown=false', () => {
  const ep = parseJavaFile(consts).endpoints[2];
  assert.strictEqual(ep.pathKnown, false);
});

console.log('\n[4] 多行注解 / 注解与签名同行 / 嵌套类 / 注释里的假注解');
const tricky = `
/**
 * @RequestMapping("/fake")
 */
@RestController
@RequestMapping(
    value = "/outer",
    produces = "application/json"
)
public class Outer {

    // @GetMapping("/commented")
    @GetMapping(
        "/multi"
    )
    public void multi() {}

    @GetMapping("/same") public void sameLine() {}

    public static class Inner {
        @GetMapping("/nested")
        public void nested() {}
    }
}
`;
test('多行注解 + 同行 + 嵌套类，且忽略注释', () => {
  const list = pathsOf(tricky);
  assert.deepStrictEqual(list, ['GET /outer/multi', 'GET /outer/same', 'GET /outer/nested']);
});

console.log('\n[5] 真实项目 testApi（如果存在）');
const realDir = path.join(__dirname, '..', '..', 'testApi', 'src', 'main', 'java', 'com', 'testapi', 'controller');
if (fs.existsSync(realDir)) {
  for (const f of fs.readdirSync(realDir).filter((x) => x.endsWith('.java'))) {
    const text = fs.readFileSync(path.join(realDir, f), 'utf8');
    const list = pathsOf(text);
    test(`${f} -> ${list.length} 个接口`, () => {
      assert.ok(list.length > 0, '应该解析出接口');
    });
    console.log('      ' + list.join('\n      '));
  }
} else {
  console.log('  (跳过：未找到 testApi 项目)');
}

console.log('\n[6] 路径匹配（前端串 -> 后端拼接串）');
test('完全一致', () => {
  assert.strictEqual(scoreMatch('/kxgdnl/WJDetail', '/kxgdnl/WJDetail'), SCORE.EXACT);
});
test('大小写不一致也算', () => {
  assert.strictEqual(scoreMatch('/kxgdnl/WJDetail', '/KXGDNL/wjdetail'), SCORE.EXACT_CI);
});
test('前端带 context-path 前缀（Controller 映射里没有）', () => {
  assert.strictEqual(scoreMatch('/sql/execute', '/api/sql/execute', ['/api']), SCORE.PREFIX_STRIPPED);
});
test('反向：Controller 映射里带前缀、前端没带', () => {
  assert.strictEqual(scoreMatch('/api/sql/execute', '/sql/execute', ['/api']), SCORE.PREFIX_STRIPPED);
});
test('前端只写后半截（baseURL 里配了前缀）', () => {
  assert.strictEqual(scoreMatch('/api/sql/execute', '/sql/execute'), SCORE.SUFFIX);
});
test('完整 URL 也能匹配', () => {
  assert.strictEqual(scoreMatch('/api/sql/execute', 'http://192.168.0.1:8002/api/sql/execute'), SCORE.EXACT);
});
test('模板变量 {id} / ${id} / :id 互通', () => {
  assert.ok(scoreMatch('/api/user/{id}', '/api/user/${id}') >= SCORE.TEMPLATE);
  assert.ok(scoreMatch('/api/user/{id}', '/api/user/123') >= SCORE.TEMPLATE);
  assert.ok(scoreMatch('/api/user/{id}', '/api/user/:id') >= SCORE.TEMPLATE);
});
test('常量没解析出来（**）也能搜到', () => {
  assert.ok(scoreMatch('/kxgdnl/**', '/kxgdnl/WJDetail') >= SCORE.TEMPLATE);
});
test('无关路径不匹配', () => {
  assert.strictEqual(scoreMatch('/api/sql/execute', '/other/thing'), 0);
});
test('normalizePath 去 query/hash/引号', () => {
  assert.strictEqual(normalizePath("'/api/sql/execute?id=1#x'"), '/api/sql/execute');
});

console.log('\n[7] 索引全流程（模拟前端实际写法）');
const FIXTURE = path.join(__dirname, 'fixtures', 'demo');

function makeDiskHost(roots) {
  const all = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else all.push(p);
    }
  };
  roots.forEach((r) => fs.existsSync(r) && walk(r));
  const toFile = (f) => ({ key: 'file:///' + f.replace(/\\/g, '/'), fsPath: f, display: f });
  return {
    findJavaFiles: async () => all.filter((f) => /\.(java|kt)$/.test(f)).map(toFile),
    findConfigFiles: async () => all.filter((f) => /application.*\.(ya?ml|properties)$/.test(f)).map(toFile),
    readText: async (file) => fs.readFileSync(file.fsPath, 'utf8'),
    relativePath: (fsPath) => path.relative(process.cwd(), fsPath).split(path.sep).join('/'),
  };
}

(async () => {
  const roots = [FIXTURE];
  if (fs.existsSync(realDir)) roots.push(path.dirname(realDir));
  const idx = new EndpointIndex(makeDiskHost(roots));
  await idx.rebuild();

  const top = (q) => {
    const m = idx.query(q);
    return m.length ? m[0].endpoint : null;
  };

  test('索引建立成功', () => {
    // 至少要有 fixtures 里的 4 个接口；如果同级目录有 testApi 项目会更多
    assert.ok(idx.size >= 4, `索引条目太少: ${idx.size}`);
  });
  test('自动识别 server.servlet.context-path = /gw', () => {
    assert.ok(idx.contextPaths.includes('/gw'), '未识别到 /gw: ' + JSON.stringify(idx.contextPaths));
  });
  test('前端 /gw/kxgdnl/WJDetail（带 context-path）-> 命中', () => {
    const ep = top('/gw/kxgdnl/WJDetail');
    assert.ok(ep, '没有命中');
    assert.strictEqual(ep.methodName, 'wjDetail');
  });
  test('前端 /kxgdnl/WJDetail -> 命中 KxgdnlController.wjDetail', () => {
    const ep = top('/kxgdnl/WJDetail');
    assert.strictEqual(ep.className, 'KxgdnlController');
    assert.strictEqual(ep.methodName, 'wjDetail');
    assert.strictEqual(ep.httpMethods.join('/'), 'GET');
  });
  test('只写后半段 WJDetail 也能命中', () => {
    const ep = top('WJDetail');
    assert.strictEqual(ep.methodName, 'wjDetail');
  });
  test('常量拼接 /kxgdnl/WJ/save -> 命中 save', () => {
    const ep = top('/kxgdnl/WJ/save');
    assert.strictEqual(ep.methodName, 'save');
  });
  test('模板路径 /kxgdnl/list/123 -> 命中 list', () => {
    const ep = top('/kxgdnl/list/123');
    assert.strictEqual(ep.methodName, 'list');
  });
  test('模板路径 /kxgdnl/list/${type} -> 命中 list', () => {
    const ep = top('/kxgdnl/list/${type}');
    assert.strictEqual(ep.methodName, 'list');
  });
  test('外部常量解析不出来时仍能被搜到（** 兜底）', () => {
    const ep = top('/kxgdnl/whatever/path');
    assert.strictEqual(ep.methodName, 'unknown');
    assert.strictEqual(ep.pathKnown, false);
  });
  test('真实项目 /api/sql/execute -> SqlController.executeSql', () => {
    const ep = top('/api/sql/execute');
    if (!ep) return; // testApi 不存在时跳过
    assert.strictEqual(ep.className, 'SqlController');
    assert.strictEqual(ep.methodName, 'executeSql');
  });
  test('真实项目 /sql/execute（前端只写后半段）-> 命中', () => {
    const ep = top('/sql/execute');
    if (!ep) return;
    assert.strictEqual(ep.className, 'SqlController');
  });
  test('entriesForFile 能按文件取到接口（CodeLens 用）', () => {
    const file = path.join(FIXTURE, 'KxgdnlController.java');
    assert.strictEqual(idx.entriesForFile(file).length, 4);
  });
  test('无关字符串不会乱匹配（isProbablyPath + query）', () => {
    assert.strictEqual(isProbablyPath('@/utils/request'), false);
    assert.strictEqual(isProbablyPath('/assets/logo.png'), false);
    assert.strictEqual(top('/some/totally/unrelated/thing'), null);
  });
  test('文件监听排除目录判断（target/ 里的编译产物不进索引）', () => {
    const globs = ['**/node_modules/**', '**/target/**', '**/generated/**'];
    assert.strictEqual(isExcludedPath('D:\\proj\\target\\classes\\A.java', globs), true);
    assert.strictEqual(isExcludedPath('D:\\proj\\src\\generated\\A.java', globs), true);
    assert.strictEqual(isExcludedPath('/home/u/proj/src/main/java/A.java', globs), false);
    assert.strictEqual(isExcludedPath('/home/u/proj/src/TargetHelper.java', globs), false);
  });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
