# Drop-Zone Guard（文件拖拽上传 vs DSH 全窗蒙层）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让拖到 ssh-ops 文件列表的文件只触发插件上传（DSH 全窗拖放蒙层不再出现/抢占），列表以外区域 DSH 拖放行为原样保留。

**Architecture:** 在 `SshFiles.jsx` 文件列表元素上挂载原生 **capture 阶段**拖拽监听，把携带 `Files` 的事件在到达 DSH 的 document 冒泡监听前 `stopPropagation()`。由于 capture 拦截会让 React 委托的 `onDrag*` 一并失效，拖放的高亮/目录悬停/上传全部改由该原生监听完成（原生单轨），删除原 React 拖放处理器。

**Tech Stack:** 纯前端 React 18（`SshFiles.jsx`）+ esbuild 打包；无新依赖、无 DSH 侧改动。

**Spec:** `docs/superpowers/specs/2026-09-07-drop-zone-guard-design.md`

## Global Constraints

- 只改 ssh-ops 仓库内文件；**禁止**改动 `G:\desktop-dsh\DSH Desktop\resources\app\node_modules\@deepseek-ai\*` 任何 DSH 包。
- 拖放拦截仅在 `dataTransfer.types` 含 `"Files"` 时 `stopPropagation()`；其余拖拽只 `preventDefault()`（防浏览器默认跳转），不拦截。
- 守卫激活条件：`Boolean(connectionId) && !busy && transferMode === "sftp"`；SCP 降级/断连/上传中不挂监听（列表区域回落到 DSH 默认行为）。
- 目录行悬停识别用 `data-dir-name` 属性 + `Element.closest`；`dropDir`/`dragOver` React 状态与渲染样式保持现有变量名与视觉不变。
- 代码风格：2 空格缩进、JSDoc 注释解释"为什么"、中文 UI 文案；无新依赖。
- 版本号按 fork 递增惯例：0.2.20 → 0.2.21；CHANGELOG 顶部按现有格式加条目。

---

### Task 1: SshFiles.jsx 原生拖放守卫

**Files:**
- Modify: `src/client/SshFiles.jsx`（唯一代码改动文件）

**Interfaces:**
- Consumes: `React`（`useEffect/useRef/useState`）、现有 `uploadDrop(dataTransfer, targetDir)`、现有 `cwdRef`、现有 `joinPath`/`dirnameOf`。
- Produces:
  - 模块级 `function useDropZoneGuard(ref, active, onState)`；`onState = { enterDir(name), enterList(), leaveList(), drop(dataTransfer) }`。
  - 模块级 `function closestDirRow(node, root)`（返回 `root` 内带 `data-dir-name` 的最近祖先元素或 null）。
  - 组件内：`const listRef = useRef(null)`、`const dropDirRef = useRef(null)`、`const guardActive = Boolean(connectionId) && !busy && transferMode === "sftp"`。
  - 列表 `<div ref={listRef}>`；目录行 `<div data-dir-name={entry.isDirectory ? entry.name : undefined}>`。

- [ ] **Step 1: 给 React 解构加 useRef**

Old（`src/client/SshFiles.jsx:6`）:
```jsx
const { useEffect, useState } = React;
```
New:
```jsx
const { useEffect, useRef, useState } = React;
```

- [ ] **Step 2: 在 `dirnameOf` 后插入守卫辅助函数与 hook**

