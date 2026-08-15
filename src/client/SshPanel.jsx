/**
 * The right-side SSH terminal panel: a floating panel pinned to the right edge
 * of the conversation view. Shows a connection toolbar, an xterm.js terminal
 * for the active session, and a connect dialog.
 */
import * as React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { XTERM_CSS } from "./xterm-css.js";
import { useSshUi, sshUiSetActive, sshUiSetBusy, sshUiSetConnections, sshUiSetError, sshUiSetOpen } from "./store.js";

const { useEffect, useRef, useState } = React;

let stylesInjected = false;
const PANEL_LAYOUT_STYLE_ID = "dsh-ssh-ops-panel-layout";
const PANEL_WIDTH_KEY = "dsh-ssh-ops.panel-width";
const SERVER_PROFILES_KEY = "dsh-ssh-ops.server-profiles.v1";
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 720;

function maxPanelWidth() {
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.floor(window.innerWidth * 0.7)));
}

function clampPanelWidth(width) {
  return clamp(Math.round(width), PANEL_MIN_WIDTH, maxPanelWidth());
}

function initialPanelWidth() {
  try {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored)) return clampPanelWidth(stored);
  } catch {}
  return 480;
}

/** Persist connection coordinates only. Passwords and private keys never go to localStorage. */
function loadServerProfiles() {
  try {
    const value = JSON.parse(localStorage.getItem(SERVER_PROFILES_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((profile) =>
      profile &&
      typeof profile.id === "string" &&
      typeof profile.host === "string" &&
      typeof profile.port === "string" &&
      typeof profile.username === "string" &&
      (profile.authKind === "password" || profile.authKind === "key")
    ).slice(0, 20);
  } catch {
    return [];
  }
}

function serverProfileFromForm(form) {
  const host = form.host.trim();
  const port = String(Number(form.port) || 22);
  const username = form.username.trim();
  return {
    id: `${username}@${host}:${port}`,
    name: form.name.trim(),
    host,
    port,
    username,
    authKind: form.authKind
  };
}

function persistServerProfile(profile, profiles) {
  const next = [profile, ...profiles.filter((item) => item.id !== profile.id)].slice(0, 20);
  try {
    localStorage.setItem(SERVER_PROFILES_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `${XTERM_CSS}

/*
 * The shell overlay does not reserve layout space on its own.  When the SSH
 * drawer is open, make the main conversation column yield the drawer width so
 * text never continues underneath the terminal.  The class suffix is emitted
 * by DSH's CSS modules and is stable across its hashed prefix.
 */
html[data-dsh-ssh-ops-panel-open] [class*="centerCol"] {
  margin-right: var(--dsh-ssh-ops-panel-space, 496px) !important;
  transition: margin-right 160ms ease;
}

/* On narrow screens, preserving a usable conversation column matters more
 * than a permanent split view, so the terminal remains an overlay. */
@media (max-width: 900px) {
  html[data-dsh-ssh-ops-panel-open] [class*="centerCol"] {
    margin-right: 0 !important;
  }
}`;
  document.head.appendChild(style);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** One xterm instance bound to one host session via long-poll reads. */
function XtermView({ api, sessionId, connectionId }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    ensureStyles();
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 5000,
      // Some remote commands produce LF-only text. Treat it as a normal
      // terminal newline so rows do not continue at the previous column.
      convertEol: true,
      theme: { background: "#101418" }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;
    term.open(containerRef.current);
    fit.fit();

    let alive = true;
    let resizeObserver = null;
    let writeQueue = Promise.resolve();

    const onData = (data) => {
      writeQueue = writeQueue.then(() => api.write(sessionId, data)).catch(() => {});
    };
    term.onData(onData);

    const loop = async () => {
      while (alive) {
        try {
          const { data, exit } = await api.read(sessionId, 300);
          if (data) term.write(data);
          if (exit !== null) {
            setClosed(true);
            if (alive) term.write(`\r\n\x1b[90m[session exited]\x1b[0m\r\n`);
            return;
          }
        } catch (error) {
          if (!alive) return;
          if (error?.code === "no-session") return;
          // transient; keep polling
        }
      }
    };
    loop();

    const onResize = () => {
      try {
        fit.fit();
        const dims = term.cols && term.rows ? { cols: term.cols, rows: term.rows } : null;
        if (dims && alive) api.resize(sessionId, dims.cols, dims.rows).catch(() => {});
      } catch {}
    };
    resizeObserver = new ResizeObserver(onResize);
    if (containerRef.current) resizeObserver.observe(containerRef.current);

    return () => {
      alive = false;
      resizeObserver?.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId, connectionId, api]);

  return (
    <div style={panelStyles.xtermWrap} ref={containerRef} data-closed={closed || undefined} />
  );
}

function ConnectDialog({ api, onClose }) {
  const [form, setForm] = useState({
    name: "",
    host: "",
    port: "22",
    username: "root",
    authKind: "password",
    password: "",
    privateKey: "",
    passphrase: ""
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [keyFileName, setKeyFileName] = useState(null);
  const [profiles, setProfiles] = useState(loadServerProfiles);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const keyFileInputRef = useRef(null);

  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    sshUiSetError(null);
    setStatus("正在连接服务器，最多需要 20 秒…");
    try {
      const auth =
        form.authKind === "password"
          ? { kind: "password", password: form.password }
          : { kind: "key", privateKey: form.privateKey, ...(form.passphrase ? { passphrase: form.passphrase } : {}) };
      const connection = await api.connect({
        host: form.host.trim(),
        port: Number(form.port) || 22,
        username: form.username.trim(),
        auth,
        name: form.name.trim() || undefined
      });
      // The service returns a live connection, but it is not useful to the
      // panel until it becomes the active record.  Without this, a successful
      // connect looked exactly like "No connections" to the user.
      sshUiSetActive(connection.connectionId, null);
      await refreshConnections(api);
      const profile = serverProfileFromForm(form);
      setProfiles((current) => persistServerProfile(profile, current));
      setSelectedProfileId(profile.id);
      // The panel is a terminal, not merely a connection list: open the PTY
      // immediately so a successful connection is ready to use at once.
      try {
        const session = await api.openSession(connection.connectionId, 100, 30);
        sshUiSetActive(connection.connectionId, session.sessionId);
      } catch (sessionError) {
        sshUiSetError(`已连接，但无法自动打开终端：${sessionError?.message ?? String(sessionError)}`);
      }
      setStatus(null);
      onClose();
    } catch (err) {
      const message = err?.message ?? String(err);
      setError(message);
      sshUiSetError(message);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const importPrivateKey = async (event) => {
    const file = event.target.files?.[0];
    // Reset first so importing the same file again still triggers change.
    event.target.value = "";
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setError("私钥文件不能超过 1 MB");
      return;
    }
    try {
      const privateKey = await file.text();
      if (!privateKey.trim()) throw new Error("所选私钥文件为空");
      setForm((current) => ({ ...current, privateKey }));
      setKeyFileName(file.name);
      setError(null);
    } catch (err) {
      setError(err?.message ?? "无法读取私钥文件");
    }
  };

  const selectProfile = (event) => {
    const id = event.target.value;
    setSelectedProfileId(id);
    const profile = profiles.find((item) => item.id === id);
    if (!profile) return;
    setForm((current) => ({
      ...current,
      name: profile.name,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authKind: profile.authKind,
      // Secrets are intentionally never persisted in browser storage.
      password: "",
      privateKey: "",
      passphrase: ""
    }));
    setKeyFileName(null);
    setError(null);
  };

  const removeSelectedProfile = () => {
    if (!selectedProfileId) return;
    const next = profiles.filter((item) => item.id !== selectedProfileId);
    try {
      localStorage.setItem(SERVER_PROFILES_KEY, JSON.stringify(next));
    } catch {}
    setProfiles(next);
    setSelectedProfileId("");
  };

  return (
    <div style={panelStyles.dialogBackdrop} onClick={busy ? undefined : onClose}>
      <div style={panelStyles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={panelStyles.dialogTitle}>连接服务器</div>
        {profiles.length > 0 && (
          <div style={panelStyles.savedProfileRow}>
            <label style={{ ...panelStyles.field, flex: 1 }}>
              <span>已保存的服务器</span>
              <select value={selectedProfileId} onChange={selectProfile} style={panelStyles.input}>
                <option value="">选择一台服务器…</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name || profile.host} — {profile.username}@{profile.host}:{profile.port}
                  </option>
                ))}
              </select>
            </label>
            {selectedProfileId && <button type="button" onClick={removeSelectedProfile} style={panelStyles.btnSecondary}>删除</button>}
          </div>
        )}
        <label style={panelStyles.field}>
          <span>名称（可选）</span>
          <input value={form.name} onChange={set("name")} placeholder="my-server" style={panelStyles.input} />
        </label>
        <label style={panelStyles.field}>
          <span>主机</span>
          <input value={form.host} onChange={set("host")} placeholder="192.168.1.100" style={panelStyles.input} />
        </label>
        <label style={panelStyles.field}>
          <span>端口</span>
          <input value={form.port} onChange={set("port")} style={panelStyles.input} />
        </label>
        <label style={panelStyles.field}>
          <span>用户名</span>
          <input value={form.username} onChange={set("username")} style={panelStyles.input} />
        </label>
        <label style={panelStyles.field}>
          <span>认证方式</span>
          <select value={form.authKind} onChange={set("authKind")} style={panelStyles.input}>
            <option value="password">密码</option>
            <option value="key">私钥</option>
          </select>
        </label>
        {form.authKind === "password" ? (
          <label style={panelStyles.field}>
            <span>密码</span>
            <input type="password" value={form.password} onChange={set("password")} style={panelStyles.input} />
          </label>
        ) : (
          <>
            <label style={panelStyles.field}>
              <span>私钥文件（PEM / .key，粘贴或导入）</span>
              <textarea value={form.privateKey} onChange={set("privateKey")} rows={4} style={{ ...panelStyles.input, fontFamily: "monospace" }} />
            </label>
            <div style={panelStyles.keyImportRow}>
              <input
                ref={keyFileInputRef}
                type="file"
                accept=".pem,.key,.rsa,.ed25519,.txt,application/x-pem-file,application/x-pkcs8,text/plain"
                onChange={importPrivateKey}
                style={panelStyles.hiddenFileInput}
              />
              <button type="button" onClick={() => keyFileInputRef.current?.click()} style={panelStyles.btnSecondary}>
                导入 PEM / 私钥文件
              </button>
              <span style={panelStyles.keyImportHint}>{keyFileName ? `已导入：${keyFileName}` : "不会保存到本机"}</span>
            </div>
            <label style={panelStyles.field}>
              <span>私钥口令</span>
              <input type="password" value={form.passphrase} onChange={set("passphrase")} style={panelStyles.input} />
            </label>
          </>
        )}
        {status && <div style={panelStyles.dialogStatus} role="status" aria-live="polite">{status}</div>}
        {error && <div style={panelStyles.dialogError} role="alert">{error}</div>}
        <div style={panelStyles.dialogActions}>
          <button onClick={onClose} disabled={busy} style={panelStyles.btnSecondary}>取消</button>
          <button onClick={submit} disabled={busy || !form.host.trim()} style={panelStyles.btnPrimary}>
            {busy ? "连接中…" : "连接"}
          </button>
        </div>
      </div>
    </div>
  );
}

async function refreshConnections(api) {
  try {
    const { connections } = await api.list();
    sshUiSetConnections(connections);
  } catch (error) {
    sshUiSetError(`无法刷新 SSH 连接列表：${error?.message ?? String(error)}`);
  }
}

export function SshPanel({ api, locale }) {
  const ui = useSshUi();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(initialPanelWidth);
  const panelRef = useRef(null);
  const t = locale?.zh ? zhDict : enDict;

  useEffect(() => {
    if (!ui.open) return;
    refreshConnections(api);
    const timer = setInterval(() => refreshConnections(api), 5000);
    return () => clearInterval(timer);
  }, [ui.open, api]);

  useEffect(() => {
    if (!ui.open) return;

    ensureStyles();
    const root = document.documentElement;
    const syncReservedSpace = () => {
      const width = Math.ceil(panelRef.current?.getBoundingClientRect().width || 480);
      // Keep a small breathing gap between the message column and the drawer.
      root.style.setProperty("--dsh-ssh-ops-panel-space", `${width + 16}px`);
    };

    syncReservedSpace();
    root.dataset.dshSshOpsPanelOpen = "true";
    const observer = new ResizeObserver(syncReservedSpace);
    if (panelRef.current) observer.observe(panelRef.current);

    return () => {
      observer.disconnect();
      delete root.dataset.dshSshOpsPanelOpen;
      root.style.removeProperty("--dsh-ssh-ops-panel-space");
    };
  }, [ui.open]);

  useEffect(() => {
    const onWindowResize = () => setPanelWidth((width) => clampPanelWidth(width));
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

  if (!ui.open) return null;

  const active = ui.connections.find((c) => c.connectionId === ui.activeConnectionId);

  const openSession = async () => {
    if (!active) return;
    sshUiSetBusy(true);
    sshUiSetError(null);
    try {
      const value = await api.openSession(active.connectionId, 100, 30);
      sshUiSetActive(active.connectionId, value.sessionId);
    } catch (err) {
      sshUiSetError(err?.message ?? String(err));
    } finally {
      sshUiSetBusy(false);
    }
  };

  const closeSession = async () => {
    if (!ui.activeSessionId) return;
    try {
      await api.closeSession(ui.activeSessionId);
    } catch {}
    sshUiSetActive(ui.activeConnectionId, null);
  };

  const closePanel = async () => {
    if (active) {
      sshUiSetBusy(true);
      try {
        await api.disconnect(active.connectionId);
      } catch (err) {
        sshUiSetError(`断开 SSH 连接失败：${err?.message ?? String(err)}`);
      } finally {
        sshUiSetActive(null, null);
        await refreshConnections(api);
        sshUiSetBusy(false);
      }
    }
    sshUiSetOpen(false);
  };

  const beginResize = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelRef.current?.getBoundingClientRect().width ?? panelWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onPointerMove = (moveEvent) => {
      // The drawer is anchored at the right, so moving its left edge left makes
      // it wider and moving it right makes it narrower.
      setPanelWidth(clampPanelWidth(startWidth + startX - moveEvent.clientX));
    };
    const endResize = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endResize);
      window.removeEventListener("pointercancel", endResize);
      setPanelWidth((width) => {
        try {
          localStorage.setItem(PANEL_WIDTH_KEY, String(width));
        } catch {}
        return width;
      });
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endResize);
    window.addEventListener("pointercancel", endResize);
  };

  return (
    <div ref={panelRef} style={{ ...panelStyles.root, width: panelWidth }}>
      <div
        style={panelStyles.resizeHandle}
        onPointerDown={beginResize}
        role="separator"
        aria-label="调整 SSH 终端宽度"
        aria-orientation="vertical"
        title="拖动以调整 SSH 终端宽度"
      />
      <div style={panelStyles.header}>
        <span style={panelStyles.title}>{t.panelTitle}</span>
        <button onClick={() => setDialogOpen(true)} style={panelStyles.btnSmall} title={t.connect}>＋</button>
        <button onClick={closePanel} disabled={ui.busy} style={panelStyles.btnSmall} title={t.closePanel}>×</button>
      </div>

      <div style={panelStyles.connBar}>
        {active ? (
          <>
            <span style={panelStyles.connLabel} title={`${active.username}@${active.host}:${active.port}`}>
              {active.name || `${active.username}@${active.host}`}
            </span>
            <span style={panelStyles.dot} />
            {!ui.activeSessionId && (
              <button onClick={openSession} disabled={ui.busy} style={panelStyles.btnTiny}>
                {ui.busy ? t.busy : t.openSession}
              </button>
            )}
            {ui.activeSessionId && (
              <button onClick={closeSession} style={panelStyles.btnTiny}>{t.closeSession}</button>
            )}
          </>
        ) : (
          <span style={panelStyles.connEmpty}>{t.empty}</span>
        )}
      </div>

      {ui.error && <div style={panelStyles.error}>{ui.error}</div>}

      <div style={panelStyles.body}>
        {ui.activeSessionId && active ? (
          <XtermView api={api} sessionId={ui.activeSessionId} connectionId={active.connectionId} />
        ) : (
          <div style={panelStyles.emptyState}>{active ? t.sessionClosed : t.noConnection}</div>
        )}
      </div>

      {dialogOpen && <ConnectDialog api={api} onClose={() => setDialogOpen(false)} />}
    </div>
  );
}

const zhDict = {
  panelTitle: "SSH 终端",
  connect: "连接服务器",
  closePanel: "断开当前连接并关闭 SSH 终端",
  openSession: "打开终端",
  closeSession: "关闭终端",
  empty: "还没有连接。点「＋」添加服务器，或在对话里让我帮你连。",
  sessionClosed: "会话已关闭",
  noConnection: "未连接",
  busy: "忙…"
};

const enDict = {
  panelTitle: "SSH Terminal",
  connect: "Connect",
  closePanel: "Disconnect and close SSH terminal",
  openSession: "Open",
  closeSession: "Close",
  empty: "No connections. Click ＋ to add a server, or ask me in the conversation.",
  sessionClosed: "Session closed",
  noConnection: "Not connected",
  busy: "Busy…"
};

const panelStyles = {
  root: {
    position: "fixed",
    top: 0,
    right: 0,
    bottom: 0,
    width: 480,
    maxWidth: "70vw",
    zIndex: 900,
    display: "flex",
    flexDirection: "column",
    background: "#101418",
    borderLeft: "1px solid #262b33",
    boxShadow: "-8px 0 24px rgba(0,0,0,.35)",
    fontFamily: "var(--dsw-font-family, system-ui, sans-serif)",
    color: "#d7dbe2"
  },
  resizeHandle: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: -5,
    width: 10,
    cursor: "col-resize",
    zIndex: 1,
    touchAction: "none"
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px",
    borderBottom: "1px solid #262b33",
    flex: "none"
  },
  title: { fontSize: 13, fontWeight: 600, flex: 1 },
  btnSmall: {
    background: "transparent",
    border: "1px solid #3a414b",
    color: "#d7dbe2",
    borderRadius: 6,
    width: 26,
    height: 26,
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1
  },
  btnTiny: {
    background: "transparent",
    border: "1px solid #3a414b",
    color: "#d7dbe2",
    borderRadius: 6,
    padding: "2px 8px",
    fontSize: 12,
    cursor: "pointer"
  },
  connBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderBottom: "1px solid #1f242c",
    flex: "none"
  },
  connLabel: { fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  dot: { width: 8, height: 8, borderRadius: "50%", background: "#3fb950", flex: "none" },
  connEmpty: { fontSize: 12, color: "#8b93a1" },
  error: {
    padding: "6px 12px",
    fontSize: 12,
    color: "#f85149",
    background: "rgba(248,81,73,.1)",
    borderBottom: "1px solid rgba(248,81,73,.3)",
    flex: "none"
  },
  body: { flex: 1, minHeight: 0, padding: 8, display: "flex" },
  emptyState: { margin: "auto", fontSize: 12, color: "#8b93a1", textAlign: "center" },
  xtermWrap: { flex: 1, minWidth: 0, overflow: "hidden" },
  dialogBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.5)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  },
  dialog: {
    width: 360,
    maxWidth: "90vw",
    background: "#181c22",
    border: "1px solid #2a303a",
    borderRadius: 12,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    boxShadow: "0 12px 40px rgba(0,0,0,.5)"
  },
  dialogTitle: { fontSize: 14, fontWeight: 600, marginBottom: 2 },
  field: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#9aa3af" },
  input: {
    background: "#101418",
    border: "1px solid #2a303a",
    borderRadius: 6,
    color: "#d7dbe2",
    padding: "6px 8px",
    fontSize: 13,
    outline: "none"
  },
  dialogError: { fontSize: 12, color: "#f85149" },
  dialogStatus: {
    fontSize: 12,
    color: "#9cc8ff",
    background: "rgba(45,108,223,.12)",
    border: "1px solid rgba(45,108,223,.3)",
    borderRadius: 6,
    padding: "7px 8px"
  },
  keyImportRow: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
  hiddenFileInput: { display: "none" },
  keyImportHint: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "#8b93a1" },
  dialogActions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  btnPrimary: {
    background: "#2d6cdf",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 13,
    cursor: "pointer"
  },
  btnSecondary: {
    background: "transparent",
    color: "#d7dbe2",
    border: "1px solid #3a414b",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 13,
    cursor: "pointer"
  }
};
