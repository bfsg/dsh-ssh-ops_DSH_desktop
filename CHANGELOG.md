# Changelog

## 0.2.10

- Compatible with DSH-better-sidebar: the SSH drawer now docks to the left of an open right sidebar and yields the collapsed sidebar's top-right toggle cluster.

## 0.2.9 - 2026-08-20

- **高危命令预填确认**：Agent 触发删除/销毁类命令（`rm`、`DROP`、`mkfs`、`docker prune`、`kubectl delete`、`terraform destroy`、强制 Git 清理、重启/关机等）时，不再仅返回一段拒绝文本。插件现在会把该命令**预填进右侧 SSH 终端的输入行**（不附回车），并贴一行黄色提示「已为你预填命令，按 Enter 执行 / Ctrl-C 取消」，操作者确认后按一下 Enter 即可执行、按 Ctrl-C 取消，免去复制/sshpass 的来回折腾，仍保留「最后一下由人按下」的安全模型。
- **修复拦截后无可复制命令**：此前 `ssh_exec` 命中安全策略时直接抛错、错误分支不进 `render`，导致对话里拿不到可复制的命令（取决于模型是否重写）。现在改为返回带 ```bash 代码块的命令卡片；未打开终端会话或命令含 Tab 等控制字符无法安全预填时，自动降级为该复制卡片。
- **防 Agent 重试/绕行级联**：拦截改返回成功形状卡片后，Agent 不再因 tool error 反复重试（此前约 3 次/秒），也消除了"删不掉→核心目标完不成→自行下载 sshpass 绕行→刷屏"的级联诱因。卡片与拦截文案均显式标注「未执行」「请勿重试/绕行」「由人工确认执行」。局限：黑名单为关键词级、非沙箱，`python -c "os.remove(...)"` 等不含关键词的调用理论上可绕过字符串匹配——靠卡片文案告诫 Agent 勿绕行兜底，执意绕行属 LLM 行为问题，非插件层能完全根治。
- **拦截提示精简**：测试反馈拦截提示过长、关键信息（未执行/请勿重试/由人确认）可能被界面截断。已将 `ssh_exec`/`sftp_delete`/`db_execute` 卡片与 `ssh_write` 拦截文案压缩为单行标题 + 命令/代码块 + 一行告诫，重要信息前置可见。
- **`sftp_delete` 收口**：此前 `sftp_delete` 完全无安全检查、Agent 可直接删文件/目录。现统一改为不直接执行，而是把等价 `rm -rf <POSIX 引用的路径>` 预填进右侧终端（或降级为复制卡片），由操作者按 Enter 确认。
- **SQL 判断机制优化**：数据库增删改查远比系统操作频繁，旧的全文本正则会把字符串字面量/注释/列名里的 `DROP`/`TRUNCATE`/`SHUTDOWN` 关键字误杀（如 `INSERT ... VALUES('...TRUNCATE...')`）。改为按**语句动词**识别：跳过字符串/注释、按 `;` 切分多语句，仅拦截首动词为 `DROP`/`TRUNCATE`/`SHUTDOWN` 的语句，多语句注入 `SELECT 1; DROP TABLE x` 仍被拦。`DELETE FROM`（无 WHERE）维持放行（事务内常见合法批量操作）。
- **`db_execute` 拦截改卡片**：高危 SQL 不再抛错，改为返回带 ```sql 代码块的卡片，供操作者粘贴到数据库面板的 SQL 编辑器手动执行。
- **会话镜像漂移修复**：右侧终端的人工按键（raw `write()` 路径）现在会同步 `inputLine`/`inputKnown` 镜像。此前人工在终端敲入的删除行对 Agent 的按键门不可见，存在被后续 Agent 发送的 Enter 偷渡提交的风险；现已根除。
- `ssh_cluster` 同步适配新的拦截返回形状，集群场景下的高危命令按各连接报告 blocked 而非崩溃。

## 0.2.8 - 2026-08-18

