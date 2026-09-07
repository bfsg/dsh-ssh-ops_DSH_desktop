# SSH 终端/连接界面 UI 增强（0.2.24）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 SSH 面板落地 5 项 UI 增强：标签 ⟳ 重连、连接弹窗改右上 × 关闭、用户名默认 paas + 可增删下拉、面板最大化浮层、Ctrl+滚轮调字号并全局保存。

**Architecture:** 宿主 `SshOpsService`（`src/index.js`，TypertRemoteService 公开方法自动成 RPC）新增 `reconnect(connectionId)`——用 `record.connectConfig`（含 proxyJump 链）强制重建传输；其余 4 项全在客户端 `src/client/SshPanel.jsx` + `api.js`。持久化走现有 localStorage 模式（键 `dsh-ssh-ops.*`）。

**Tech Stack:** Node ESM / Typert RPC / React 18 / xterm 5.5（@xterm/xterm）/ esbuild。构建 `npm run build`，测试 `npm test`（Node 直跑，无 DOM）。

## Global Constraints

- 基线版本 `0.2.23`（package.json）；发布版本 `0.2.24`。
- 版本号只出现在 `package.json` 的 `version` 与 `CHANGELOG.md` 顶部条目（task 7 一次性改）。
- localStorage 键一律 `dsh-ssh-ops.` 前缀（现有 `dsh-ssh-ops.panel-width` 同风格）。
- 安全门语义不变：本批不动 `prepareTerminalInput`/`pendingConfirmations`/危险命令判定。
- 新按钮一律**符号不写字**：⟳ 重连、× 关闭、＋ 添加用户、✕ 删除用户、⛶ 最大化。
- 默认用户名 = `paas`；内置不可删项 = `paas`、`root`；字号钳制 8–32，默认 13。
- RPC 返回值不允许 `undefined` 字段（typert 门）。

---

### Task 1: 宿主 `reconnect` RPC + 单元测试 + 客户端 api 方法

**Files:**
- Modify: `src/index.js`（在 `async disconnect(request)` 前，约 L1276 插入新方法）
- Modify: `src/client/api.js`（`disconnect()` 后插入 `reconnect()`）
- Create: `test/reconnect.mjs`
- Modify: `package.json`（`scripts.test` 尾部追加 `&& node test/reconnect.mjs`）

**Interfaces:**
- Consumes: `record.connectConfig`/`record.proxyJump`/`record.hostKeyMode`（连接记录既有字段）、`this.connectClient(record, retries)`（L417）、`this.attachTransportHandlers(record)`（L571）、`this.scheduleReconnect(record)`（L602）、`this.sessions`/`this.rememberExit`/`this.removePendingForSession`（既有）。
- Produces: RPC `reconnect({ connectionId })` → `{ ok: true, value: { connectionId, host, port, username } }` 或 `{ ok: false, error: { code, message } }`（`no-connection` / `connect-cancelled` / `connect-failed`）；客户端 `api.reconnect(connectionId): Promise<{connectionId}>`。

- [ ] **Step 1: 写失败测试**

创建 `test/reconnect.mjs`：

```js
import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";

const service = Object.create(SshOpsService.prototype);
service.connections = new Map();

// Unknown connection id → no-connection, and no transport work happens.
{
  const result = await service.reconnect({ connectionId: "nope" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "no-connection");
}

// A closing record is refused without touching its client (no ssh attempt).
{
  const client = { endCalls: 0, end() { this.endCalls += 1; } };
  service.connections.set("c1", { id: "c1", closing: true, client });
  const result = await service.reconnect({ connectionId: "c1" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "connect-cancelled");
  assert.equal(client.endCalls, 0, "closing record must not be torn down");
}
console.log("reconnect.mjs OK");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test/reconnect.mjs`
Expected: 失败于 `service.reconnect is not a function`（TypeError）。

- [ ] **Step 3: 宿主实现 `reconnect`**

在 `src/index.js` 中、`async disconnect(request) {`（L1276）**之前**插入：