Old:
```jsx
function dirnameOf(path) {
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}
```
New（在其后追加）:
```jsx
function dirnameOf(path) {
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

/** Nearest ancestor of `node` inside `root` that carries a data-dir-name row. */
function closestDirRow(node, root) {
  if (!(node instanceof Element)) return null;
  const row = node.closest("[data-dir-name]");
  if (!row || !root.contains(row)) return null;
  return row;
}

/**
 * Native capture-phase guard for the file list drop zone.
 *
 * DSH's chat composer installs DOCUMENT-level (bubble) drag listeners that
 * paint a full-window "drop files here" overlay for ANY file drag. Stopping
 * the event at this element in CAPTURE keeps those overlay listeners from
 * ever seeing a drag that happens over the list, so the host overlay cannot
 * steal the panel's own drop target.
 *
 * Because capture stopPropagation also prevents React's delegated listeners
 * (attached at the React root container) from running, every drag side effect
 * must happen here natively — the old React onDrag* handlers on the list and
 * rows are removed along with this change (they would be dead code).
 */
function useDropZoneGuard(ref, active, onState) {
  const handlers = React.useRef(onState);
  handlers.current = onState;
  React.useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const hasFiles = (event) => {
      const dataTransfer = event.dataTransfer;
      return !!dataTransfer && !!dataTransfer.types && dataTransfer.types.includes("Files");
    };
    const onDragEnter = (event) => {
      if (!hasFiles(event)) return;
      event.stopPropagation();
      const row = closestDirRow(event.target, el);
      if (row) handlers.current.enterDir(row.dataset.dirName);
      else handlers.current.enterList();
    };
    const onDragOver = (event) => {
      event.preventDefault(); // always: keep the browser from navigating on drop
      if (!hasFiles(event)) return;
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      event.stopPropagation();
    };
    const onDragLeave = (event) => {
      if (!hasFiles(event)) return;
      event.stopPropagation();
      const related = event.relatedTarget;
      if (related instanceof Node && el.contains(related)) {
        // Crossing rows inside the list: if we left a directory row (and are
        // not entering that same row's subtree) clear its highlight, stay armed.
        const row = closestDirRow(event.target, el);
        if (row && !(related instanceof Element && row.contains(related))) {
          handlers.current.enterList();
        }
      } else {
        handlers.current.leaveList();
      }
    };
    const onDrop = (event) => {
      event.preventDefault(); // always: never let the page navigate on a drop
      if (hasFiles(event)) event.stopPropagation();
      handlers.current.drop(event.dataTransfer);
    };
    const onDragEnd = () => handlers.current.leaveList();
    const entries = [
      ["dragenter", onDragEnter, true],
      ["dragover", onDragOver, true],
      ["dragleave", onDragLeave, true],
      ["drop", onDrop, true]
    ];
    for (const [name, fn, capture] of entries) el.addEventListener(name, fn, capture);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      for (const [name, fn, capture] of entries) el.removeEventListener(name, fn, capture);
      window.removeEventListener("dragend", onDragEnd);
    };
  }, [ref, active]);
}
```

- [ ] **Step 3: 组件内加 refs（紧邻现有 cwdRef）**

Old:
```jsx
  // Mirror of cwd for post-operation refreshes: a mutation that finishes after
  // the user has navigated elsewhere must refresh the NEW directory, not snap back.
  const cwdRef = React.useRef("/");
```
New（在 `cwdRef` 之后追加）:
```jsx
  const cwdRef = React.useRef("/");
  // Native drop-zone guard (see useDropZoneGuard) + synchronous mirror of the
  // hovered directory row, so a drop reads the dir chosen by the last
  // dragenter without waiting for a re-render.
  const listRef = useRef(null);
  const dropDirRef = useRef(null);
```

- [ ] **Step 4: 在 `uploadDrop` 定义后接线守卫**

Old（`uploadDrop` 结尾）:
```jsx
    } catch (err) {
      setError(`拖拽上传失败：${err?.message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };
