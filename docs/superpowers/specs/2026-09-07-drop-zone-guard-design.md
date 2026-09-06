# 设计：文件面板拖拽上传与 DSH 全窗拖放蒙层的区域分流（Drop-Zone Guard）

> 日期：2026-09-07 · 仓库：dsh-ssh-ops（DSH Desktop fork，基线 v0.2.20）· 状态：用户已确认

## 1. 背景与问题

ssh-ops 0.2.20 在 SSH 面板「文件」页提供了拖拽上传（把系统里的文件/文件夹拖进文件列表即上传，支持递归建目录）。实际使用时：

- 把文件拖进 DSH Desktop 窗口，**无论指针在哪个区域**，都会先弹出 DSH 自己的**全窗拖放蒙层**（覆盖整个窗口、含文件面板），提示「文件约束 / 拖放限制」一类内容；
- 指针进入插件文件列表后蒙层仍然盖着，干扰「松开上传」的识别，体验上像被 DSH 抢了先。

期望：**按区域分流** —— 拖到 ssh-ops 文件列表时直接走插件上传（显示插件自己的高亮，DSH 蒙层不出现）；拖到其它 DSH 区域时 DSH 的拖放行为原样保留。

## 2. 根因（已定位到代码）

- **DSH 侧**（`@deepseek-ai/dsh-client-ui-attachment`，随 DSH Desktop 0.7.2 安装，npm 包不可改）：
  - `ComposerAttachments` 在 `document` 上注册**冒泡阶段**原生监听 `dragenter/dragover/dragleave/drop`（`lib/client.js` ~L534-582）；
  - 任何携带 `Files` 的 `dragenter` 冒泡到 document 即把 `dragActive` 置真，渲染 `DropOverlay`：`position:fixed; inset:0; z-index:1000` 的全窗蒙层（`pointer-events:none`，纯装饰）；`canAcceptDrop=false` 时文案为「dropBlocked」（即用户看到的"文件约束"）；
  - `drop` 落在 document 层会把文件追加进对话附件（`onAddImages`）。
- **ssh-ops 侧**（`src/client/SshFiles.jsx` ~L446-460）：
  - 拖放区=文件列表 `<div>`，用 React 合成事件 `onDragEnter/Over/Leave/Drop`；
  - 只调了 `preventDefault()`，**没有 `stopPropagation()`** → 事件继续冒泡到 document，DSH 蒙层先弹、drop 可能双触发（插件上传 + DSH 塞附件）。

## 3. 目标与非目标

### 目标
1. 拖文件悬停在文件列表上：DSH 全窗蒙层不出现；列表显示现有虚线高亮与「松开上传到当前目录/目录 xxx」提示。
2. 在列表内松手：只触发插件上传（含文件夹递归；SCP 兼容模式行为不变），不把文件同时塞进对话附件。
3. 拖到列表以外的任何 DSH 区域：DSH 拖放行为（蒙层、塞附件）完全原样。
4. 蒙层已显示时指针移进列表 → 蒙层自动消退；移出列表回到 DSH 区域 → 蒙层恢复；任何路径都不卡死蒙层。
5. 上传中、未连接、SCP 降级模式下**不拦截**（无有效接收方时不屏蔽 DSH 默认）。

### 非目标
- 不改 DSH 客户端（npm 安装包）；不动终端页/数据库页的拖放；不做「整页可拖」的扩大区域（用户已选：只限文件列表区域）。

## 4. 方案决策

对比三个候选后选定 **方案 A：拖放区挂原生 capture 拦截守卫**。

| 方案 | 思路 | 结论 |
|---|---|---|
| **A 原生 capture 守卫（采用）** | 在文件列表 DOM 上用 `useEffect` 挂 capture 阶段原生监听，携带 `Files` 的拖拽事件在到达 document 冒泡监听前 `stopPropagation()` | 不依赖插件渲染方式（portal 也有效）；区域内外天然分流；进出配对正确；改动集中在 `SshFiles.jsx` |
| B React 处理器逐个 `stopPropagation` | 每行加一个调用 | 依赖 React 事件委托根位于目标与 document 之间的原生路径；portal 渲染时可能拦不住 document 监听，有双触发风险 |
| C document 级 capture 全局拦截 | 插件入口注册全局 capture，按命中检测决定拦不拦 | 生命周期重、命中检测脆、影响面大，收益与 A 相同但风险更高 |

## 5. 行为契约（验收口径）

1. 对话区拖任意文件 → DSH 蒙层照常出现/塞附件（回归）。
2. 文件列表上拖文件 → 只见插件「松开上传」高亮，无 DSH 蒙层；松手成功上传（含整个文件夹）。
3. 蒙层显示中指针移进列表再移出 → 蒙层先退后现，无卡死。
4. 列表内 drop 后，对话附件区不出现该文件（无 <drop> 双触发）。
5. 断开连接后列表上拖文件 → 恢复 DSH 默认蒙层行为。
6. 拖 URL / 纯文本到列表 → 不拦截、无异常。