- **`db_connect` 自动 SSH 隧道**：不再要求 Agent 提供内部连接 id。未传 `ssh_connection_id` 时新增 `via_ssh` 参数（`auto` 默认 / `yes` / `no`）：`auto` 下 host 为回环地址（127.0.0.1 / localhost / ::1）且当前已连接服务器时，自动通过当前服务器建立隧道访问其内网数据库；`yes` 强制走当前服务器；`no` 强制直连本机。显式 `ssh_connection_id` 优先级最高。
- **输出脱敏补强**：裸 `sk-` 开头的 API Key（无 `KEY=` / `Authorization:` 前缀，如 `export OPENAI_API_KEY="sk-..."` 或日志里的 `sk-...`）现在也会被脱敏为 `sk-***`。
- **修复 `render()` 返回类型**：`sftp_list` / `sftp_read` / `sftp_write` / `sftp_mkdir` 等工具的 `render` 改为返回 `ContentBlock[]`，避免 DSH 会话出现 `content.some is not a function` 崩溃。
- **修复 `tunnel_list` 返回字段**：`targetHost` / `targetPort` 在本地转发（无目标字段）时不再序列化为 `undefined`，避免工具返回值校验失败损坏会话。

## 0.2.7 - 2026-08-18

- **修复工具 output schema 字段缺失导致会话损坏**：`tunnel_list` 缺 `targetHost`/`targetPort`/`active`，`tunnel_start`（remote 类型）缺 `targetHost`/`targetPort`。工具返回值不通过 `additionalProperties: false` 校验时，DSH 无法生成合法 tool-result，导致会话历史出现"有 tool-call 无 tool-result"的消息，会话永久损坏（`SessionPersistenceCorruptionError`）。
- 0.2.5 已修复的 `sftp_list` 缺 `mode` 字段属同一类问题。

## 0.2.6 - 2026-08-18

- **彻底修复 Windows 端 persona 冲突**：移除全部 `@deepseek-ai/*` 的 `peerDependencies` 声明（cordis / dsh-tools / dsh-credentials / dsh-storage-domain / dsh-typert-protocol），防止 pnpm 安装时将这些核心包连同其子依赖（dsh-system-prompt 等）重复安装到 profile 插件层，导致 `deployment:persona` 被注册两次。运行时由 Node 模块解析从 DSH 运行时的 node_modules 加载单一实例。
- 0.2.5 的 `dsh.client.inject` 精简保留。

## 0.2.5 - 2026-08-18

- 修复 Windows 端安装后模型选择/会话恢复报错 `prompt section "deployment:persona" is already registered`：精简 `dsh.client.inject` 列表，移除 DSH 核心包的重复声明（仅保留 `dsh-client-runtime`），避免 bundle 构建时重复注入。
- 修复 `sftp_list` 工具 output schema 缺少 `mode` 字段导致返回校验失败。

## 0.2.4 - 2026-08-17

- 数据库「已保存」列表支持折叠/展开，带数量标记。
- 已保存的数据库资源支持重命名（✎ 按钮），便于区分同名默认连接（如 redis:127.0.0.1）。
- 打开数据库标签时不再自动弹出「新建连接」表单。
- README 截图路径修复为绝对 URL，新增数据库管理和 SSH 资产管理截图。

## 0.2.3 - 2026-08-17

- 新增**数据库功能**：支持连接 MySQL / PostgreSQL / Redis / MongoDB 四种数据库。
  - 新增「数据库」页签：左侧连接列表（可拖动分隔线调整宽度）+ 右侧 SQL/命令编辑器 + 结果表格；Ctrl/Cmd+Enter 执行。
  - SQL 库自动判断读写：SELECT/SHOW/DESC 走只读查询（db_query），其余走写操作（db_execute）；Redis 输命令（db_run），MongoDB 输 collection+operation+filter。
  - 支持 SSH 隧道访问内网数据库（选 SSH 资源后 host 默认 127.0.0.1）；支持 SSL 三档（disabled / preferred / verify）适配云托管数据库。
  - 数据库连接可保存为资源（profile），重启后一键重连；密码加密存储于 DSH 凭据库。
  - 高危 SQL（DROP DATABASE/SCHEMA/TABLE、TRUNCATE、SHUTDOWN）自动拦截。
  - 新增 8 个 Agent 工具：`db_connect` / `db_list_connections` / `db_query` / `db_execute` / `db_list_tables` / `db_describe_table` / `db_run` / `db_disconnect`。
