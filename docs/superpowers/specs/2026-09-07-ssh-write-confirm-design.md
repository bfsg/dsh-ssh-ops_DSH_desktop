# 设计：ssh_write 危险命令回车 → 人工确认卡片

> 日期：2026-09-07 · 仓库：dsh-ssh-ops（基线 v0.2.21）· 状态：用户已确认（复用现有 pendingConfirmations 机制）

## 1. 背景与问题

插件有安全边界：`ssh_exec` 遇危险命令会走"拦截 + SSH 面板确认卡片（执行/撤销）"（`src/index.js` 的 `pendingConfirmations` + 客户端每秒轮询模态）。但 **`ssh_write`** 路径没有这个待遇：agent/用户在终端输入危险命令并回车时，`prepareTerminalInput` 直接清行（Ctrl-U）+ 终端黄字 + 向 Agent 返回 `unsafe-command` 错误，**没有人工二次确认入口**，命令只能作罢或靠人手动重敲（绕过安全门）。

用户需求：遇到被安全边界拦截的命令时，弹出**人工确认执行界面**（二次确认），由人点击执行。

实测确认：`ssh_exec` + 已开终端时确认卡片工作正常（复现过、弹窗有按钮）；本设计只补 **`ssh_write` 回车拦截**缺口（用户选定范围，不含 sftp_delete/db 等）。

## 2. 目标与非目标

### 目标
1. `ssh_write`（`press_enter:true` 或输入含回车）提交的命令被 `assessShellCommand` 判定为危险时，生成**与 ssh_exec 相同的待确认项**，SSH 面板弹出既有模态卡片（含命令、原因、"执行/撤销"按钮）。
2. 点「执行」→ 命令经该终端真实提交执行（`\x15`+命令+回车，绕过安全门——人工已确认）。
3. 点「撤销」→ 仅作废待确认项（行已被清），命令不执行。
4. 与 ssh_exec 卡片同一队列、同一 RPC、同一渲染，客户端**零改动**。

### 非目标
- 不改 `ssh_exec`、`sftp_delete`、`db_execute` 现有确认路径。
- 不新增独立 pending 类型/RPC/客户端 UI。
- 不改 `press_enter:false`（未回车）行为。

## 3. 根因（代码定位）

`src/index.js`
- `prepareTerminalInput(session, text)`（~L1734）：逐字符流式处理；遇到 `\r`/`\n` 时用 `session.inputLine`（终端行镜像）调 `assessShellCommand`；`ok:false` 分支只做 `forwarded += "\x15"`（清行）+ 终端黄字 + 记 `blockedReason`，**不产生待确认项**，且不把被拦命令传出。
- `writeToConnection(connectionId, input)`（~L1704）：逐 session 调 `prepareTerminalInput` 后只聚合 `blockedReason` 并返回 `fail("unsafe-command", ...)`。
- 现有可复用设施：`prefillBlockedCommand`（入队样例）、`pendingConfirmations` Map、`pendingConfirmationApprove`（对 `prefilled:false` 项执行 `session.stream.write("\x15"+command+"\r")`）、`pendingConfirmationCancel`、客户端轮询模态——全部可直接复用。

## 4. 行为契约（验收口径）

1. 连接虚拟服务器（如 127.0.0.1:2222）并开着终端；`ssh_write` 输入 `rm -rf /tmp/x`（自动回车）→ Agent 收到 `unsafe-command` 错误；右侧面板弹出「⚠️ 检测到危险命令等待确认」卡片（命令 `rm -rf /tmp/x`）。
2. 点「撤销」→ 卡片消失、终端无该命令执行痕迹（行已被清）。
3. 再输入同命令并回车 → 点「执行」→ 命令真实提交执行（虚拟 cmd 下 `rm` 会报"不是内部或外部命令"即证明已提交执行）。
4. `ssh_exec` 危险命令拦截弹卡行为回归不变。
5. 安全命令经 `ssh_write` 回车正常执行（回归）。
6. 同一 session 相同命令已有待确认项时不重复入队。

## 5. 实现要点（仅 src/index.js）

1. `prepareTerminalInput`：在 `\r`/`\n` 被拦分支，把**清行前的** `session.inputLine` 记录为 `blockedCommand`（`??=` 只取首个），返回值扩展为 `{ forwarded, blockedReason, blockedCommand }`。
2. `writeToConnection`：对每个 live session，`guarded.blockedCommand` 非空（且 `conn` 有该 session）时调用新私有方法 `queueWriteConfirmation(connectionId, session, command, reason)`；循环后仍按现状返回 `unsafe-command` 错误给 Agent。
3. 新方法 `queueWriteConfirmation`（放在 `prefillBlockedCommand` 附近）：
   - 去重：遍历 `pendingConfirmations`，同 `sessionId` + 同 `command` 已存在则跳过；
   - 否则构造与 exec 卡同构记录 `{ confirmationId: randomUUID(), connectionId, sessionId, name: conn.name, host: conn.host, command, reason, createdAt: new Date().toISOString(), prefilled: false }` 存入 `pendingConfirmations`；
   - `appendTerminalNotice(session, "危险命令已被拦截并弹出确认卡片，请在右侧 SSH 面板点击“执行”或“撤销”：<command>")`。
4. 执行/撤销复用既有 `pendingConfirmationApprove` / `pendingConfirmationCancel`：`prefilled:false` 分支天然适用（approve 会 `\x15`+命令+回车提交）。

## 6. 边界

- 命令为空/纯空白时不入队（只有实际内容被拦才弹卡）。
- 同一输入串中多条危险行：只为首条建卡（`??=`），其余照旧清行提示（防卡片风暴）。
- `session.exited !== null` 或已无流：按现状跳过该 session，不入队。
- Agent 收到错误后不得自行重试/绕行；终端黄字与工具错误文本均引导人工在面板操作。

## 7. 验证

1. `npm run build:host` 通过；`npm test` 全绿（回归）。
2. 打包 `dsh-ssh-ops-0.2.22.tgz` → 同步 `lib/index.js`（host 半）到桌面 harness 两处副本（`harness/plugins/dsh-ssh-ops` 与 `harness/profiles/web/node_modules/dsh-ssh-ops`）→ 重启 DSH Desktop。
3. 手动清单 = 第 4 节 6 条。

## 8. 涉及文件

- `src/index.js` —— 唯一改动（`prepareTerminalInput` 返回值、`writeToConnection` 入队、新增 `queueWriteConfirmation`，预计 +30/-2）。
- 参考（只读）：`src/index.js` L1043-1060（回车守卫）、L1167-1206（approve/cancel）、L1639-1701（prefill 样例）。