## 6. 实现要点

文件：`src/client/SshFiles.jsx`（唯一改动文件，预计净 +50 行左右）。

1. 给文件列表 `<div>` 加 `ref`（`listRef`）；目录行加 `data-dir-name={entry.name}` 数据属性（替代原来行级 React onDragEnter 悬停判定）。
2. 新写小 hook `useDropZoneGuard(ref, active, handlers)`（同文件内私有），**拖放全部走原生事件单轨**：
   - `active = Boolean(connectionId) && !busy && transferMode === "sftp"`；
   - `active` 时挂载原生监听于列表元素：`dragenter / dragover / dragleave / drop`，`{ capture: true }`，另在 `window` 挂 `dragend`；
   - handler 先判 `dataTransfer?.types.includes("Files")`；命中则 `event.stopPropagation()`，其中 `dragover`、`drop` 额外 `event.preventDefault()` 并设 `dropEffect = "copy"`；
   - `dragenter`：`e.target.closest("[data-dir-name]")` 命中目录行 → 置 `dropDir`；否则置 `dragOver=true`、`dropDir=null`；
   - `dragleave`：`relatedTarget` 仍在列表内 → 只清目录行悬停；已离开列表 → `dragOver=false`、`dropDir=null`；
   - `drop`：按 `dropDir`/`cwd` 算出目标目录后调用上传（经 ref 取最新闭包，避免陈旧 state）；
   - `dragend`：复位高亮状态（防 Esc 取消等丢失 dragleave 场景）；
   - cleanup 移除全部监听（插件禁用/HMR 不泄漏）。
3. **删除**文件列表与目录行上原有的 React `onDragEnter/onDragOver/onDragLeave/onDrop` 属性与行级 onDragEnter 悬停逻辑——capture 拦截后 React 委托处理器不会再触发，留着是死代码；视觉渲染（`dragOver`/`dropDir` 驱动的样式与「松开上传」提示）不变。

> 为什么不能"React 处理器保留 + 原生 capture 只负责拦停"：React 17+ 把合成事件委托在 React 根容器（列表元素的祖先、位于 document 之下），capture 阶段在列表元素 `stopPropagation()` 会让事件**连根容器都到不了**，React 的 `onDrop`（上传逻辑）与 `onDragOver`（允许 drop）都会静默失效。因此必须原生单轨：所有拖放副作用都在 capture 监听里完成。

### 关键机制说明（进出配对为什么正确）
- DSH 蒙层由其 document 冒泡监听的 enter/leave 计数（`dragDepth`）驱动。
- 指针从 DSH 区域移进列表：旧元素（列表外）的 `dragleave` 不受守卫拦截 → DSH 计数归零、蒙层消退；新元素（列表内）的 `dragenter` 被守卫拦下 → DSH 不再 +1。
- 指针在列表内移动：全部事件被拦，DSH 计数保持 0。
- 指针从列表移回 DSH 区域：列表内 `dragleave` 被拦（DSH 不减）；新 DSH 区域元素 `dragenter` 正常冒泡 → DSH +1、蒙层重现。
- 结果：蒙层只反映"指针是否在 DSH 区域"，永不因插件区域残留卡死。

## 7. 边界与错误处理

- 只拦 `types` 含 `Files` 的拖拽；URL/文本拖拽放行，避免影响浏览器内文本拖选等。
- `busy`（上传中/加载中）与 SCP 降级、未连接时守卫关闭 → 列表区域回落到 DSH 默认，杜绝"拦截了却无处上传/二次 drop"竞态。
- 目录行 `dropDir` 高亮逻辑不变（目标都在列表内，事件同样停在列表层）。
- 若未来 DSH 把 document 监听改成 capture 阶段：守卫失效风险存在，届时升级为 document capture 前置判断（记录于"后续注意"）。

## 8. 验证方案

1. 构建：`npm run pack:release` 产出 tgz → 按 `INSTALL.md` 用桌面捆绑 node+dsh 装进 `%APPDATA%\dsh-desktop\harness\profiles\web` → 重启 DSH Desktop。
2. 手动清单：执行第 5 节全部 6 条验收口径（连接真实或本地 `test-sshd.mjs` 服务器均可）。
3. 回归抽查：文件面板按钮上传、文件夹上传、SCP 兼容模式上传、双击下载不受影响。

## 9. 涉及文件

- `src/client/SshFiles.jsx` — 唯一改动（新增 `useDropZoneGuard` + 列表 ref）。
- `docs/superpowers/specs/2026-09-07-drop-zone-guard-design.md` — 本文档。
- 参考（只读）：`G:\desktop-dsh\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-client-ui-attachment\lib\client.js` L534-582（DSH 蒙层机制）。
