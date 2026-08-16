# Changelog

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
