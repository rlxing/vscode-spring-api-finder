# Spring 接口路径查找器（VS Code 插件）

[![CI](https://github.com/rlxing/vscode-spring-api-finder/actions/workflows/ci.yml/badge.svg)](https://github.com/rlxing/vscode-spring-api-finder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

解决一个很烦的问题：

```java
// 后端：路径被拆成两段，全文搜索 /kxgdnl/WJDetail 永远搜不到
@RestController
@RequestMapping("/kxgdnl")          // ← 类上一段
public class KxgdnlController {
    @GetMapping("/WJDetail")         // ← 方法上一段
    public Object wjDetail(String id) { ... }
}
```

```js
// 前端：写在字符串里
return request({ url: '/kxgdnl/WJDetail', method: 'get' })
```

用 VS Code 全局搜索 `Ctrl+Shift+F` 搜 `/kxgdnl/WJDetail` → **0 个结果**（只能删掉一段去搜 `WJDetail`，再人工翻）。
因为这两段在代码里从来不是一个字符串，任何"文本搜索"都不可能命中。

本插件把 Spring 注解解析成索引，**在内存里把两段拼起来**，于是前端那个字符串可以直接跳到后端方法。

---

## 一、装好后能干什么

| 场景 | 操作 | 效果 |
| --- | --- | --- |
| **不想记快捷键** | 点**左侧活动栏**的放大镜图标（`Spring 接口`） | 侧边栏列出所有接口，点一下接口就跳到 Controller 方法；图标上还有接口数量角标 |
| 前端看到 `/kxgdnl/WJDetail`，想看后端实现 | 选中它（或光标放在字符串里）按 **`Ctrl+Alt+F`** | 直接跳到 `KxgdnlController#wjDetail`；有多个匹配时弹列表 |
| 刚从前端复制了接口路径 | 按 **`Ctrl+Alt+F`**（或 `Ctrl+Alt+Shift+F`） | 输入框会自动预填剪贴板里的那条路径，直接回车即可 |
| 同上，更顺手的方式 | 光标放在 `'/kxgdnl/WJDetail'` 里按 **`F12`** 或 **`Ctrl+点击`** | 直接跳到对应的 `@GetMapping("/WJDetail")` 那一行 |
| 想先看看是什么接口 | 鼠标**悬停**在前端路径上 | 显示 `GET /kxgdnl/WJDetail`、类名#方法名、文件:行号 |
| 后端写完接口，想拿完整路径给前端 | Controller 方法上方点 **`$(clippy) GET /kxgdnl/WJDetail`**（CodeLens） | 完整路径复制到剪贴板（不用自己拼） |
| 改后端接口，想知道前端哪里在用 | Controller 方法上方点 **`前端调用`**（CodeLens） | 列出所有调用该接口的前端文件/行，选中即跳转 |
| 想浏览全部接口 | 命令面板 → `Spring 接口: 搜索接口路径` | 空输入即列出所有接口，可边打边过滤 |
| **项目用的是自定义注解**（如 `@ZmqRequestMapping`） | 设置 `springApi.extraMappingAnnotations` | 自定义注解的接口照样能搜索/跳转，无需改代码（详见[第六节](#六自定义注解zmqrequestmapping-这类怎么适配)） |

> 为什么不让 `Ctrl+Shift+F` 直接搜到？VS Code 不允许插件改动内置搜索的匹配算法（内置搜索是 ripgrep 逐行匹配）。
> 所以这里用"专用入口 + 定义跳转"来替代，并且比搜索更准（搜索结果还要人工分辨是哪个文件）。

---

## 二、左侧活动栏按钮（不用记快捷键）

点 VS Code **最左边活动栏**里的放大镜图标（鼠标悬停显示 `Spring 接口`），侧边栏会展开接口列表：

```
🔍 搜索接口路径…                      ← 点它 = 按 Ctrl+Alt+F
📦 KxgdnlController.java        4     ← 按 Controller 分组（点一下打开该文件）
    ↓ GET   /kxgdnl/WJDetail          ← 点一下跳到 @GetMapping 那一行
    ↑ POST  /kxgdnl/WJ/save           ← 悬停时右侧出现两个小按钮
    ↓ GET   /kxgdnl/list/{type}
    ↓ GET   /kxgdnl/**  ⚠
```

- **顶部工具栏按钮**：🔍 搜索接口路径、🔄 重建索引、折叠全部。
- **接口节点行内按钮**（鼠标悬停出现）：📋 复制完整路径、🔗 查找前端调用；右键菜单里也有。
- 活动栏图标上的**数字角标**就是当前索引到的接口数量。
- 索引还没建立时，侧边栏会显示欢迎页，里面有两个可点的按钮：`建立接口索引` / `直接搜索接口路径`；点开侧边栏也会自动触发一次索引。
- 想让它彻底占满一列，把侧边栏拖到想要的宽度即可；也可以用命令面板的 `视图: 切换侧边栏`。

---

## 三、安装

插件是**纯 JavaScript、零依赖、无需编译**，三种方式任选。

### 方式 1：直接复制目录（推荐，不用联网）

把 `vscode-spring-api-finder` 整个文件夹复制到 VS Code 扩展目录，并改名为 `spring-api-finder-0.0.1`：

```powershell
$dst = "$env:USERPROFILE\.vscode\extensions\spring-api-finder-0.0.1"
Copy-Item -Recurse -Force ".\vscode-spring-api-finder" $dst
# 然后完全退出并重新打开 VS Code
```

卸载就是删掉那个目录。

### 方式 2：打包成 vsix 再安装

```powershell
cd .\vscode-spring-api-finder
npx @vscode/vsce package           # 生成 spring-api-finder-0.0.1.vsix
code --install-extension .\spring-api-finder-0.0.1.vsix
```

### 方式 3：改代码调试（F5）

用 VS Code 打开 `vscode-spring-api-finder` 目录，按 **F5** 打开"扩展开发宿主"窗口，在里面打开你的项目即可。

### ⚠️ 用 Remote-SSH / 容器 / WSL 的话

插件必须在**代码所在的那一端**运行（要在那端读 Java 文件）。所以请在扩展面板里选择
`Install in SSH: 主机名`（或把 vsix 装到远端），而不是只装在本地 UI 端。

---

## 四、快捷键

| 快捷键 | 命令 |
| --- | --- |
| `Ctrl+Alt+F` / `Cmd+Alt+F` | 用选中文本（或输入框）搜索接口 |
| `Ctrl+Alt+Shift+F` / `Cmd+Alt+Shift+F` | 打开接口搜索框 |

也可以在编辑器里**右键 → Spring 接口**。快捷键不喜欢就到 `keybindings.json` 里改。

---

## 五、能匹配哪些"写法不一致"

前端和后端路径写法经常有差异，索引匹配做了容错（按可信度排序）：

| 前端写法 | 后端拼接结果 | 结果 |
| --- | --- | --- |
| `/kxgdnl/WJDetail` | `/kxgdnl/WJDetail` | ✅ 完全命中 |
| `/kxgdnl/wjdetail` | `/kxgdnl/WJDetail` | ✅ 忽略大小写 |
| `/gw/kxgdnl/WJDetail`（`/gw` 是 `server.servlet.context-path`） | `/kxgdnl/WJDetail` | ✅ 自动识别并忽略前缀 |
| `/sql/execute`（前缀配在 axios `baseURL` 里） | `/api/sql/execute` | ✅ 后缀命中 |
| `http://192.168.0.1:8002/api/sql/execute` | `/api/sql/execute` | ✅ 整条 URL 也能匹配 |
| `/kxgdnl/list/123` 或 `` `/kxgdnl/list/${type}` `` 或 `/kxgdnl/list/:type` | `/kxgdnl/list/{type}` | ✅ 路径变量互通 |
| `/kxgdnl/WJDetail?id=1#top` | `/kxgdnl/WJDetail` | ✅ 自动去掉 query/hash |
| `@/utils/request`、`/assets/logo.png` | — | ⛔ 不会误判成接口 |

支持的后端写法：
`@RequestMapping`（类/方法级）、`@GetMapping`、`@PostMapping`、`@PutMapping`、`@DeleteMapping`、`@PatchMapping`、
`value=`/`path=`、`{"/a","/b"}` 多路径、`method = RequestMethod.POST`、多行注解、注解与方法同行、嵌套类（路径叠加）、
`String` 常量拼接（`@RequestMapping(PREFIX + "/wj")`）、**自定义/组合注解（见下一节）**。

---

## 六、自定义注解（`ZmqRequestMapping` 这类）怎么适配

有些项目不用 Spring 注解，而是自己封了一套，例如：

```java
@ZmqRequestMapping("/AnalysisLsfsController")   // 类上：路径前缀
@ZmqController
@Api(value = "临时方式解析OCS全量文件")
public class AnalysisLsfsController {
    @ZmqRequestMapping("/analysisOcsLsfs")       // 方法上：路径
    @ApiOperation(value = "解析OCS全量文件")
    public R analysisOcsLsfs() { ... }
}
```

有两条适配路径，任选（也可以同时用）。

### 方式 A：显式配置（框架注解的源码不在你的工作区时用这个，最常用）

```jsonc
// settings.json
"springApi.extraMappingAnnotations": [
  "ZmqRequestMapping:ZMQ",                     // 冒号后是"动词标签"，可写 ZMQ / POST / 任意文字
  "ZmqPostMapping:POST",                       // 多个也行
  "com.dfe.kserver.annotation.OtherMapping"    // 支持全限定名（按最后一段匹配），不写动词则显示 ANY
]
```

改完这个配置插件会自动重建索引，之后 `ZMQ /AnalysisLsfsController/analysisOcsLsfs` 就能搜到了。

如果真实访问路径还带网关前缀（例如类注释里写的 `/kapi/json/...`），把它加进忽略前缀：

```jsonc
"springApi.ignorePrefixes": ["/kapi/json"],
"springApi.extraMappingAnnotations": ["ZmqRequestMapping:ZMQ"]
// 于是前端写的 /kapi/json/signalCheck/health 也能命中 ZMQ /signalCheck/health
```

### 方式 B：自动识别组合注解（注解源码就在工作区时，零配置）

若自定义注解自己标了 Spring 注解，插件扫源码时会自动认出来，并继承动词与固定路径：

```java
@PostMapping
public @interface AjaxPostMapping { String value() default ""; }   // -> POST

@RequestMapping("/ajax")
public @interface AjaxBaseMapping { }                              // -> 固定前缀 /ajax
```

于是 `@AjaxBaseMapping` + `@AjaxPostMapping("/submit")` 自动得到 `POST /ajax/submit`（跨文件也能识别）。
识别结果会打印在 **输出面板 → "Spring 接口查找"**（`[自动识别组合注解] ...`），排查时先看那里。
不想要这个行为：`"springApi.discoverComposedAnnotations": false`。

### 路径属性名不叫 `value`/`path`？

比如 `@ZmqRequestMapping(topic = "/x")`：

```jsonc
"springApi.pathAttributeNames": ["value", "path", "url", "uri", "topic"]
```

### 验证方法

仓库里带了真实形态的用例，直接跑：

```powershell
npm test
# test/fixtures/zmq/       —— ZmqRequestMapping（框架注解，走配置）
# test/fixtures/composed/  —— @PostMapping 组合注解（走自动识别）
```

还可以把**你自己机器上的真实项目**也纳入自测（可选，仓库里不写内部路径）：

```powershell
$env:SPRING_API_TEST_ROOTS       = "D:\proj\your-module"     # 多个用 ; 分隔
$env:SPRING_API_TEST_ANNOTATIONS = "ZmqRequestMapping:ZMQ"    # 逗号分隔
$env:SPRING_API_TEST_PREFIXES    = "/kapi/json"
npm test
```

它会校验：索引出的接口数量、是否每个都解析出了方法名、自定义注解是否真的匹配到了接口、带网关前缀能否命中。

---

## 七、配置项

设置里搜索 `springApi`：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `springApi.indexOnActivation` | `true` | 打开工作区时后台建立索引；超大仓库可关掉，改为首次使用时建立 |
| `springApi.exclude` | `[]` | 额外排除目录；已内置排除 `node_modules/target/build/out/dist/.git` |
| `springApi.ignorePrefixes` | `[]` | 匹配时忽略的路径前缀（网关前缀），如 `/gateway`；`context-path` 会自动识别 |
| `springApi.extraMappingAnnotations` | `[]` | **自定义映射注解**，如 `["ZmqRequestMapping:ZMQ"]`；冒号后是动词标签，也支持全限定名 |
| `springApi.pathAttributeNames` | `["value","path","url","uri"]` | 从注解参数里认哪些属性名是路径 |
| `springApi.discoverComposedAnnotations` | `true` | 自动识别被 Spring 注解标注过的 `@interface`（组合注解） |
| `springApi.enableDefinition` | `true` | 前端 `Ctrl+点击` / `F12` 跳转 |
| `springApi.enableHover` | `true` | 悬停显示后端接口 |
| `springApi.enableDocumentLink` | `false` | 给前端路径加可点击下划线链接 |
| `springApi.showCodeLens` | `true` | Controller 上方的"完整路径 / 前端调用"按钮 |
| `springApi.showStatusBar` | `true` | 右下角显示接口数量 |
| `springApi.autoOpenSingleMatch` | `true` | 只有一个匹配时直接跳，不弹选择框 |
| `springApi.openBeside` | `false` | 跳转时在侧边打开 Controller，保留前端文件可见 |

索引状态、忽略前缀、自定义注解使用情况、接口数量都会打印在**输出面板 → "Spring 接口查找"**，排查问题先看这里。

---

## 八、常见问题

**索引是 0 个接口？**
1. 命令面板执行 `Spring 接口: 重建接口索引`；
2. 确认 `@RequestMapping` 所在的 Java 文件没有被 `springApi.exclude` 或内置排除（`target/`）挡掉 —— 注意**要索引源码目录，不是编译产物**；
3. 用的是自定义注解（如 `ZmqRequestMapping`）？按上一节配 `springApi.extraMappingAnnotations`；
4. 看输出面板日志。

**自定义注解配了还是搜不到？**
- 确认注解**类名**（最后一段）写对，例如 `com.a.b.ZmqRequestMapping` 只需写 `ZmqRequestMapping`；
- 路径是写在别的属性名里（`topic`/`url`）？把属性名加进 `springApi.pathAttributeNames`；
- 注解定义在 jar 里（源码不在工作区）→ 自动识别不到，必须用 `extraMappingAnnotations`；
- 看输出面板的 `[自定义映射注解]` / `[自动识别组合注解]` 两行日志确认配置是否生效。

**仓库很大，索引慢？**
首次索引是并发读文件 + 正则解析，几万文件通常在数秒级。把 `springApi.indexOnActivation` 设为 `false`，并把 `springApi.exclude` 加上你们的生成代码目录。

**常量路径解析不出来？**
比如 `@GetMapping(SomeInterface.CONSTANT)`。插件会用 `**` 兜底，保证"还能被搜到"（CodeLens 上会标 ⚠ 路径含未解析常量）。想精确的话，把常量写成当前文件里的 `String` 常量即可（支持 `常量 + "后缀"` 拼接）。

**和 Spring Boot 官方扩展的 CodeLens 重复？**
官方插件（`vmware.vscode-spring-boot`）也会在方法上方显示东西。不喜欢重复就把 `springApi.showCodeLens` 设为 `false`，只保留搜索/跳转功能。

**前端路径是网关动态路由，代码里根本没有？**
那属于配置而不是代码，本插件会提示"索引里找不到"，并提供"用 VS Code 全局搜索片段"的兜底（把 `/a/b/c` 变成 `(a|b|c)` 的或搜索）。

---

## 九、代码结构

```
vscode-spring-api-finder/
├── package.json                  插件清单（命令/快捷键/菜单/活动栏视图/配置项）
├── media/spring-api.svg          左侧活动栏图标
├── extension.js                  激活入口：命令、定义/悬停/CodeLens、文件监听
├── src/
│   ├── springParser.js           ★ 解析映射注解（内置 + 自定义 + 组合注解），拼接类路径+方法路径
│   ├── endpointIndex.js          工作区索引、并发读取、增量更新、context-path 识别、组合注解跨文件识别
│   ├── pathMatcher.js            路径归一化与带容错的匹配打分
│   ├── lineScan.js               从一行前端代码里定位"光标所在的路径字符串"
│   └── treeProvider.js           左侧活动栏的接口树
└── test/
    ├── run-tests.js              解析 + 匹配 + 索引 + 自定义注解 + 真实项目全流程单测
    ├── activation-smoke.js       用 VS Code API 桩真跑一遍 activate、跳转、接口树
    ├── manifest-check.js         package.json 清单自检
    ├── vscode-stub.js            VS Code API 桩
    └── fixtures/
        ├── demo/                 类上/方法上拆两段的经典写法
        ├── zmq/                  ZmqRequestMapping（自定义框架注解，走配置）
        └── composed/             @PostMapping/@RequestMapping 组合注解（走自动识别）
```

自测（零依赖，直接 node 跑）：

```powershell
cd vscode-spring-api-finder
npm test
```

---

## 十、已知限制

- 纯文本/正则解析，不做 Java 编译；Kotlin 的注解能解析，但方法名识别有限。
- 不计算 SpEL/复杂表达式、不解析注册中心或网关配置里的动态路由。
- 组合注解只解析**静态**写法：`@RequestMapping("/a")` 这种固定前缀能继承；用注解参数动态拼路径的表达式不解析。
- 索引的是**磁盘文件**；新写的接口未保存时 CodeLens 可能还没更新（保存后 ~0.4 秒自动增量刷新）。
- 同名后缀路径（如很多 `/detail`）会一起列出，靠 QuickPick 选择。

MIT License.
