# 设计：SSH 终端/连接界面 UI 增强（0.2.24）

> 日期：2026-09-07 · 仓库：dsh-ssh-ops（基线 v0.2.23）· 状态：设计已获用户确认

## 1. 背景

用户在使用 SSH 面板/终端时提出 5 项界面增强（均已逐项确认需求与行为）：

1. 每个服务器标签的关闭按钮（×）左侧增加「重新链接」按钮，**用符号不用文字**；
2. 连接服务器弹窗**点击外部不再关闭**，改为右上角 × 关闭；
3. 连接表单用户名默认 `paas`，改为下拉（含 `root`），支持**自定义添加并保存**用户名；
4. 终端增加按钮，可**铺满整个 DSH 窗口**的最大化浮层（受窗口边界；独立原生窗口需 DSH 宿主 API，不在本次范围——用户已确认选窗口内最大化）；
5. 终端支持 **Ctrl+滚轮调字体大小**，全局保存生效。

## 2. 目标与非目标

### 目标
- ①②③⑤ 全部为客户端改动；④ 为客户端样式/状态改动；另需宿主新增一个 `reconnect` RPC 支撑 ①。
- 全部改动不触碰安全门/危险命令语义。

### 非目标
- 不创建真正脱离 DSH 窗口的原生窗口（宿主无此 API，另列需求）。
- 不改已存 profile 的用户名/凭据结构（profile 有自己的用户名，仅临时连接表单用下拉）。
- 不做终端滚动条/会话录制等其它增强。

## 3. 现状（代码定位）

- `src/client/SshPanel.jsx`
  - 连接弹窗 `ConnectDialog`：`dialogBackdrop` 上 `onClick={busy ? undefined : onClose}`（~L564）→ **点击外部即关闭**，需删除；弹窗无标题栏/右上 ×。
  - 表单初始 `username: "root"`（~L301）→ 需改默认 `paas` + 下拉。
  - 服务器标签：`serverTab` 内 `serverTabLabel`（切换）+ `serverTabClose`（断开，内容 "×"，~L1313-1322）→ 在 close 左侧插入 `⟳` 重连按钮。
  - 面板 root：`position:fixed` overlay（宽可拖 `panelWidth`）→ 最大化浮层 = 状态切换为铺满（`inset:0; width/height:100%`、更高 z-index、隐藏 resize handle），还原恢复。
  - `XtermView`（~L189）：`new Terminal({ fontSize: 13, ... })`，`containerRef` 挂 xterm；每连接一个实例 → ① 字号读取全局存储默认；⑤ 挂 `wheel` 监听改 `fontSize`。
- `src/client/api.js`：RPC 调用封装；新增 `reconnect(connectionId)`。
- `src/index.js`：`SshOpsService extends TypertRemoteService`（公开方法自动成为 RPC）；`record.connectConfig` 保存完整连接配置（host/port/user/auth/hops/proxyJump/keepalive），重连可复用。`connectClient(record, retries)` 可重建传输。
- `src/client/store.js`：客户端持久化设施（localStorage）——用于保存用户名清单与字号。

## 4. 行为契约（验收口径）

### ① 标签 ⟳ 重新链接
1. 每个有连接的服务器标签内，断开按钮（×）**左侧**显示符号按钮 `⟳`（纯符号，`title/aria-label="重新链接此服务器"`，不用文字）。
2. 点击后（busy 禁用）：
   - 调用新 RPC `reconnect({ connectionId })`；
   - 宿主用该连接的 `connectConfig`（含 proxyJump 链、认证、keepalive）强制重建传输（先断开旧 client，触发会话结束通知，再 `connectClient`，内部重试 ≤2 次）；
   - 若该标签是当前激活标签：成功后客户端**自动打开新终端**（`openSession`），刷新连接列表；旧终端输出随旧会话清空（换新 PTY）。
   - 失败：不误删连接记录，面板显示明确错误（保持现有错误展示区）。
3. 对跳板链连接同样有效（整链重建）。

### ② 弹窗关闭逻辑
1. 点击弹窗**外部不再关闭**（删除 backdrop onClick）。
2. 弹窗顶部新增标题栏与右上角 **×**（busy 时禁用，`aria-label="关闭"`）；底部「取消」按钮保留。
3. 连接成功/失败后的自动关闭行为不变（成功 onClose、失败留在弹窗）。

### ③ 用户名下拉
1. 连接表单用户名控件改为下拉：
   - 选项固定首项 `paas`（**默认选中**）、`root`，其后是用户自定义保存的用户名；
   - 下拉尾随「＋ 添加并保存」操作：输入新用户名 → 追加并持久化，随即选中；
   - 自定义项可删除（paas/root 不可删）。