```js
  /**
   * Force a full re-establishment of an existing connection using the stored
   * connectConfig (credentials, keepalive and the proxyJump chain are all
   * replayed). Used by the panel tab ⟳ button: the old transport is torn
   * down first (its PTY sessions retire), then connectClient rebuilds the
   * chain, and transport handlers + remote tunnels are re-attached like the
   * auto-reconnect path does.
   */
  async reconnect(request) {
    const record = this.connections.get(request.connectionId);
    if (record === void 0) {
      return { ok: false, error: fail("no-connection", `connection "${request.connectionId}" does not exist`) };
    }
    if (record.closing) {
      return { ok: false, error: fail("connect-cancelled", `connection "${record.id}" is closing`) };
    }
    // Cancel any pending auto-reconnect so the manual and timed paths do not race.
    if (record.reconnectTimer !== null) {
      clearTimeout(record.reconnectTimer);
      record.reconnectTimer = null;
    }
    // Detach and retire the old transport, mirroring handleTransportLoss but
    // without scheduling an auto-reconnect (we reconnect synchronously below).
    const oldClient = record.client;
    record.client = null;
    record.dead = true;
    record.sftp = null;
    for (const sessionId of [...record.sessions]) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.exited = session.exited ?? { code: 1 };
        session.stream = null;
        this.removePendingForSession(sessionId);
        this.rememberExit(sessionId, session.exited);
      }
      this.sessions.delete(sessionId);
    }
    record.sessions.clear();
    for (const tunnel of record.tunnels.values()) tunnel.active = false;
    for (const hop of record.hops) { try { hop.end(); } catch {} }
    record.hops = [];
    try { oldClient?.end(); } catch {}

    const connected = await this.connectClient(record, 2);
    if (!connected.ok) {
      // Keep the record alive for self-healing backoff so later ops/panel
      // refreshes can still recover instead of orphaning the tab.
      this.scheduleReconnect(record);
      return connected;
    }
    this.attachTransportHandlers(record);
    for (const tunnel of record.tunnels.values()) {
      if (tunnel.kind === "remote" && tunnel.bridgeInfo?.bridge) {
        record.client.prependListener("tcp connection", tunnel.bridgeInfo.bridge);
      }
      tunnel.active = true;
    }
    return {
      ok: true,
      value: {
        connectionId: record.id,
        host: record.host,
        port: record.port,
        username: record.username
      }
    };
  }
```

> 注意：`fail`、`Client`、`connectClient`、`attachTransportHandlers`、`scheduleReconnect`、`rememberExit`、`removePendingForSession` 均为类内/模块既有符号，无需新增 import。

- [ ] **Step 4: 运行确认通过**

Run: `node test/reconnect.mjs`
Expected: 打印 `reconnect.mjs OK`，exit 0。

- [ ] **Step 5: 注册到测试套件**

在 `package.json` 的 `scripts.test` 末尾（`&& node test/client.mjs` 之后）追加 ` && node test/reconnect.mjs`。

- [ ] **Step 6: 客户端 api 封装**

在 `src/client/api.js` 的 `disconnect` 方法（L172-175）后插入：

```js
  reconnect(connectionId) {
    return this.call("reconnect", { connectionId });
  }
```

- [ ] **Step 7: 全量回归**

Run: `npm test`
Expected: 全部通过（含新 `reconnect.mjs OK`）。

- [ ] **Step 8: Commit**

```bash
git add src/index.js src/client/api.js test/reconnect.mjs package.json
git commit -m "feat: host reconnect RPC for tab relink (0.2.24)"
```

---

### Task 2: 服务器标签 ⟳ 重新链接按钮

**Files:**
- Modify: `src/client/SshPanel.jsx`（SshPanel 组件：新增 handler ~L1221 `closePanel` 之后；标签区 L1313 前插入按钮；styles 表新增 `serverTabRelink`）

