# ssh_write 危险命令回车人工确认 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ssh_write` 输入危险命令回车时复用现有 `pendingConfirmations`，在 SSH 面板弹人工确认卡（执行/撤销），人点执行才真实提交。

**Architecture:** 仅宿主端 `src/index.js` 改动。`prepareTerminalInput` 在被拦分支把命令带出（`blockedCommand`）；`writeToConnection` 对每个 live session 调用新私有方法 `queueWriteConfirmation` 入队；执行/撤销复用既有 `pendingConfirmationApprove/Cancel`（`prefilled:false` 路径天然适用）。客户端零改动。

**Tech Stack:** Node ESM（ssh2 宿主）+ 现有测试（node test/*.mjs）。

**Spec:** `docs/superpowers/specs/2026-09-07-ssh-write-confirm-design.md`

## Global Constraints

- 只改 ssh-ops 仓库；不动 DSH npm 包。
- 客户端 `SshPanel.jsx` / RPC 结构**不改**（复用 `prefilled:false` 卡片渲染与 approve/cancel）。
- 待确认记录字段与 `prefillBlockedCommand` 完全同构：`{ confirmationId, connectionId, sessionId, name, host, command, reason, createdAt, prefilled:false }`。
- 被拦分支先记 `blockedCommand = session.inputLine`（清行前），`??=` 只取首个。
- 同一 session + 同 command 已有待确认项 → 跳过入队（去重）。
- 版本号递增：0.2.21 → 0.2.22；CHANGELOG 顶部加条目。

---

### Task 1: 宿主端 ssh_write 拦截入队

**Files:**
- Modify: `src/index.js`（唯一代码改动）

**Interfaces:**
- Consumes: 现有 `assessShellCommand`、`session.inputLine`、`this.pendingConfirmations`、`this.appendTerminalNotice`、`randomUUID`。
- Produces:
  - `prepareTerminalInput(session, text)` 返回值增加 `blockedCommand: string|null`。
  - 新私有方法 `queueWriteConfirmation(connectionId, session, command, reason)`（void；幂等去重）。
  - `writeToConnection` 在每 session 处理后调用上述方法。

- [ ] **Step 1: `prepareTerminalInput` 带出被拦命令**

Old（`src/index.js` ~L1738-1752）:
```js
    for (const char of text) {
      if (char === "\r" || char === "\n") {
        const decision = session.inputKnown
          ? assessShellCommand(session.inputLine)
          : { ok: false, reason: "安全策略已阻止：无法验证历史命令或自动补全后的内容。请手动输入只读诊断命令。" };
        if (decision.ok) {
          forwarded += char;
        } else {
          // The already-echoed command remains in the remote line editor until
          // Ctrl-U clears it; crucially, Enter itself never reaches the shell.
          forwarded += "\x15";
          blockedReason ??= decision.reason;
          this.appendTerminalNotice(session, decision.reason);
        }
        session.inputLine = "";
        session.inputKnown = true;
        continue;
      }
```
New:
```js
    for (const char of text) {
      if (char === "\r" || char === "\n") {
        const decision = session.inputKnown
          ? assessShellCommand(session.inputLine)
          : { ok: false, reason: "安全策略已阻止：无法验证历史命令或自动补全后的内容。请手动输入只读诊断命令。" };
        if (decision.ok) {
          forwarded += char;
        } else {
          // The already-echoed command remains in the remote line editor until
          // Ctrl-U clears it; crucially, Enter itself never reaches the shell.
          // Carry the blocked line out so writeToConnection can queue a human
          // confirmation card (same mechanism as ssh_exec's blocked commands).
          blockedReason ??= decision.reason;
          blockedCommand ??= session.inputLine || null;
          forwarded += "\x15";
          this.appendTerminalNotice(session, decision.reason);
        }
        session.inputLine = "";
        session.inputKnown = true;
        continue;
      }
```

- [ ] **Step 2: 函数签名与返回带上 `blockedCommand`**

Old:
```js
  prepareTerminalInput(session, text) {
    let forwarded = "";
    let blockedReason = null;
```
New:
```js
  prepareTerminalInput(session, text) {
    let forwarded = "";
    let blockedReason = null;
    let blockedCommand = null;
```

Old（函数结尾返回处，`src/index.js` 找 `return { forwarded, blockedReason };`）:
```js
    return { forwarded, blockedReason };
```
New:
```js
    return { forwarded, blockedReason, blockedCommand };
```

- [ ] **Step 3: `writeToConnection` 每 session 入队**

Old（`src/index.js` ~L1704-1722）:
```js
  writeToConnection(connectionId, input) {
    const conn = this.connections.get(connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    let written = 0;
    let blockedReason = null;
    for (const sessionId of conn.sessions) {
      const session = this.sessions.get(sessionId);
      if (session && session.exited === null && session.stream !== null) {
        try {
          const guarded = this.prepareTerminalInput(session, input);
          if (guarded.forwarded) session.stream.write(guarded.forwarded);
          written += guarded.forwarded.length;
          blockedReason ??= guarded.blockedReason;
        } catch {}
      }
    }
    if (blockedReason) return { ok: false, error: fail("unsafe-command", blockedReason) };
    return { ok: true, value: { written } };
  }
```
New:
```js
  writeToConnection(connectionId, input) {
    const conn = this.connections.get(connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    let written = 0;
    let blockedReason = null;
    for (const sessionId of conn.sessions) {
      const session = this.sessions.get(sessionId);
      if (session && session.exited === null && session.stream !== null) {
        try {
          const guarded = this.prepareTerminalInput(session, input);
          if (guarded.forwarded) session.stream.write(guarded.forwarded);
          written += guarded.forwarded.length;
          blockedReason ??= guarded.blockedReason;
          // A blocked Enter now queues a human confirmation card (same pending
          // queue as ssh_exec). The agent still receives the unsafe-command
          // error; only the panel's Execute button may submit the command.
          if (guarded.blockedCommand) {
            this.queueWriteConfirmation(connectionId, session, guarded.blockedCommand, guarded.blockedReason ?? "危险操作");
          }
        } catch {}
      }
    }
    if (blockedReason) return { ok: false, error: fail("unsafe-command", blockedReason) };
    return { ok: true, value: { written } };
  }
```

- [ ] **Step 4: 新增 `queueWriteConfirmation`（放在 `prefillBlockedCommand` 方法之前）**

Old（在 `prefillBlockedCommand` 的 JSDoc 注释前插入新方法）— 定位 `  prefillBlockedCommand(connectionId, command, reason = "危险操作") {`，在它前面加:
```js
  /**
   * Queue a blocked terminal-input line (from ssh_write's Enter gate) into the
   * same human-confirmation queue as ssh_exec's blocked commands. The command
   * is NOT re-written into the terminal; the panel's Execute button submits it
   * via pendingConfirmationApprove ("\x15" + command + CR), cancel just drops
   * the record. Idempotent per (session, command).
   */
  queueWriteConfirmation(connectionId, session, command, reason) {
    if (!command || typeof command !== "string" || !command.trim()) return;
    for (const pending of this.pendingConfirmations.values()) {
      if (pending.sessionId === session.id && pending.command === command) return;
    }
    const conn = this.connections.get(connectionId);
    const confirmation = {
      confirmationId: randomUUID(),
      connectionId,
      sessionId: session.id,
      name: conn?.name,
      host: conn?.host,
      command,
      reason,
      createdAt: new Date().toISOString(),
      prefilled: false
    };
    this.pendingConfirmations.set(confirmation.confirmationId, confirmation);
    this.appendTerminalNotice(session, `危险命令已被拦截并弹出确认卡片，请在右侧 SSH 面板点击“执行”或“撤销”：${command}`);
  }