- 修复深色模式下设置面板「新增 SSH 资源」弹窗文字不可见：CSS token 名从错误的 `--dsw-alias-background` / `--dsw-alias-border` / `--dsw-alias-brand` 修正为 `--dsw-alias-bg-overlay` / `--dsw-alias-border-l2` / `--dsw-alias-brand-primary`。
- 修复 esbuild 打包 mysql2 等 DB 驱动导致的 ESM `require("node:buffer")` 报错：将 mysql2/pg/redis/mongodb 设为 external，运行时从 node_modules 原生加载。
- 标签栏「批量执行」改为「批量」。

## 0.2.2 - 2026-08-17

- 修复 SSH 连接空闲后静默断开的问题：连接启用 keepalive（20 秒间隔、3 次判定），NAT/防火墙不再丢弃空闲连接，坏链接也能快速被发现。
- 新增断线自愈：传输意外断开后自动重连（指数退避，上限 30 秒）；执行命令、开终端、SFTP、隧道操作前会等待连接恢复，命令中途掉线自动透明重试一次，不再需要手动重新连接。
- 新增瞬时连接失败重试：网络抖动或服务器瞬时拒绝（如扫描器高峰期）时自动重试 3 次（退避间隔），认证失败除外。
- 显式断开或插件卸载不会触发自动重连；重连成功后远程隧道自动重新注册。

## 0.2.1 - 2026-08-16

- Files tab: single-click selects, double-click opens folders (or downloads files); download/rename/delete buttons appear inline on the selected row.
- Files tab: folder and file icons now render as SVG (yellow folder, white file) instead of emoji.
- Tab switching keeps the terminal session alive (tabs hide with CSS instead of unmounting, so xterm output is preserved).
- Added an error boundary per tab so a crash in Files/Tunnels never closes the SSH panel.
- Tab labels always show in Chinese.
- Replaced README screenshots with the new main view, files tab, and tunnels tab.

## 0.2.0 - 2026-08-16

- Added a **Files** tab to the SSH panel: browse the connected server's filesystem over SFTP, with directory listing, upload, download, mkdir, delete, and rename.
- Added a **Tunnels** tab to the SSH panel: start/stop local port forwards (host → server-reachable target) and remote port forwards (server → this machine), with a live tunnel list.
- Added Agent tools: `sftp_list`, `sftp_read`, `sftp_write`, `sftp_mkdir`, `sftp_delete`, `sftp_rename`, `tunnel_start`, `tunnel_list`, and `tunnel_stop`.

## 0.1.1 - 2026-08-16

- Added Settings → Plugins → SSH Resources for durable server inventory management.
- Removed the previous 20-server cap; resources can now be organized into any number of named groups.
- Stored server metadata in DSH local storage and passwords, PEM private keys, and passphrases in DSH's owner-only local credentials provider.
- Added saved-resource connect, safe credential replacement/clearing, resource deletion isolation, and non-persistent temporary connections.
- Kept the top SSH action focused on showing or hiding the right-side terminal, while the Agent is restricted to the active connection and cannot inspect saved credentials.
- Fixed the SSH terminal action so it mounts only beside Conversation / Trajectory, not in the Settings plugin tabs.
- Fixed SSH Resources text, controls, and status colors to inherit the active DSH appearance, including dark mode.

## 0.1.0 - 2026-08-15

- Initial DSH SSH operations plugin release.
- Right-side resizable xterm.js terminal with password and PEM/private-key authentication.
- Current-connection Agent tools: `ssh_connect`, `ssh_exec`, `ssh_read`, `ssh_write`, and `ssh_disconnect`.
- Structured command evidence, bounded output capture, model-side secret redaction, and prompt restoration.
- Guardrails that block destructive Agent commands while retaining manual operator control in the terminal.