**Interfaces:**
- Consumes: `api.reconnect(connectionId)`（Task 1）、`refreshConnections(api, { adopt: false })`（L691）、`api.openSession(connectionId, 100, 30)`、`getSshUiSnapshot()`（store import 已有）、`sshUiSetBusy/sshUiSetError`。
- Produces: 标签按钮 `⟳`（title/aria=`重新链接此服务器`）；点击后重连成功且该标签为当前激活时自动开新终端。

- [ ] **Step 1: 加 handler**

在 `SshPanel` 组件内 `closePanel` 定义（L1223-1228）之后插入：

```js
  /** Re-establish one server from its tab's ⟳ button, re-opening its PTY when
   *  the relinked tab is the active one (old PTY output is intentionally
   *  cleared — the host retires the previous transport sessions). */
  const reconnectConnection = async (connectionId) => {
    sshUiSetBusy(true);
    sshUiSetError(null);
    try {
      await api.reconnect(connectionId);
      await refreshConnections(api, { adopt: false });
      const snapshot = getSshUiSnapshot();
      if (snapshot.activeConnectionId === connectionId) {
        await api.openSession(connectionId, 100, 30);
        await refreshConnections(api, { adopt: false });
      }
    } catch (err) {
      sshUiSetError(`重新链接失败：${err?.message ?? String(err)}`);
    } finally {
      sshUiSetBusy(false);
    }
  };
```

- [ ] **Step 2: 标签区插按钮**

把 `serverTabs` 里现有关闭按钮 JSX（L1313-1322）：

```jsx
              <button
                type="button"
                style={panelStyles.serverTabClose}
                onClick={() => closeConnection(conn.connectionId)}
                disabled={ui.busy}
                title="断开此服务器"
                aria-label={`断开 ${conn.name || conn.host}`}
              >
                ×
              </button>
```

改为（在 × 前插入 ⟳）：

```jsx
              <button
                type="button"
                style={panelStyles.serverTabRelink}
                onClick={() => reconnectConnection(conn.connectionId)}
                disabled={ui.busy}
                title="重新链接此服务器"
                aria-label={`重新链接 ${conn.name || conn.host}`}
              >
                ⟳
              </button>
              <button
                type="button"
                style={panelStyles.serverTabClose}
                onClick={() => closeConnection(conn.connectionId)}
                disabled={ui.busy}
                title="断开此服务器"
                aria-label={`断开 ${conn.name || conn.host}`}
              >
                ×
              </button>
```

- [ ] **Step 3: 加样式**

在 `panelStyles.serverTabClose`（L1600-1609）之后追加：

```js
  serverTabRelink: {
    background: "transparent",
    border: "none",
    color: "inherit",
    fontSize: 13,
    lineHeight: 1,
    padding: "0 2px 0 4px",
    cursor: "pointer",
    opacity: 0.85
  },
```

- [ ] **Step 4: 构建验证**

Run: `npm run build`
Expected: host + client 构建成功，无语法错误。

- [ ] **Step 5: Commit**

```bash
git add src/client/SshPanel.jsx
git commit -m "feat: tab ⟳ relink button (0.2.24)"
```

---

### Task 3: 连接弹窗改为右上 × 关闭（点外部不再关）

**Files:**
- Modify: `src/client/SshPanel.jsx`（ConnectDialog：backdrop L564、标题区 L566；styles 表新增 `dialogHeader`）

**Interfaces:**
- Consumes: 现有 `busy`/`onClose` props。
- Produces: 点 backdrop 不关闭；标题栏右上 ×（busy 禁用）关闭；取消按钮保留。

- [ ] **Step 1: 改 backdrop/标题结构**

把 ConnectDialog 顶部 JSX（L564-566）：

```jsx
    <div style={panelStyles.dialogBackdrop} onClick={busy ? undefined : onClose}>
      <div style={panelStyles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={panelStyles.dialogTitle}>连接服务器</div>
```

改为（删除 backdrop 点击关闭，加标题栏+×）：

```jsx
    <div style={panelStyles.dialogBackdrop}>
      <div style={panelStyles.dialog}>
        <div style={panelStyles.dialogHeader}>
          <div style={panelStyles.dialogTitle}>连接服务器</div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={panelStyles.btnSmall}
            title="关闭"
            aria-label="关闭"
          >
            ×
          </button>
        </div>
```

