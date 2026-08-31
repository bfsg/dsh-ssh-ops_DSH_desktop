---
name: test-op
description: 运维测试技能——Use when doing change-before/after verification during ops work. When the user asks to 测试/验证/试一下 a change, deployment, or fix on a server, or before/after deploying, restarting, or reconfiguring services, follow this skill's baseline → verify → report flow.
---

# test-op：运维测试技能

在运维工作中做「变更前验证 / 变更后验证」（test-driven ops）时使用本技能。

## 何时使用
- 用户要求「测试一下 / 验证一下 / 试一下」服务器上的变更或部署。
- 执行部署、配置变更、服务重启前后需要系统性验证。
- 排查问题后需要确认修复是否生效。

## 流程
1. **确认目标环境**：先明确目标是测试环境还是生产环境——测试环境可放心操作，生产环境只做验证性操作并优先只读手段。
2. **变更前基线**：用只读命令记录变更前状态作为对比基线：
   - 服务状态：`systemctl status <svc>` / `ps aux | grep <svc>` / `supervisorctl status`
   - 版本/配置：`<app> --version`、配置文件内容、配置 hash
   - 端口监听：`ss -tlnp` / `netstat -tlnp`
   - 数据：`db_query` 查关键表行数/最新记录
3. **执行变更**（如适用）：经 dsh-ssh-ops 的 `ssh_exec` / `sftp_write` / `db_execute` 等工具完成。
4. **变更后验证**：对照基线逐项核对：
   - 服务是否存活且状态正常
   - 端口是否按预期监听
   - 日志：`journalctl -u <svc> -n 50 --no-pager` / `tail -n 50 <logfile>`
   - 功能探测：`curl -fsS http://127.0.0.1:<port>/health` 等健康检查
   - 数据核对：`db_query` 对比基线
5. **回滚预案**：验证失败时，明确回滚步骤（备份恢复 / 版本回退 / 重启旧配置），必要时先征求用户意见再操作。
6. **汇报**：按「结论 → 证据」汇报，附关键命令输出摘录，不贴大段日志。

## 原则
- 验证优先用只读手段；需要写操作时先向用户说明影响面。
- 一次验证聚焦一个变更，不要混入无关检查。
- 长输出分段或取尾部，避免刷屏；超长命令合理设置 timeoutMs。
