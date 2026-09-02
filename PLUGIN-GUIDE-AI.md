# DSH Desktop 插件开发指南（AI 可执行版）

> 本指南写给**要写 DSH Desktop 插件的 AI 助手**。照抄第 4–6 节的模板就能产出一个
> 能跑的插件；写完按第 9 节打包、第 10 节安装、第 11 节验证。
> 每条「硬规则」都是真实踩过的坑，违反会导致插件**加载失败或整个桌面版起不来**。

适用环境：Windows + DSH Desktop 0.7.x（Harness 0.1.2-alpha.1，Cordis 4.0.1）。

## 0. 三个参考实现（先选抄谁）

| 仓库 | 形态 | 抄它的场景 |
|---|---|---|
| `bfsg/dsh-browser-control` | 宿主工具 + HTTP 路由 + 简单客户端面板（**纯手写 JS，无构建**） | 让 AI 操控外部程序/子进程，并在 GUI 显示实时状态 → **首选模板** |
| `bfsg/dsh-office-tools` | 纯宿主工具（TypeScript + esbuild，无客户端） | 给模型加 word/excel/ppt 这类文件处理工具 |
| `bfsg/dsh-ssh-ops` | 完整 UI 插件（Service 类 + typert 远程 RPC + JSX 客户端 + xterm） | 需要常驻面板、复杂交互、流式终端 |

## 1. 心智模型（先读懂这个再动手）

一个 DSH Desktop 插件 = **一个 npm 包**，分两半：

```
┌─ 宿主半 lib/index.js ─────────────────────────────┐
│ 普通 ESM 模块，跑在桌面版内置的 Node 进程里        │
│  - export const name / inject                     │
│  - export function apply(ctx, config)             │
│  - 用 ctx.tools.register(defineTool(...)) 给模型注册工具 │
│  - 用 ctx.get('webServer') 挂同源 HTTP 路由给网页用 │
└──────────────────────────────────────────────────┘
┌─ 客户端半 lib/client.js（可选）─────────────────────┐
│ 特殊 CJS 模块，跑在 GUI 网页里：                    │
│ window.__ModuleLoader__.load({ id, factory })      │
│  - React 从 require("react") 拿（没有裸全局 React！）│
│  - 用 ctx.slots.inject/register 往界面槽位挂组件    │
│  - 和宿主通信走同源 fetch（没有裸全局 host！）       │
└──────────────────────────────────────────────────┘
```