2. 持久化：localStorage（`store.js`）key 如 `ssh-ops.saved-usernames`，默认 `["paas","root"]`，重启后保留。
3. 仅临时连接表单使用；已存 profile 连接仍用 profile 自身的用户名。

### ④ 最大化浮层
1. 面板头部增加符号按钮（如 `⛶`，`title="最大化/还原 SSH 面板"`）。
2. 最大化：面板铺满整个 DSH 可视区（fixed inset:0，z-index 高于 DSH 页面常规层），保持「服务器标签 + 终端/文件/隧道/数据库 tabs + 待确认横幅」原有结构，resize handle 隐藏；xterm 重新 fit 并同步行列。
3. 还原：再次点击同按钮（或浮层内提供还原按钮）恢复原尺寸/位置。
4. 边界：不脱离 DSH 窗口；若 DSH 顶层有更高 z 蒙层（如拖放蒙层 z=1000），浮层 z 需高于其（实现时取足够大的值并验证）。

### ⑤ Ctrl+滚轮字号
1. 终端容器内 `Ctrl+滚轮`：上滚 +1、下滚 -1（字号 8–32 钳制），阻止页面缩放副作用。
2. 字号**立即生效**于当前终端（xterm `fontSize` 更新 + fit + resize 同步），并保存到 localStorage（如 `ssh-ops.terminal-font-size`，默认 13）。
3. 新开终端/重启 DSH 后沿用保存值（所有终端实例初始化读取）。

## 5. 实现要点

- 宿主：`src/index.js` 新增公开 `async reconnect(request)`：
  - 参数 `{ connectionId }`；查 `connections`，不存在 → `no-connection`；
  - 复用 `record.connectConfig`/`record.proxyJump`/`record.hostKeyMode`：关闭旧 `client`（try/catch），`connectClient(record, 2)`；成功返回 `{ connectionId }`，失败返回 `connect-failed`（不清记录）。
  - 会话层面：旧 client 断开会触发会话 exit（既有 `recordExit` 流程）→ 客户端据此展示关闭态；新 PTY 由客户端成功回调后 `openSession` 创建。
- 客户端 `api.js`：`reconnect(connectionId) { return this.call("reconnect", { connectionId }); }`。
- 客户端 `SshPanel.jsx`：
  - 标签区按钮顺序 `⟳ | ×`；reconnect 处理函数：`busy` 置位 → `api.reconnect` → 若为激活标签 `openSession` + `refreshConnections`；错误走现有 error 展示。
  - `ConnectDialog`：删 backdrop onClick；新增 header 结构（title + ×）；用户名控件换下拉组件（含添加/删除/持久化）。
  - 面板最大化状态 `maximized`（useState），root style 切换 + 隐藏 resize handle；`XtermView` 尺寸变化由既有 ResizeObserver 自动 refit。
  - `XtermView`：初始化 fontSize 读存储；挂 wheel（passive:false）→ `e.ctrlKey` 时 `term.options.fontSize = clamp(...)` + `fit` + `api.resize` + 持久化。
- `store.js`：提供 `loadJSON/saveJSON` 小工具（若已存在则复用）。

## 6. 涉及文件

- 修改：`src/index.js`、`src/client/SshPanel.jsx`、`src/client/api.js`、`src/client/store.js`（视情况）、`package.json`（0.2.24）、`CHANGELOG.md`
- 参考只读：现有 tab 关闭/连接弹窗/xterm 初始化逻辑

## 7. 验证

1. `npm run build`（host+client）与 `npm test` 全绿。
2. 打包 `dsh-ssh-ops-0.2.24.tgz`，同步桌面 harness 两处，重启 DSH Desktop。
3. 手动验收：
   - ① 标签出现 ⟳（纯符号）；连 2222 后点 ⟳ → 自动重开新终端；可先杀掉 2222 模拟断开再 ⟳ 验证恢复；跳板链连接（2222→2223）⟳ 整链重建。
   - ② 打开连接弹窗，点外部 → 不关闭；右上 × 关闭正常；busy 时 × 禁用。
   - ③ 默认用户名 paas；下拉含 root；添加自定义用户 → 出现在下拉且重启后仍在；删除自定义生效；paas/root 不可删。
   - ④ 点 ⛶ → 面板铺满 DSH 窗口、终端可正常输入输出；再点还原恢复；拖放蒙层出现时浮层不被盖死。
   - ⑤ Ctrl+滚轮放大/缩小即时生效；重启后保持；新终端沿用。