```
（保持 `  prefillBlockedCommand(connectionId, command, reason = "危险操作") {` 原样续接。）

- [ ] **Step 5: 构建 + 测试 + 静态自查**

Run:
```bash
npm run build:host && npm test
```
Expected: exit 0；`lib/index.js` 重写；`npm test` 全绿。

自查命令引用一致性:
```bash
grep -n "blockedCommand" src/index.js
```
Expected: 出现在 `prepareTerminalInput`（声明、`??=`、return）与 `writeToConnection`（判定 + 入队调用）中。

- [ ] **Step 6: Commit**

```bash
git add src/index.js lib/index.js
git commit -m "feat(ssh_write): queue blocked terminal-input lines for human confirmation card"
```

---

### Task 2: 版本 0.2.22 + CHANGELOG

**Files:**
- Modify: `package.json`（0.2.21 → 0.2.22）
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 升版本** `"version": "0.2.21"` → `"version": "0.2.22"`
- [ ] **Step 2: CHANGELOG 顶部插入**

```
## 0.2.22 - 2026-09-07

- **`ssh_write` 危险命令回车增加人工确认卡**：此前经 `ssh_write` 输入危险命令并回车会被安全门直接清行拒绝（仅终端黄字 + 工具报错，无二次确认入口）。现在被拦命令会进入与 `ssh_exec` 相同的待确认队列，右侧 SSH 面板弹出「危险命令等待确认」卡片——点「执行」才由该终端真实提交执行，点「撤销」即作废；同一会话同一命令不重复入队。安全命令与 `press_enter:false` 行为不变。
```

- [ ] **Step 3: Commit** `git add package.json CHANGELOG.md && git commit -m "chore: bump to 0.2.22 for ssh_write confirm card"`

---

### Task 3: 打包、同步桌面 harness、冒烟与手动清单

- [ ] **Step 1: 打包** `npm run build && npm pack --pack-destination release` → `release/dsh-ssh-ops-0.2.22.tgz`
- [ ] **Step 2: 同步两处宿主副本**（lib/index.js 等，覆盖即可；client 未变）:
```bash
SRC=/g/deepseek/dsh-ssh-ops-src/dsh-ssh-ops-main
APPD=$(cygpath -u "$APPDATA")
tar -xzf "$SRC/release/dsh-ssh-ops-0.2.22.tgz" -C "$APPD/dsh-desktop/harness/plugins/dsh-ssh-ops" --strip-components=1
tar -xzf "$SRC/release/dsh-ssh-ops-0.2.22.tgz" -C "$APPD/dsh-desktop/harness/profiles/web/node_modules/dsh-ssh-ops" --strip-components=1
grep -m1 '"version"' "$APPD/dsh-desktop/harness/profiles/web/node_modules/dsh-ssh-ops/package.json"
```
Expected: `"version": "0.2.22"`。
- [ ] **Step 3: 第二实例冒烟**（同 0.2.21 做法，端口 59999，curl 期望 401，无插件加载错误后杀进程）
- [ ] **Step 4: 交用户手动清单（需重启 DSH Desktop 后）**

1. 连 127.0.0.1:2222（终端开着）；对话要求 `ssh_write` 输入 `rm -rf /tmp/x` 回车 → Agent 报错，面板弹确认卡（命令 `rm -rf /tmp/x`）
2. 点「撤销」→ 卡消失、无执行
3. 再输同命令回车 → 点「执行」→ 命令真实提交（cmd 会报 `rm` 不是命令，证明已执行）
4. `ssh_exec` 跑 `rm -rf /tmp/y` → 原拦截弹卡回归正常
5. `ssh_write` 安全命令（`echo hi`）回车正常执行
6. 同命令连续回车两次 → 只有一张卡

---

## Self-Review 记录

- **Spec 覆盖**：契约 1-6 ↔ Task1 实现 + Task3 清单；实现要点 5.1-5.4 ↔ Step1-4；版本/文档 ↔ Task2；打包/同步 ↔ Task3。无遗漏。
- **占位符扫描**：无 TBD/TODO；代码步骤给出完整 old/new。
- **类型一致**：`blockedCommand`、`queueWriteConfirmation(connectionId, session, command, reason)`、`prefilled:false` 记录结构在 Task1 各步一致；与既有 `pendingConfirmationApprove/Cancel`、`publicPendingConfirmation` 的字段兼容（无新字段）。

## Execution Handoff

用户已选定 Inline 执行 → 按 `superpowers:executing-plans` 逐任务执行。