```
New（在其后追加）:
```jsx
    } catch (err) {
      setError(`拖拽上传失败：${err?.message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  // Only intercept file drags while a live SFTP session can receive uploads.
  // Disconnected / busy / SCP-fallback leave the zone to DSH's default drop.
  const guardActive = Boolean(connectionId) && !busy && transferMode === "sftp";
  useDropZoneGuard(listRef, guardActive, {
    enterDir: (name) => {
      dropDirRef.current = name;
      setDragOver(true);
      setDropDir(name);
    },
    enterList: () => {
      dropDirRef.current = null;
      setDragOver(true);
      setDropDir(null);
    },
    leaveList: () => {
      dropDirRef.current = null;
      setDragOver(false);
      setDropDir(null);
    },
    drop: (dataTransfer) => {
      const targetDir = dropDirRef.current ? joinPath(cwdRef.current, dropDirRef.current) : null;
      dropDirRef.current = null;
      setDragOver(false);
      setDropDir(null);
      uploadDrop(dataTransfer, targetDir);
    }
  });
```

- [ ] **Step 5: 列表 div 挂 ref、删除失效的 React 拖放处理器**

Old:
```jsx
      <div
        style={{ ...filesStyles.list, ...(dragOver ? filesStyles.listDropTarget : {}) }}
        onDragEnter={(e) => { e.preventDefault(); if (!busy) setDragOver(true); }}
        onDragOver={(e) => { e.preventDefault(); if (!busy) e.dataTransfer.dropEffect = "copy"; }}
        onDragLeave={(e) => {
          const related = e.relatedTarget;
          if (!related || !e.currentTarget.contains(related)) { setDragOver(false); setDropDir(null); }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const targetDir = dropDir ? joinPath(cwd, dropDir) : null;
          setDropDir(null);
          uploadDrop(e.dataTransfer, targetDir);
        }}
      >
```
New:
```jsx
      <div
        ref={listRef}
        style={{ ...filesStyles.list, ...(dragOver ? filesStyles.listDropTarget : {}) }}
      >
```

- [ ] **Step 6: 目录行加 `data-dir-name`、删除行级 React 悬停处理器**

Old:
```jsx
              onClick={() => setSelected(entry)}
              onDoubleClick={() => {
                if (entry.isDirectory) openEntry(entry);
                else download(entry);
              }}
              onDragEnter={() => { if (entry.isDirectory && !busy) setDropDir(entry.name); }}
              onDragLeave={(e) => { if (e.currentTarget === e.target && dropDir === entry.name) setDropDir(null); }}
              title={entry.isDirectory ? `${entry.name}（双击打开；可拖文件到它上面上传进此目录）` : `${entry.name}  (${entry.size} bytes，双击下载)`}
```
New:
```jsx
              data-dir-name={entry.isDirectory ? entry.name : undefined}
              onClick={() => setSelected(entry)}
              onDoubleClick={() => {
                if (entry.isDirectory) openEntry(entry);
                else download(entry);
              }}
              title={entry.isDirectory ? `${entry.name}（双击打开；可拖文件到它上面上传进此目录）` : `${entry.name}  (${entry.size} bytes，双击下载)`}
```

- [ ] **Step 7: 构建客户端验证语法与产物**

Run（仓库根 `G:\deepseek\dsh-ssh-ops-src\dsh-ssh-ops-main`）:
```bash
npm run build:client
```
Expected: exit 0；`lib/client.js` 重新生成；`grep -c "data-dir-name" lib/client.js` > 0（确认新代码进产物）。

- [ ] **Step 8: 自查无残留旧处理器**

Run:
```bash
grep -n "onDragEnter\|onDragOver\|onDragLeave\|onDrop" src/client/SshFiles.jsx
```
Expected: 无匹配（全部已删除；仅 `useDropZoneGuard` 内原生 `addEventListener` 保留）。注意排除注释里的说明文字。

- [ ] **Step 9: Commit**

```bash
git add src/client/SshFiles.jsx
git commit -m "fix(files): guard file list drags from DSH full-window drop overlay"
```

---

### Task 2: 版本号与 CHANGELOG

**Files:**
- Modify: `package.json`（`"version": "0.2.20"` → `"0.2.21"`）
- Modify: `CHANGELOG.md`（顶部插入 0.2.21 条目）

- [ ] **Step 1: 升版本号**

Old: `  "version": "0.2.20",`
New: `  "version": "0.2.21",`

- [ ] **Step 2: CHANGELOG 顶部插入条目**

Old:
```
# Changelog

## 0.2.20 - 2026-09-01
```
New:
```
# Changelog

## 0.2.21 - 2026-09-07

- **修复：文件面板拖拽上传被 DSH 全窗拖放蒙层抢占**。DSH 对话附件在 document 级监听文件拖拽、会为任意区域的文件拖放弹全窗「拖放限制」蒙层。现为文件列表挂载**原生 capture 守卫**，把列表内的文件拖拽拦在 DSH 监听之前：拖到列表只显示插件「松开上传」高亮并正常上传（含整个文件夹、目录行悬停上传），DSH 蒙层不再出现、drop 不会双触发（上传同时把文件塞进对话附件）；列表以外区域 DSH 拖放行为原样保留；蒙层已显示时指针移进/移出列表可正确消退/恢复，不再卡死。实现上拖放处理改由原生事件完成（React 委托事件会被 capture 拦截而失效，原 React onDrag* 处理器相应移除）。

## 0.2.20 - 2026-09-01
```

- [ ] **Step 3: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump to 0.2.21 for drop-zone guard fix"
```

---

### Task 3: 打包与更新桌面 harness 已装插件

**Files:**
- Create: `release/dsh-ssh-ops-0.2.21.tgz`（`npm run pack:release` 产物）
- Modify（安装目标，非本仓库）: `%APPDATA%\dsh-desktop\harness\plugins\dsh-ssh-ops\` 下 `lib/`、`package.json`

- [ ] **Step 1: 全量构建并打包**

Run（仓库根）:
```bash
npm run pack:release
```
Expected: exit 0；`release/dsh-ssh-ops-0.2.21.tgz` 存在。

- [ ] **Step 2: 将新产物同步进桌面 harness 的插件目录（保持 file: 链接布局，不做 pnpm 重装）**

Run（Git Bash；`$APPDATA` 已展开）:
```bash
SRC=/g/deepseek/dsh-ssh-ops-src/dsh-ssh-ops-main
DST="$APPDATA/dsh-desktop/harness/plugins/dsh-ssh-ops"
mkdir -p "$DST"
tar -xzf "$SRC/release/dsh-ssh-ops-0.2.21.tgz" -C "$DST" --strip-components=1
grep -m1 '"version"' "$DST/package.json"
```
Expected: 打印 `"version": "0.2.21"`。

- [ ] **Step 3: 断言 profile 链接仍指向 plugins 目录**

Run:
```bash
ls -la "$APPDATA/dsh-desktop/harness/profiles/web/node_modules/" | grep dsh-ssh-ops
grep -n 'dsh-ssh-ops' "$APPDATA/dsh-desktop/harness/profiles/web/package.json"
```
Expected: `node_modules/dsh-ssh-ops -> ../../plugins/dsh-ssh-ops`（pnpm 符号链接）且依赖/`bundles` 条目存在。

- [ ] **Step 4: 第二实例冒烟启动（不动当前 GUI）**

Run（PowerShell，端口 59998；路径含空格须用桌面捆绑 node）:
```powershell
$node='G:\desktop-dsh\DSH Desktop\resources\app\node_modules\node\bin\node.exe'
$dsh='G:\desktop-dsh\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js'
$patch='G:\desktop-dsh\DSH Desktop\resources\dsh-desktop.patch.yml'
$log="$env:TEMP\dsh-ssh-ops-0.2.21-smoke.log"
& $node $dsh web --patch $patch --no-open --host 127.0.0.1 --port 59998 *> $log 2>&1
```
后台运行约 20 秒后：`curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:59998/` → `401`（服务已起、认证生效、插件未致崩溃）；随后结束该进程。出现 `401` 即通过，非 200（200 说明无认证，环境异常）。

- [ ] **Step 5: 记录手动验证清单（交给用户）**

输出以下 6 条验收口径，请用户在**重启 DSH Desktop**后执行：
1. 对话区拖任意文件 → DSH 蒙层照常出现（回归不变）；
2. 文件列表上拖文件 → 只见插件「松开上传」高亮，无 DSH 蒙层；松手成功上传（含整个文件夹）；
3. 悬停目录行 → 显示「松开上传到目录 xxx」；松手上传进该子目录；
4. DSH 蒙层已显示时把指针移进列表再移出 → 蒙层先退后现、不卡死；
5. 列表内 drop 后，对话附件区**不**出现该文件（无 drop 双触发）；
6. 断开连接后在列表上拖文件 → 恢复 DSH 默认蒙层行为。

---

## Self-Review 记录（写完即查）

- **Spec 覆盖**：验收口径 1-6 ↔ Task 3 Step 5 清单；实现要点（capture 守卫、active 条件、单轨原生、dragend 兜底、data-dir-name）↔ Task 1 Step 2-6；版本/changelog ↔ Task 2。无遗漏。
- **占位符扫描**：无 TBD/TODO；每个代码步骤都给出完整 old/new 或命令。
- **类型一致**：`useDropZoneGuard(ref, active, onState)`、`closestDirRow`、`dropDirRef`、`guardActive`、`data-dir-name` 在 Task 1 各步骤间命名一致；Task 3 引用的 tgz 路径与 `pack:release` 产物命名（`package-release.mjs` 按 package.json version 命名）一致。

## Execution Handoff

待用户选择执行方式后，按 `superpowers:executing-plans`（inline）或 `superpowers:subagent-driven-development` 逐任务执行。
