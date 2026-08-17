# Changelog

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