- [ ] **Step 2: 加样式**

在 `panelStyles.dialogTitle`（L1697）前插入：

```js
  dialogHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 2
  },
```

（`dialogTitle: { fontSize: 14, fontWeight: 600, marginBottom: 2 }` 保留原样即可，header 里的 marginBottom 会因 flex 布局仍生效，若视觉偏大可去掉该字段——可保留不动。）

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 4: Commit**

```bash
git add src/client/SshPanel.jsx
git commit -m "feat: connect dialog closes via header × only (0.2.24)"
```

---

### Task 4: 用户名下拉（默认 paas、含 root、可增删自定义并保存）

**Files:**
- Modify: `src/client/SshPanel.jsx`（ConnectDialog：初始值 L301、字段 L594-597；新增状态与处理器；styles 表新增 `userRow`、`userChip`、`userChipDel`）

**Interfaces:**
- Consumes: localStorage（键 `dsh-ssh-ops.saved-usernames`）。
- Produces: `loadSavedUsers()/persistSavedUsers(list)`（模块级）、ConnectDialog 内 `savedUsers/showUserInput/userDraft` 状态与 `addUsername/removeUsername`；`form.username` 默认 `"paas"`。

- [ ] **Step 1: 模块级常量与读写函数**

在文件顶部常量区（`PANEL_WIDTH_KEY` L42 附近）追加：

```js
const SAVED_USERS_KEY = "dsh-ssh-ops.saved-usernames";
const BUILTIN_USERS = ["paas", "root"];
```

并在 `clamp()`（L109）附近追加：

```js
function loadSavedUsers() {
  const merged = new Set(BUILTIN_USERS);
  try {
    const stored = JSON.parse(localStorage.getItem(SAVED_USERS_KEY));
    if (Array.isArray(stored)) {
      for (const name of stored) {
        if (typeof name === "string" && name.trim()) merged.add(name.trim());
      }
    }
  } catch {}
  return [...merged];
}

function persistSavedUsers(list) {
  try {
    localStorage.setItem(SAVED_USERS_KEY, JSON.stringify(list));
  } catch {}
}
```

- [ ] **Step 2: 默认用户名改 paas + 新增状态**

把 ConnectDialog 初始 state（L297-306）里 `username: "root",` 改为 `username: "paas",`；并在该组件 state 区（`proxyJumps` L315 附近）追加：

```js
  const [savedUsers, setSavedUsers] = useState(loadSavedUsers);
  const [showUserInput, setShowUserInput] = useState(false);
  const [userDraft, setUserDraft] = useState("");
```

- [ ] **Step 3: 增删处理器**

在 ConnectDialog 的 `updateProxyJump`（L333-335）后追加：

```js
  const addUsername = () => {
    const name = userDraft.trim();
    if (!name) return;
    setSavedUsers((prev) => {
      const next = prev.includes(name) ? prev : [...prev, name];
      persistSavedUsers(next);
      return next;
    });
    setForm((f) => ({ ...f, username: name }));
    setUserDraft("");
    setShowUserInput(false);
  };

  const removeUsername = (name) => {
    if (BUILTIN_USERS.includes(name)) return;
    setSavedUsers((prev) => {
      const next = prev.filter((u) => u !== name);
      persistSavedUsers(next);
      return next;
    });
    setForm((f) => (f.username === name ? { ...f, username: "paas" } : f));
  };
```

- [ ] **Step 4: 替换用户名输入为下拉**

把用户名字段 JSX（L594-597）：

```jsx
        <label style={panelStyles.field}>
          <span>用户名</span>
          <input value={form.username} onChange={set("username")} style={panelStyles.input} />
        </label>
```

替换为：

