# DSH SSH Ops

> DeepSeek Harness 的 SSH 运维插件：在主对话中驱动当前服务器，同时在右侧保留真实的交互式终端。

![License](https://img.shields.io/badge/license-MIT-green)
![DSH](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue)

## 示例

主对话可以读取当前 SSH 服务器的结构化执行结果，并直接给出内存状态分析：

![主对话分析 SSH 服务器内存](/assets/screenshots/ssh-memory-analysis.png)

也可以检查服务器上是否部署了数据库服务，并把结论与右侧真实终端输出对应展示：

![主对话检查 SSH 服务器数据库服务](/assets/screenshots/ssh-database-inspection.png)

## 能做什么

- 在会话右侧打开可调整宽度的 xterm.js SSH 终端。
- 保存服务器名称、地址、端口、用户名和认证类型；**绝不保存**密码、私钥或私钥口令。
- 主对话自动识别当前右侧已连接服务器，无需向用户索取内部连接 ID。
- Agent 发出的 `ssh_exec` 命令会显示在右侧终端，并将退出码、输出、耗时、超时和截断状态回传给主对话分析。
- 对手动终端输出提供按需 `ssh_read` 读取；不会静默把人工终端内容塞入对话上下文。
- 输出给模型前会脱敏私钥、Bearer Token、常见密码/API Key 和数据库连接口令。

## 安全边界

DSH 自身权限机制仍然有效。本插件额外阻止 Agent 工具执行明显不可逆或破坏性操作，例如删除文件、删库、格式化磁盘、`terraform destroy`、`kubectl delete`、`docker prune`、强制 Git 清理以及重启/关机。

需要执行此类高危操作时，必须由操作者在右侧 SSH 终端中亲自输入。普通运维操作（配置 SSL、安装软件包、修改配置、重载服务等）可以正常通过 DSH 的权限流程执行。

## 安装

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:caoyiwei850/dsh-ssh-ops#v0.1.0
```

安装后重启 DSH Web：

```bash
dsh web
```

然后打开任意会话，点击顶部的 **SSH** 标签，使用右侧面板连接服务器。

### 从发布压缩包安装

从 GitHub Releases 下载 `dsh-ssh-ops-0.1.0.tgz` 后：

```bash
dsh plugin --profile web add /path/to/dsh-ssh-ops-0.1.0.tgz
dsh web
```

`dsh-ssh-ops-0.1.0.zip` 适用于离线审阅或二次开发；解压后可在目录中执行 `npm install && npm run build`。

## 使用方式

1. 打开顶部 **SSH** 标签，点击 `+`。
2. 填写主机、端口、用户名，选择密码或私钥认证；PEM / `.key` 文件可直接导入。
3. 连接成功后终端自动打开。
4. 在主对话中直接说“查询服务器内存使用情况”或“配置 Nginx SSL 证书”。主 Agent 会使用当前连接执行并分析结果。

### Agent 工具

| 工具 | 用途 |
| --- | --- |
| `ssh_connect` | 建立 SSH 连接并设为当前服务器 |
| `ssh_exec` | 在当前服务器执行 Agent 命令并返回结构化输出 |
| `ssh_read` | 按需读取右侧终端缓冲输出 |
| `ssh_write` | 向当前终端写入交互输入 |
| `ssh_disconnect` | 断开当前连接 |

## 开发

```bash
npm install
npm test
npm run build
npm run pack:release
```

生成物位于 `release/`：

- `dsh-ssh-ops-0.1.0.tgz`：可直接被 DSH 安装。
- `dsh-ssh-ops-0.1.0.zip`：完整离线源码包。

## 许可

[MIT](LICENSE)