装载链路：插件包放进 profile 的依赖 → pnpm 装进
`%APPDATA%\dsh-desktop\harness\profiles\web\node_modules\` → 包被列进
`dsh.profile.bundles`（或 patch 层 insert）→ 重启桌面版时 loader 按包内的
`dsh.bundle.patch`（cordis.patch.yml）把插件实例挂进组合树 → apply() 执行。

## 2. 选型决策（写代码前回答三个问题）

1. **模型要会调用新工具吗？** → 必须有宿主半（`ctx.tools.register`）。
2. **用户要在界面上看到东西吗？** → 加客户端半；只是给模型加工具就不用客户端。
3. **要 TypeScript/JSX 构建吗？** → 不会用 esbuild 就选纯手写 JS 工作流（browser-control 式），
   `lib/index.js`/`lib/client.js` 直接手写，**零构建、零依赖步骤**。

## 3. 项目结构（工作流 A：纯手写 JS，推荐）

```
dsh-my-plugin/
├── package.json          # 包清单 + dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # bundle patch：把插件实例插进组合树
├── lib/
│   ├── index.js          # 宿主半（ESM）
│   └── client.js         # 客户端半（CJS bundle，可选）
├── scripts/
│   └── package-release.mjs   # npm pack 出 tgz（参考任一仓库）
├── INSTALL-AI.md         # AI 可执行的安装说明
├── README.md  LICENSE
```

TypeScript 工作流（工作流 B，office-tools/ssh-ops 式）多一层：
`src/*.ts(+.jsx)` → `esbuild` 打包出 `lib/*.js`。客户端 bundle 的构建参数照抄
ssh-ops `scripts/build-client.mjs`：`format:"cjs", platform:"browser", external:["react","@deepseek-ai/*"]`，
**打包完必须再包一层 `__ModuleLoader__.load` 包装**（该脚本第 30–38 行就是包装模板）。

## 4. package.json 模板（逐字段都是必需语义）

```json
{
  "name": "dsh-my-plugin",
  "version": "0.1.0",
  "description": "一句话说清插件干什么",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "scripts", "cordis.patch.yml", "INSTALL-AI.md", "README.md", "LICENSE"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-cordis-client-runner",
        "@deepseek-ai/dsh-client-ui-slots"
      ]
    }
  },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" },
  "dependencies": { "@playwright/mcp": "^0.0.79" },
  "scripts": { "pack:release": "node scripts/package-release.mjs" },
  "license": "MIT"
}
```

规则：
- **没有客户端半就删掉** `exports["./client"]` 和整个 `dsh.client`（参考 office-tools）。
- `files` 白名单决定 tgz 内容；**`cordis.patch.yml` 必须在**（loader 从安装副本读它）。
- `dependencies` 只放真正的运行时依赖（会被 pnpm 装进 profile 的 node_modules）；
  `@deepseek-ai/*` 一律放 peerDependencies，**绝不**装进 dependencies（运行时由宿主提供）。

`cordis.patch.yml` 模板（id 即实例 id，全树唯一；name 必须等于包名）：

```yaml
# dsh-my-plugin bundle patch
- insert:
    - id: my-plugin
      name: dsh-my-plugin
```

## 5. 宿主半 lib/index.js（ESM）

### 5.1 骨架

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'my-plugin'
export const inject = ['tools', 'webServer']   // 硬依赖服务；缺了插件加载失败

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}

  // —— 注册工具（每个工具一个 ctx.effect 包裹，插件停用自动注销）——
  ctx.effect(() => ctx.tools.register(defineTool({ /* 见 5.2 */ })),
    'my-plugin: tool xxx')

  // —— 挂 HTTP 路由（给客户端面板用；在 effect 里注册，停用自动摘除）——
  const webServer = ctx.get('webServer')
  if (webServer) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/my-plugin/state',
      handler: async (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
      },
    }), 'my-plugin: route /my-plugin/state')
  }
}
```

### 5.2 defineTool 参数规范（写错一个字段，注册时就抛错）

```js
ctx.tools.register(defineTool({
  name: 'my_tool',                      // 全局唯一！DSH 拒绝重名工具，启动直接失败
  description: '给模型看的一句话说明：干什么、什么时候用、成功返回什么',
  parameters: {                         // 注意：这是“属性表”，不是 JSON Schema 对象
    path:     { type: 'string', required: true, description: '...' },
    count:    { type: 'integer', description: '...' },          // number/integer/boolean/string
    mode:     { type: 'string', enum: ['fast', 'safe'] },       // 可选 enum/const
    options:  {                                                  // 嵌套对象
      type: 'object',
      additionalProperties: false,        // 硬规则：object 必须显式写 true/false
      properties: {
        dryRun: { type: 'boolean' },
      },
    },
    tags:     { type: 'array', items: { type: 'string' } },     // 数组必须用 items
    filter:   { oneOf: [{ type: 'string' }, { type: 'number' }] }, // 联合类型
    payload:  { type: 'json', description: '任意 JSON' },        // 兜底类型，不做参数校验
  },
  output: {
    schema: { type: 'object', additionalProperties: false,
              properties: { text: { type: 'string', required: true } } },
    render: (args, value) => [{ type: 'text', text: String(value.text) }],  // 必须给
  },
  async execute(args, exec) {           // exec.signal 是 AbortSignal，长任务要监听
    return { text: 'done' }             // 返回值必须匹配 output.schema
  },
}))
```

author spec 允许的类型集合（来自 `@deepseek-ai/dsh-tools` 编译器，**超集会抛错**）：

| 节点 | 允许的字段 |
|---|---|
| `string`/`number`/`integer`/`boolean` | + `enum`、`const`、注解（description/title/default/examples）、`required: true` |
| `array` | + `items`（嵌套 value schema） |
| `object` | + `properties`（嵌套属性表）、**`additionalProperties`（必填布尔）** |
| `json` | 只有注解；接受任意 JSON，不校验 |
| `oneOf` | 分支数组（≥2）；**不能再写 type** |

拿到的如果是现成 JSON Schema（比如 MCP 的 inputSchema），必须先转换：
`properties` 提出来做顶层属性表、`required` 数组拆成属性里的 `required: true`、
`anyOf`/其它不支持的形状降级为 `{ type: 'json' }`。转换器参考
browser-control `lib/index.js` 的 `convertSchemaNode()`（24 个 MCP 工具全量验证通过）。

### 5.3 可用的服务（`inject` 硬依赖 / `ctx.get()` 软探测）

| 服务 | 用途 | 用法 |
|---|---|---|
| `tools` | 注册模型工具 | `ctx.tools.register(def)` |
| `webServer` | 同源 HTTP 路由（给网页/面板） | `webServer.register({ kind: 'exact' \| 'prefixes', path, handler })`；`handler(req, res)` 是原生 Node req/res |
| `fs` | 沙箱文件系统 | `ctx.get('fs')`，有 `.resolve/.stat/.readBytes` |
| `subprocess` | 子进程 | `ctx.get('subprocess')`，`.resolveExecutable()`；也可直接用 `node:child_process`（记得 `windowsHide: true`） |
| `sandboxPolicy` | 会话工作区 | `ctx.get('sandboxPolicy')?.workspaceRoot` |
| `credentials` | 凭据存取 | `await ctx.get('credentials').resolve(ref)` |
| `settings` | 用户设置 | `ctx.get('settings').get('<ns>')` |
| `storageDomain` | 持久化存储（ssh-ops 在用） | 通过 inject 声明 |
| `systemPrompt` | 注入系统提示段 | `ctx.systemPrompt.section({ name, order, text })` |

### 5.4 生命周期硬规则

- 一切注册都包 `ctx.effect(() => 注册, '标签')`——effect 回调**立即执行**，返回值作为
  卸载函数，插件停用/重载时自动调用。不做的话重载后路由/工具残留。
- 子进程：apply 里别 await 长活；用 `ensureStarted()` 惰性启动 + 状态机
  （参考 browser-control）。退出时 `ctx.effect(() => () => handle.kill())`。
- 工具 `execute` 里长任务用 `exec.signal` 支持取消，并用 Promise.race 上超时。

## 6. 客户端半 lib/client.js（CJS bundle 契约）

### 6.1 骨架（一字不差照抄结构）

```js
window.__ModuleLoader__.load({
  id: "dsh-my-plugin",                       // 必须等于包名
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");             // 唯一拿 React 的方式
    var createElement = React.createElement;
    var useState = React.useState, useEffect = React.useEffect;

    var inject = ["slots"];                   // 客户端需要的服务

    function apply(ctx) {
      // 样式：没有全局 styles！自己挂 <style>，注册卸载清理
      var styleEl = document.createElement("style");
      styleEl.id = "dsh-my-plugin-style";
      styleEl.textContent = ".myplugin-chip { color: var(--dsw-alias-label, #666); }";
      document.head.appendChild(styleEl);
      ctx.effect(function () { return function () { styleEl.remove() } }, "my: style");

      // 槽位：inject(fn) 里 register 组件
      ctx.slots.inject("conversation.composer.dock", function () {
        return ctx.slots.register(
          { name: "conversation.composer.dock", id: "my-chip", order: 2 },
          function Chip() { return createElement("div", { className: "myplugin-chip" }, "hello") }
        );
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;                    // 必须返回 module.exports
  }
});
```

**硬规则**：
- 只能是上面这种 `window.__ModuleLoader__.load({...})` CJS 形态。普通 ESM
  （`export default {...}`）在这个版本**加载即语法错误**，面板整个不出现。
- 没有 `React`/`host`/`styles`/`harness` 裸全局（那是 cordis_define 动态插件沙箱才有的）。
- 组件用 `createElement`，**不要 JSX**（手写 JS 工作流没有转译）。

### 6.2 已验证可用的槽位（三个仓库在用）

| 槽位名 | 出现位置 | 注册形状 |
|---|---|---|
| `tool.call.toolview` | 某个**工具调用卡片**的位置（key=工具名） | `{ name, key: "my_tool" }` + 组件 |
| `conversation.composer.dock` | 输入框下方一条 | `{ name, id, order, locale?, label? }` |
| `conversation.session.header.actions` | 会话头部按钮区（ssh-ops 的 SSH 按钮） | `{ name, id, order, locale }` |
| `shell.overlay` | 全局浮层（ssh-ops 的终端面板） | `{ name, id, order, inject: () => props }` |
| `settings.plugins.tab` | 设置页的插件标签页 | `{ name, id, order, label }` |
| `sidebar.footer.action` | 侧栏底部按钮 | `{ name, id, locale, inject }` |

`register(meta, Component)` 的 meta：`name` 必须=槽位名；`key` 是过滤键（toolview 槽位
= 工具名）；`inject: (…) => ({...})` 可以往组件 props 里塞依赖。

### 6.3 客户端 ↔ 宿主通信（选最简单的）

1. **同源 fetch（默认选这个）**：宿主用 `webServer.register` 挂 `/my-plugin/xxx` 路由，
   客户端 `fetch("/my-plugin/state")` 轮询/提交。参考 browser-control（state/nav/refresh/...）
   和 deepseek-balance。
2. **typert 远程 RPC（高级，ssh-ops 式）**：宿主用 Service 类 + `./typert` 导出声明
   类型化方法；客户端 `await ctx.remote.$mount(TYPERT_REMOTE)` 后
   `ctx.remote.namespaces.get("sshOps").service` 直接调用。只在需要流式/强类型/常驻
   会话时用。
3. **不通信**：纯静态面板。

### 6.4 i18n（可选）

```js
var NS = "dsh-my-plugin";
ctx.effect(() => ctx.locale.register(NS, {
  zh: { label: "我的插件" },
  en: { label: "My Plugin" },
}));
```

## 7. 配置（可选）

patch 条目或 bundles 加载时可以注入 `config`。简单插件直接解析 `apply(ctx, config)` 第二参
（browser-control 式）；字段多/要默认值就用 schemastery（office-tools 式）：

```js
import z from '@deepseek-ai/schemastery'
export const Config = z.object({ enableFoo: z.boolean().default(true) })
export function apply(ctx, config) { const cfg = Config(config ?? {}) }
```

工具重名时用配置项关闭冲突工具（office-tools 的 `enablePptTools` 就是这么处理
`ppt_create` 撞名的）。

## 8. 与外部程序/子进程协作（browser-control 模式）

- 依赖包写进 `dependencies`（pnpm 会 hoist 到 profile node_modules），运行时用
  `createRequire(import.meta.url).resolve('<pkg>/package.json')` 解析包根再拼入口文件。
  **硬规则**：`require.resolve('<pkg>/cli.js')` 这种子路径会被包的 `exports` 白名单拦住
  （ERR_PACKAGE_PATH_NOT_EXPORTED）——先解析 `'<pkg>/package.json'` 再 `join(包根, 'cli.js')`。
- 解析顺序建议：config 显式路径 → 插件锚点 → workspace → cwd，每层 `existsSync` 兜底。
- 子进程 spawn 记得 `windowsHide: true`（桌面版入口已全局强制，但自己 spawn 的别撤掉）。

## 9. 打包与发布

```bash
# scripts/package-release.mjs（照抄任一仓库），然后：
npm run pack:release        # 产出 release/dsh-my-plugin-<version>.tgz
cp release/*.tgz dist/      # dist/ 进 git，release/ 进 .gitignore
```

- tgz 用 **npm pack** 生成（同 dsh-ssh-ops 约定），内容 = `files` 白名单。
- 发 GitHub Release 挂上 tgz，供下载安装。

## 10. 安装（仅限 DSH Desktop 桌面版；照抄 dsh-ssh-ops / dsh-browser-control 的 INSTALL-AI.md）

1. **定位桌面版安装目录**（运行中进程路径 / 注册表 / 常见路径），验证
   `resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js` 存在。不是桌面版 ⇒ 停止。
2. **环境锁定**（关键！CLI 不设 `DSH_HOME` 默认装到 `~/.dsh`，桌面版感知不到）：
   ```bash
   export DSH_HOME="$APPDATA/dsh-desktop/harness"
   PROFILE="$DSH_HOME/profiles/web"                      # 活跃 profile 从桌面日志确认
   export PATH="$DSH_HOME/.desktop-bin:$PATH"            # 桌面版自带 pnpm shim
   ```
   CLI 一律用捆绑的：`"$NODE" "$DSH" ...`（`NODE`=安装目录下 `resources\app\node_modules\node\bin\node.exe`，
   `DSH`=同目录 `@deepseek-ai\dsh\lib\bin.js`）。**不要用 PATH 上的裸 `dsh`**。
3. 装依赖：`"$NODE" "$DSH" plugin --profile web add <tgz>`（失败就用
   `"$DSH_HOME/.desktop-bin/pnpm.cmd" add <tgz>`）。
4. **接线（二选一，绝不都做）**：
   - bundles：`$PROFILE/package.json` 的 `dsh.profile.bundles` 加包名（loader 应用包内 bundle patch）；
   - 或 patch 层：`$PROFILE/cordis.patch.yml` 的 `- insert:` 加 `{ id, name }`。
   - **都做 = `duplicate loader entry id` 启动失败**。
5. 重启桌面版（taskkill + Start-Process）。

## 11. 验证清单（重启后全部打勾才算完成）

```bash
# 1) 日志有新一段启动且无插件报错
grep -a "\[desktop\] starting\|DSH entry loaded" "$APPDATA/dsh-desktop/logs/harness.log" | tail -4
grep -a "browser-control\|my-plugin" "$APPDATA/dsh-desktop/logs/harness.log" | grep -ai "fail\|error"   # 应为空

# 2) HTTP 路由活着（把 PORT/TOKEN 换成日志里最新 dsh web 那行）
curl -s "http://127.0.0.1:$PORT/my-plugin/state?token=$TOKEN"

# 3) 工具对模型可见：在 DSH 对话里让 AI 调一次 my_tool

# 4) 客户端进了启动图（有客户端半时）
curl -s -c /tmp/ck -o /dev/null "http://127.0.0.1:$PORT/?token=$TOKEN"
curl -s -b /tmp/ck "http://127.0.0.1:$PORT/" | grep -o '"id":"dsh-my-plugin"[^}]*'

# 5) 反查：默认 home 没被污染
ls ~/.dsh/profiles/*/node_modules/dsh-my-plugin 2>/dev/null   # 应不存在
```

## 12. 常见坑（症状 → 原因 → 对策）

| # | 症状 | 原因 | 对策 |
|---|---|---|---|
| 1 | 面板完全不出现，浏览器 console 报 SyntaxError | 客户端写成普通 ESM | 改成 `__ModuleLoader__.load` CJS 契约（§6.1） |
| 2 | 启动失败 `duplicate loader entry id: X` | bundles 和 patch 层都接线 | 二选一（§10.4） |
| 3 | 启动失败 `duplicate loader entry id: compaction-basic` | 在 patch 层又 insert 了框架 bundle 已有的 id | patch 层只放**自己的**插件 id |
| 4 | 启动失败 `cannot get property "setInterval" without inject` | 宿主用了未声明的服务 | 要么加进 `inject`，要么改 `ctx.get()` 软探测 |
| 5 | defineTool 注册即抛错（additionalProperties…） | 参数 spec 字段不合法（§5.2 表格） | object 必须显式 `additionalProperties`；不支持 anyOf→`json` |
| 6 | 模型看不到工具 | 工具没注册/重名被拒 | 查日志 `tool` 相关行；工具名全局唯一 |
| 7 | 插件装了但桌面版没反应 | `DSH_HOME` 没设，装进了 `~/.dsh` | §10.2 环境锁定 + §11.5 反查 |
| 8 | 重装后代码没变化 | pnpm 对版本号未变的 file:/tgz 依赖跳过复制 | `rm -rf "$PROFILE/node_modules/<包名>"` 再 install |
| 9 | `ERR_PACKAGE_PATH_NOT_EXPORTED` | `require.resolve('<pkg>/子路径')` 被包 exports 拦 | 解析 `'<pkg>/package.json'` 拿包根再拼路径（§8） |
| 10 | 日志 `migration failed, restoring the pre-upgrade profile` | 桌面版 generations 迁移的既有问题 | 与新插件无关，harness 会回滚照常启动，忽略 |
| 11 | 面板数据一直是「无法连接宿主端」 | 宿主路由没注册成功/插件没加载 | 先过 §11.1、§11.2 |
| 12 | curl 连 GitHub/API 全失败 | 本机 hosts 把 github 域指到 127.0.0.1 走加速器，加速器没开 | 开 Steam++ 加速器，或耐心重试 |
| 13 | 客户端 `React is not defined` | 用了裸 `React` | 只能 `require("react")`（§6.1） |
| 14 | tgz 里缺文件 | `files` 白名单漏写 | `tar -tzf` 检查；`cordis.patch.yml` 必须在内 |

## 13. 提交前自检清单

- [ ] `node --check lib/index.js` 通过；client.js 以 `.cjs` 复制后 `node --check` 通过
- [ ] 工具名全局唯一；每个参数都写了 `description`
- [ ] object 参数都有显式 `additionalProperties`
- [ ] 所有注册包在 `ctx.effect` 里；子进程/样式有卸载清理
- [ ] `tar -tzf` 检查 tgz：`cordis.patch.yml`、`lib/`、`package.json` 都在
- [ ] INSTALL-AI.md 按 §10 模板写，含桌面版锁定与二选一警告
- [ ] 装到桌面版实测：§11 清单全绿
- [ ] CHANGELOG 记一笔；GitHub Release 挂新 tgz