```jsx
        <label style={panelStyles.field}>
          <span>用户名</span>
          <div style={panelStyles.userRow}>
            <select value={form.username} onChange={set("username")} style={{ ...panelStyles.input, flex: 1 }}>
              {savedUsers.map((user) => (
                <option key={user} value={user}>
                  {user}
                  {user === "paas" ? "（默认）" : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setShowUserInput((v) => !v)}
              style={panelStyles.btnSmall}
              title="添加自定义用户"
              aria-label="添加自定义用户"
            >
              ＋
            </button>
          </div>
          {showUserInput && (
            <div style={{ ...panelStyles.userRow, marginTop: 4 }}>
              <input
                value={userDraft}
                onChange={(e) => setUserDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addUsername(); }}
                placeholder="新用户名"
                style={{ ...panelStyles.input, flex: 1 }}
              />
              <button type="button" onClick={addUsername} style={panelStyles.btnSecondary}>保存</button>
              <button type="button" onClick={() => setShowUserInput(false)} style={panelStyles.btnSecondary}>取消</button>
            </div>
          )}
          {savedUsers.filter((u) => !BUILTIN_USERS.includes(u)).length > 0 && (
            <div style={{ ...panelStyles.userRow, marginTop: 4, flexWrap: "wrap" }}>
              {savedUsers.filter((u) => !BUILTIN_USERS.includes(u)).map((user) => (
                <span key={user} style={panelStyles.userChip}>
                  {user}
                  <button
                    type="button"
                    onClick={() => removeUsername(user)}
                    style={panelStyles.userChipDel}
                    title={`删除用户 ${user}`}
                    aria-label={`删除用户 ${user}`}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
        </label>
```

- [ ] **Step 5: 加样式**

在 `panelStyles` 对象内（如 `quickInput` L1660 附近）追加：

```js
  userRow: { display: "flex", gap: 6, alignItems: "center" },
  userChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
    background: "#181c22",
    border: "1px solid #3a414b",
    borderRadius: 6,
    padding: "1px 2px 1px 8px",
    fontSize: 11,
    color: "#d7dbe2"
  },
  userChipDel: {
    background: "transparent",
    border: "none",
    color: "#f85149",
    cursor: "pointer",
    fontSize: 12,
    padding: "0 3px",
    lineHeight: 1
  },
```

- [ ] **Step 6: 构建验证**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 7: Commit**

```bash
git add src/client/SshPanel.jsx
git commit -m "feat: username select with paas default + savable custom users (0.2.24)"
```

---

### Task 5: 面板最大化浮层（窗口内铺满 + 还原）

**Files:**
- Modify: `src/client/SshPanel.jsx`（SshPanel 组件：state `maximized`；header 按钮；root style 条件；resize handle 条件隐藏；styles 表新增 `rootMaximized`）

**Interfaces:**
- Consumes: 现有 `panelWidth/panelTop`、`panelStyles.root`、ResizeObserver 自动 refit。
- Produces: header 按钮 `⛶`（title/aria 随状态切换）；最大化时 root 铺满窗口（`left:0; width:100%; maxWidth:none; zIndex:2000`），resize handle 隐藏。

- [ ] **Step 1: 加状态**

在 `SshPanel` 组件 state 区（`const [panelTop, setPanelTop] = ...` L1035 后）追加：

```js
  const [maximized, setMaximized] = useState(false);
```

- [ ] **Step 2: header 加按钮**

把 header JSX（L1295-1298）：

```jsx
      <div data-dsh-ssh-ops-panel-header="true" style={panelStyles.header}>
        <span style={panelStyles.title}>{t.panelTitle}</span>
        <button onClick={closePanel} disabled={ui.busy} style={panelStyles.btnSmall} title={t.closePanel}>×</button>
      </div>
```

改为：

```jsx
      <div data-dsh-ssh-ops-panel-header="true" style={panelStyles.header}>
        <span style={panelStyles.title}>{t.panelTitle}</span>
        <button
          onClick={() => setMaximized((m) => !m)}
          style={panelStyles.btnSmall}
          title={maximized ? "还原 SSH 面板" : "最大化 SSH 面板"}
          aria-label={maximized ? "还原 SSH 面板" : "最大化 SSH 面板"}
        >
          ⛶
        </button>
        <button onClick={closePanel} disabled={ui.busy} style={panelStyles.btnSmall} title={t.closePanel}>×</button>
      </div>
```

