# ssh_exec→ssh_write 回退规则（0.2.27）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ssh_exec/ssh_write 的工具 description 中加入"exec 无法执行时自动改用 ssh_write"的默认规则（纯文本，宿主逻辑零改动），并作为 0.2.27 发布。

**Architecture:** 仅修改 `src/index.js` 中 `registerTools()` 内两个工具的 `description` 字符串；经 esbuild 重建 `lib/index.js`；bump 版本 + CHANGELOG；按既有流程发布。

**Tech Stack:** Node.js（esbuild 构建）、dsh-ssh-ops 插件（cordis/typert）。

## Global Constraints

- 不改参数、output schema、安全拦截/确认卡宿主逻辑。
- 工具 description 保持英文、单行字符串（与现状一致；内容用 ASCII，避免转义问题）。
- 版本从 0.2.26 → 0.2.27；CHANGELOG 用 `## 0.2.27` + `- **…**` bullet 格式。
- 发布：git tag `v0.2.27` → push → GitHub Release + 上传 `release/dsh-ssh-ops-0.2.27.tgz`。

---

### Task 1: 修改两条工具 description

**Files:**
- Modify: `src/index.js`（ssh_exec description 约 2875 行；ssh_write description 约 3059 行）
- Test: 无新单测（description 无既有断言）；用 grep/node --check 验证

**Interfaces:**
- Consumes: 现 description 原文（见下方代码块）
- Produces: 含回退规则的新 description 文本；后续 Task 2 的 build/发布依赖它

- [ ] **Step 1: ssh_exec description 末尾追加规则（在现有句子后以空格续接，保持单行字符串）**

追加文本：
```
If exec fails or the command needs an interactive TTY (channel error, sudo password, menu prompts), do not give up — fall back to ssh_write: send the same command with a trailing Enter, then poll ssh_read until the output settles (bounded) and report it. Note that a PTY fallback has no exit code — tell the user. On permission-denied errors, ask the user to switch to root in the terminal (sudo -i / su -) first, then continue via ssh_write. Never use ssh_write to bypass a safety-blocked command — blocked commands require the human confirmation card, not a workaround.
```

- [ ] **Step 2: ssh_write description 末尾追加选型提示**

追加文本：
```
 Prefer ssh_exec for non-interactive one-shot commands (it returns an exit code); use ssh_write for interactive TTY work or as the fallback when ssh_exec cannot run the command.
```

- [ ] **Step 3: 验证源码改动**

Run: `node --check src/index.js && grep -c "Never use ssh_write to bypass" src/index.js && grep -c "Prefer ssh_exec for non-interactive" src/index.js`
Expected: node --check 无输出且退出 0；两个 grep 各输出 1。

- [ ] **Step 4: 重建 host 产物并验证**

Run: `npm run build:host && grep -c "Never use ssh_write to bypass" lib/index.js && grep -c "Prefer ssh_exec for non-interactive" lib/index.js`
Expected: build 写 lib/index.js；两个 grep 各输出 ≥1（esbuild 产物含目标文本；中文若转义不影响 ASCII 规则文本）。

- [ ] **Step 5: 全量测试 + 提交**

Run: `npm test`
Expected: 全部通过（纯文本改动不影响现有套件）。
Commit:
```bash
git add src/index.js lib/index.js
git commit -m "feat: ssh_exec→ssh_write fallback rule in tool descriptions"
```

### Task 2: 版本/CHANGELOG 与打包

**Files:**
- Modify: `package.json`（`"version": "0.2.26"` → `"0.2.27"`）
- Modify: `CHANGELOG.md`（`## 0.2.26` 之上插入 0.2.27 小节）
- Produce: `release/dsh-ssh-ops-0.2.27.tgz`

**Interfaces:**
- Consumes: Task 1 的 src/lib 改动
- Produces: 0.2.27 的 package.json、CHANGELOG、tgz

- [ ] **Step 1: 改版本与 CHANGELOG**

`package.json:4` → `"version": "0.2.27"`。

CHANGELOG 顶部插入：
```markdown
## 0.2.27

- **工具规则：exec 无法执行时自动改用 ssh_write**。ssh_exec 描述新增回退指引：exec 通道失败或命令需要交互 TTY 时，用 ssh_write 发送命令+回车并配合 ssh_read 读取输出（PTY 回退无退出码需向用户说明）；Permission denied 时提示用户到终端手动切 root（sudo -i / su -）后继续；危险命令被安全拦截（确认卡）时禁止用 ssh_write 绕行。ssh_write 描述补充选型提示：非交互一次性命令优先 ssh_exec。
```

- [ ] **Step 2: 打包**

Run: `npm run build && npm run pack:release`
Expected: `release/dsh-ssh-ops-0.2.27.tgz` 生成（zip 跳过为预期，Windows 无 zip）。

- [ ] **Step 3: 提交**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: release 0.2.27"
```

### Task 3: 发布 v0.2.27

**Files:** 无（git + GitHub）

**Interfaces:**
- Consumes: Task 2 的 commit 与 tgz
- Produces: 远程 tag `v0.2.27`、GitHub Release v0.2.27 + 附件 tgz

- [ ] **Step 1: tag + push**

```bash
git tag v0.2.27 && git push origin main --tags
```

- [ ] **Step 2: 建 GitHub Release 并上传附件（沿用既有流程：API 用真实仓库名路径建 release；上传用 uploads.github.com/repositories/1353082086/… 仓库 ID 形式）**

Body 用 0.2.27 变更说明；附件 `release/dsh-ssh-ops-0.2.27.tgz`（name=dsh-ssh-ops-0.2.27.tgz）。

- [ ] **Step 3: 验证**

从 API 回读 release（tag/正文/资产 uploaded），输出发布页 URL。
