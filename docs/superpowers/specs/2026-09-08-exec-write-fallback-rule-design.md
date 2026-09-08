# ssh_exec → ssh_write 回退规则（0.2.27）设计

日期：2026-09-08
状态：已获用户批准（2026-09-08）

## 背景与目标

`ssh_exec`（独立 exec 通道）与 `ssh_write`（真实 PTY 终端打字）是两种执行模型，各有不可替代的场景。实际使用中模型遇到「exec 无法执行」时缺少明确的下一步指引，导致执行中断或误用工具。

目标：在**工具描述**层面加入默认规则——当 `ssh_exec` 无法执行时（exec 通道失败 / 命令需要交互 TTY / 权限不足），自动改走 `ssh_write` 完成命令；同时明确两条安全边界（危险命令拦截不得绕行、PTY 回退无退出码需说明）。

## 方案决策

- 载体：**纯工具描述文本**（agent 规则），宿主执行逻辑零改动。
- 用户已确认：优先工具描述方案（而非代码级自动回退或两者兼有）。

## 改动范围

| 文件 | 改动 |
|---|---|
| `src/index.js` | 修改 `ssh_exec` 与 `ssh_write` 两个工具的 `description` 字段（`registerTools` 内） |
| `lib/index.js` | 重新 build 生成（跟踪产物） |
| `package.json` | 版本 0.2.26 → 0.2.27 |
| `CHANGELOG.md` | 新增 0.2.27 一条 |

不新增参数、不改 output schema、不动安全拦截/确认卡代码。

## 描述规则内容（英文，面向模型的工具文本）

### ssh_exec description 追加

> If exec fails or the command needs an interactive TTY (exec-failed, sudo password, menu prompts), do not give up — fall back to ssh_write: send the same command with a trailing Enter, then poll ssh_read until output settles (bounded), and report it. A PTY fallback has no exit code — state that to the user. On permission-denied errors, ask the user to switch to root in the terminal (sudo -i / su -) first, then continue via ssh_write. Never use ssh_write to bypass a safety-blocked command — blocked commands require the human confirmation card, not a workaround.

### ssh_write description 追加一句

> Prefer ssh_exec for non-interactive one-shot commands (it returns an exit code); use ssh_write for interactive TTY work or as the fallback when ssh_exec cannot run the command.

## 触发场景与边界（用户确认）

触发回退：
1. exec 通道失败 / 被服务器拒绝（exec-failed）。
2. 命令需要交互/TTY（sudo 密码、菜单、vim 等）。

边界（描述中强制写明）：
1. 危险命令被安全策略拦截（弹确认卡）时，**禁止**用 ssh_write 绕行，必须走人工确认流程。
2. ssh_write 回退没有 exit code，需配合 ssh_read 读取输出，并在汇报中向用户说明。
3. 权限不足（Permission denied）时，先提示用户在右侧终端手动切换 root（sudo -i / su -），再继续用 ssh_write 执行。

## 验证

- `npm test` 全部通过（现有套件不受影响——纯文本改动）。
- `node --check src/index.js` 通过。
- grep 构建产物 `lib/index.js`，确认两条新规则文本存在。

## 发布（用户既定流程）

1. 版本 bump 至 0.2.27；CHANGELOG 记录。
2. build（host + client）+ `npm run pack:release` → `release/dsh-ssh-ops-0.2.27.tgz`。
3. git commit → tag `v0.2.27` → push。
4. 建 GitHub Release v0.2.27 并上传 tgz（沿用 bsfg/dsh-ssh-ops + 仓库 ID 上传方式）。

## 非目标

- 不做宿主代码级自动回退。
- 不改 ssh_write/ssh_exec 的参数与返回结构。
- 不改变任何安全拦截/确认卡行为。