- [ ] **Step 3: root style 与 resize handle 条件化**

把 root div（L1286-1294）：

```jsx
    <div ref={panelRef} data-dsh-ssh-ops-panel="true" style={{ ...panelStyles.root, width: panelWidth, top: panelTop }}>
      <div
        style={panelStyles.resizeHandle}
        onPointerDown={beginResize}
        role="separator"
        aria-label="调整 SSH 终端宽度"
        aria-orientation="vertical"
        title="拖动以调整 SSH 终端宽度"
      />
```

改为：

```jsx
    <div
      ref={panelRef}
      data-dsh-ssh-ops-panel="true"
      style={{ ...panelStyles.root, ...(maximized ? panelStyles.rootMaximized : { width: panelWidth, top: panelTop }) }}
    >
      {!maximized && (
        <div
          style={panelStyles.resizeHandle}
          onPointerDown={beginResize}
          role="separator"
          aria-label="调整 SSH 终端宽度"
          aria-orientation="vertical"
          title="拖动以调整 SSH 终端宽度"
        />
      )}
```

- [ ] **Step 4: 加样式**

在 `panelStyles.root`（L1502-1517）之后插入：

```js
  rootMaximized: {
    left: 0,
    width: "100%",
    maxWidth: "none",
    borderLeft: "none",
    zIndex: 2000
  },
```

> 若实测发现仍有 DSH 顶层元素盖住（如超过 2000 的模态层），把 `zIndex` 一行改为 `zIndex: 2147483000` 并重测——这是唯一可能需要的调参点。

- [ ] **Step 5: 构建验证**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 6: Commit**

```bash
git add src/client/SshPanel.jsx
git commit -m "feat: maximize overlay for SSH panel within DSH window (0.2.24)"
```

---

### Task 6: Ctrl+滚轮调字号（全局保存）

**Files:**
- Modify: `src/client/SshPanel.jsx`（常量区：`FONT_SIZE_KEY`；模块级 `readStoredFontSize()`；XtermView：构造 fontSize、新增 wheel effect）

**Interfaces:**
- Consumes: `clamp(value, 8, 32)`（L109 已有）、`termRef`/`fitRef`（XtermView 内）、`api.resize`。
- Produces: localStorage 键 `dsh-ssh-ops.terminal-font-size`（默认 13）；所有 XtermView 初始化用存储值；Ctrl+滚轮实时改字号并持久化。

- [ ] **Step 1: 常量与读取函数**

在常量区（Task 4 加的 `SAVED_USERS_KEY` 旁）追加：

```js
const FONT_SIZE_KEY = "dsh-ssh-ops.terminal-font-size";
```

在 `loadSavedUsers()` 附近追加：

```js
function readStoredFontSize() {
  try {
    const stored = Number(localStorage.getItem(FONT_SIZE_KEY));
    return stored >= 8 && stored <= 32 ? stored : 13;
  } catch {
    return 13;
  }
}
```

- [ ] **Step 2: 初始化字号读存储**

把 XtermView 构造参数里 `fontSize: 13,`（L200）改为 `fontSize: readStoredFontSize(),`。

- [ ] **Step 3: wheel effect**

在 XtermView 里、创建 term 的主 effect（L196-289）**之后**新增一个 effect（同组件内，hook 顺序在创建 effect 之后 → 运行时 term 已存在）：

```js
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      const next = clamp(readStoredFontSize() + (event.deltaY < 0 ? 1 : -1), 8, 32);
      try {
        localStorage.setItem(FONT_SIZE_KEY, String(next));
      } catch {}
      term.options.fontSize = next;
      try {
        fit.fit();
        const dims = term.cols && term.rows ? { cols: term.cols, rows: term.rows } : null;
        if (dims) api.resize(sessionId, dims.cols, dims.rows).catch(() => {});
      } catch {}
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [sessionId, api]);
```

> `term.options.fontSize` 是 xterm 5.5 运行时改字号的属性赋值（与构造参数 `fontSize` 同一通道）。

- [ ] **Step 4: 构建验证**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 5: Commit**

```bash
git add src/client/SshPanel.jsx
git commit -m "feat: ctrl+wheel terminal font zoom, persisted globally (0.2.24)"
```

---

### Task 7: 版本 0.2.24、CHANGELOG、打包与手动验收

**Files:**
- Modify: `package.json`（version → 0.2.24）
- Modify: `CHANGELOG.md`（顶部加 0.2.24 条目）
- 产物：`release/dsh-ssh-ops-0.2.24.tgz`（由 `npm run pack:release` 生成）

- [ ] **Step 1: 升版本**

`package.json` `"version": "0.2.23"` → `"version": "0.2.24"`。

- [ ] **Step 2: CHANGELOG 条目**

`CHANGELOG.md` 顶部插入：

```md
## 0.2.24

- 终端/连接界面增强：
  - 服务器标签新增 ⟳ 重新链接按钮（宿主新增 reconnect RPC，用保存的连接配置重建链路，跳板链同样适用；激活标签会自动重开新终端）。
  - 连接服务器弹窗不再因点击外部而关闭，改为右上角 × 关闭。
  - 连接表单用户名默认为 paas，下拉内置 root，可自定义添加/删除并本机保存用户名。
  - SSH 面板支持窗口内最大化浮层（⛶ 按钮切换），不受 DSH 侧栏布局约束。
  - 终端支持 Ctrl+滚轮缩放字号（8–32），全局保存、重启沿用。
```

- [ ] **Step 3: 全量验证**

Run: `npm test && npm run build`
Expected: 全绿 + 构建成功。

- [ ] **Step 4: 打包**

Run: `npm run pack:release`
Expected: 生成 `release/dsh-ssh-ops-0.2.24.tgz`。

- [ ] **Step 5: 同步桌面副本**

把 tgz 解包覆盖到两处安装目录（tar 解到临时目录再同步，保持 strip 顶层目录）：

```bash
rm -rf /tmp/pkg024 && mkdir -p /tmp/pkg024
tar -xzf release/dsh-ssh-ops-0.2.24.tgz -C /tmp/pkg024 --strip-components=1
# 目标1：%APPDATA%/dsh-desktop/harness/plugins/dsh-ssh-ops
# 目标2：%APPDATA%/dsh-desktop/harness/profiles/web/node_modules/dsh-ssh-ops
```

（用与 0.2.23 相同的同步命令与两处路径。）

- [ ] **Step 6: 重启 + 手动验收**

重启 DSH Desktop（宿主含新 reconnect RPC，必须重启）。逐条验收（虚拟服务器 2222/2223 保持运行）：

1. 标签出现 ⟳（纯符号）；连接 2222 后点 ⟳ → 该标签自动重开新终端；杀掉 2222 mock 再点 ⟳ → 连接恢复提示或错误不丢标签；跳板链（面板配 2222→2223）⟳ 整链重建并重开终端。
2. 打开连接弹窗：点外部不关闭；右上 × 关闭；busy 时 × 禁用。
3. 默认用户名 `paas`；下拉含 paas（默认）、root；添加自定义用户出现在下拉与 chips，删除自定义生效；重启 DSH 后清单仍在；paas/root 不可删。
4. 点 ⛶ → 面板铺满 DSH 窗口且终端可输入输出；再点还原恢复原宽度/位置；确认没有 DSH 顶层蒙层盖住（若盖住按 Task 5 Step 4 调参点改 zIndex）。
5. Ctrl+滚轮：字号即时变化、8–32 钳制；重启后新终端沿用。

- [ ] **Step 7: Commit + 推送**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: release 0.2.24"
git push origin main
git tag v0.2.24 && git push origin v0.2.24
```

（是否建 GitHub Release 由用户决定——如需上传 `release/dsh-ssh-ops-0.2.24.tgz`，沿用 v0.2.23 的上传流程。）
