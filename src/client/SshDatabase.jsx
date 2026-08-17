/**
 * Database tab: connect to MySQL/PostgreSQL/Redis/MongoDB, run SQL or commands,
 * view results. Independent of the SSH terminal — SSH tunneling is optional.
 *
 * Layout: left connection list (always visible) + right editor/result area.
 * Shortcuts: Ctrl/Cmd+Enter executes; Esc closes the connect form.
 */
import * as React from "react";
const { useEffect, useState, useRef, useCallback } = React;

const DB_TYPES = [
  { value: "mysql", label: "MySQL", port: 3306, placeholder: "SELECT * FROM users LIMIT 10" },
  { value: "postgresql", label: "PostgreSQL", port: 5432, placeholder: "SELECT * FROM users LIMIT 10" },
  { value: "redis", label: "Redis", port: 6379, placeholder: "GET mykey" },
  { value: "mongodb", label: "MongoDB", port: 27017, placeholder: "" }
];

const MONGO_OPS = ["find", "findOne", "insertOne", "updateOne", "deleteOne", "countDocuments"];

const READ_PREFIXES = /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i;

function isReadSql(sql) {
  return READ_PREFIXES.test(sql.trim());
}

function typeMeta(type) {
  return DB_TYPES.find((t) => t.value === type) ?? DB_TYPES[0];
}

function typeColor(type) {
  switch (type) {
    case "mysql": return "#4479A1";
    case "postgresql": return "#4169E1";
    case "redis": return "#DC382D";
    case "mongodb": return "#47A248";
    default: return "#8b93a1";
  }
}

function typeLabel(type) {
  return typeMeta(type).label;
}

export function SshDatabase({ api }) {
  const [connections, setConnections] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [sshConns, setSshConns] = useState([]);
  const [sshProfiles, setSshProfiles] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sidebarWidth, setSidebarWidth] = useState(180);
  const draggingRef = useRef(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [dbList, dbProfiles, sshList, sshProfs] = await Promise.all([
        api.dbListConnections(),
        api.dbProfileList().catch(() => ({ profiles: [] })),
        api.list().catch(() => ({ connections: [] })),
        api.profileList().catch(() => ({ profiles: [] }))
      ]);
      setConnections(dbList.connections ?? []);
      setProfiles(dbProfiles.profiles ?? []);
      setSshConns(sshList.connections ?? []);
      setSshProfiles(sshProfs.profiles ?? []);
      setError(null);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Resizable sidebar splitter.
  const startDrag = (e) => {
    e.preventDefault();
    draggingRef.current = { startX: e.clientX, startW: sidebarWidth };
    const onMove = (ev) => {
      const d = draggingRef.current;
      if (!d) return;
      const next = Math.min(420, Math.max(120, d.startW + (ev.clientX - d.startX)));
      setSidebarWidth(next);
    };
    const onUp = () => {
      draggingRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const selected = connections.find((c) => c.dbConnectionId === selectedId) ?? null;

  const handleConnect = async (form) => {
    setError(null);
    try {
      if (form.saveProfile) {
        // Save as durable profile with credential, then connect via profile.
        const saved = await api.dbProfileSave({
          name: form.name?.trim() || `${form.type}:${form.host.trim()}`,
          type: form.type,
          host: form.host.trim(),
          port: Number(form.port) || typeMeta(form.type).port,
          database: form.database?.trim() || undefined,
          username: form.username?.trim() || undefined,
          password: form.password || undefined,
          ssl: form.ssl || "disabled",
          sshProfileId: form.sshProfileId || null
        });
        setShowForm(false);
        await handleProfileConnect(saved.profile.dbProfileId);
        return;
      }
      // Non-profile path: connect directly. If an SSH profile was selected,
      // ensure that SSH profile is connected first to get a runtime connectionId.
      let sshConnectionId = undefined;
      if (form.sshProfileId) {
        const sshResult = await api.profileConnect(form.sshProfileId).catch((e) => { throw new Error(`SSH 连接失败: ${e.message}`); });
        sshConnectionId = sshResult.connectionId;
      }
      const result = await api.dbConnect({
        type: form.type,
        host: form.host.trim(),
        port: Number(form.port) || typeMeta(form.type).port,
        database: form.database?.trim() || undefined,
        username: form.username?.trim() || undefined,
        password: form.password || undefined,
        ssl: form.ssl || "disabled",
        sshConnectionId,
        name: form.name?.trim() || undefined
      });
      setShowForm(false);
      await refresh();
      setSelectedId(result.dbConnectionId);
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  };

  const handleDisconnect = async (dbConnectionId) => {
    setError(null);
    try {
      await api.dbDisconnect(dbConnectionId);
      if (selectedId === dbConnectionId) setSelectedId(null);
      await refresh();
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  };

  const handleProfileConnect = async (dbProfileId) => {
    setError(null);
    try {
      const result = await api.dbProfileConnect(dbProfileId);
      await refresh();
      setSelectedId(result.dbConnectionId);
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  };

  const handleProfileDelete = async (profile) => {
    if (!window.confirm(`删除数据库资源「${profile.name}」？`)) return;
    setError(null);
    try {
      await api.dbProfileDelete(profile.dbProfileId);
      await refresh();
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  };

  const handleProfileRename = async (profile) => {
    const name = window.prompt("重命名数据库资源", profile.name);
    if (name === null || name.trim() === "" || name.trim() === profile.name) return;
    setError(null);
    try {
      await api.dbProfileSave({
        dbProfileId: profile.dbProfileId,
        name: name.trim(),
        type: profile.type,
        host: profile.host,
        port: profile.port,
        database: profile.database ?? undefined,
        username: profile.username ?? undefined,
        ssl: profile.ssl,
        sshProfileId: profile.sshProfileId
      });
      await refresh();
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  };

  const [savedCollapsed, setSavedCollapsed] = useState(false);

  return (
    <div style={dbStyles.root}>
      {/* Connection list (always visible, left pane) */}
      <div style={{ ...dbStyles.sidebar, width: sidebarWidth }}>
        <div style={dbStyles.sidebarHeader}>
          <span style={dbStyles.sidebarTitle}>数据库连接</span>
          <button onClick={() => setShowForm(true)} style={dbStyles.iconBtn} title="新建连接">＋</button>
          <button onClick={refresh} disabled={loading} style={dbStyles.iconBtn} title="刷新">↻</button>
        </div>
        <div style={dbStyles.connList}>
          {/* Saved profiles — click to connect */}
          {profiles.length > 0 && (
            <>
              <div style={dbStyles.sectionLabel} onClick={() => setSavedCollapsed(!savedCollapsed)} title={savedCollapsed ? "展开" : "折叠"}>
                <span style={dbStyles.collapseIcon}>{savedCollapsed ? "▸" : "▾"}</span>
                <span>已保存</span>
                <span style={dbStyles.countBadge}>{profiles.length}</span>
              </div>
              {!savedCollapsed && profiles.map((p) => (
                <div key={p.dbProfileId} style={dbStyles.connItem}>
                  <span style={{ ...dbStyles.typeDot, background: typeColor(p.type) }} />
                  <div style={dbStyles.connInfo} onClick={() => !p.connected && handleProfileConnect(p.dbProfileId)}>
                    <div style={dbStyles.connName}>{p.name}</div>
                    <div style={dbStyles.connMeta}>{typeLabel(p.type)} · {p.host}:{p.port}{p.sshProfileId ? " · SSH" : ""}</div>
                  </div>
                  {p.connected
                    ? <span style={dbStyles.badgeConnected}>已连接</span>
                    : <button onClick={(e) => { e.stopPropagation(); handleProfileConnect(p.dbProfileId); }} style={dbStyles.connAction} title="连接">↵</button>
                  }
                  <button onClick={(e) => { e.stopPropagation(); handleProfileRename(p); }} style={dbStyles.connAction} title="重命名">✎</button>
                  <button onClick={(e) => { e.stopPropagation(); handleProfileDelete(p); }} style={dbStyles.connClose} title="删除">×</button>
                </div>
              ))}
            </>
          )}
          {/* Live connections — click to select for querying */}
          {connections.length > 0 && (
            <>
              <div style={dbStyles.sectionLabel}>当前连接</div>
              {connections.map((c) => (
                <div
                  key={c.dbConnectionId}
                  onClick={() => setSelectedId(c.dbConnectionId)}
                  style={{
                    ...dbStyles.connItem,
                    ...(selectedId === c.dbConnectionId ? dbStyles.connItemActive : {})
                  }}
                >
                  <span style={{ ...dbStyles.typeDot, background: typeColor(c.type) }} />
                  <div style={dbStyles.connInfo}>
                    <div style={dbStyles.connName}>{c.name}</div>
                    <div style={dbStyles.connMeta}>{typeLabel(c.type)} · {c.host}:{c.port}{c.sshConnectionId ? " · SSH" : ""}</div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDisconnect(c.dbConnectionId); }}
                    style={dbStyles.connClose}
                    title="断开"
                  >×</button>
                </div>
              ))}
            </>
          )}
          {profiles.length === 0 && connections.length === 0 && (
            <div style={dbStyles.sidebarEmpty}>
              没有连接
              <button onClick={() => setShowForm(true)} style={dbStyles.emptyLink}>新建连接</button>
            </div>
          )}
        </div>
      </div>

      {/* Drag handle between sidebar and main */}
      <div onMouseDown={startDrag} style={dbStyles.splitter} title="拖动调整宽度" />

      {/* Editor + result (right pane) */}
      <div style={dbStyles.main}>
        {error && <div style={dbStyles.errorBar}>{error}</div>}
        {showForm ? (
          <ConnectForm
            sshProfiles={sshProfiles}
            api={api}
            onSubmit={handleConnect}
            onCancel={() => { setShowForm(false); setError(null); }}
          />
        ) : selected ? (
          <QueryPane api={api} connection={selected} onError={setError} />
        ) : (
          <div style={dbStyles.mainEmpty}>
            选择左侧连接，或点「＋」新建
          </div>
        )}
      </div>
    </div>
  );
}

// ── Connect form ─────────────────────────────────────────────────────────────

function ConnectForm({ sshProfiles, api, onSubmit, onCancel }) {
  const [type, setType] = useState("mysql");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("3306");
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [ssl, setSsl] = useState("disabled");
  const [sshProfileId, setSshProfileId] = useState("");
  const [name, setName] = useState("");
  const [saveProfile, setSaveProfile] = useState(true);
  const [busy, setBusy] = useState(false);
  const formRef = useRef(null);

  const onTypeChange = (t) => {
    setType(t);
    setPort(String(typeMeta(t).port));
  };

  const onSshTunnelChange = (id) => {
    setSshProfileId(id);
    // When tunneling through an SSH server, the database is usually on that
    // server — default host to 127.0.0.1 (as seen from the SSH server) so the
    // user doesn't have to type it.
    if (id && !host.trim()) setHost("127.0.0.1");
  };

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!host.trim()) return;
    setBusy(true);
    try {
      await onSubmit({ type, host, port, database, username, password, ssl, sshProfileId, name, saveProfile });
    } finally {
      setBusy(false);
    }
  };

  // Esc to cancel
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const inputStyle = dbStyles.input;
  const isNoSql = type === "redis" || type === "mongodb";

  return (
    <form ref={formRef} onSubmit={submit} style={dbStyles.form}>
      <div style={dbStyles.formTitle}>新建数据库连接</div>

      <div style={dbStyles.formRow}>
        <label style={dbStyles.formLabel}>类型</label>
        <select value={type} onChange={(e) => onTypeChange(e.target.value)} style={inputStyle}>
          {DB_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      <div style={dbStyles.formRow2}>
        <label style={dbStyles.formLabel2}>
          主机
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder={sshProfileId ? "127.0.0.1（从 SSH 服务器看）" : "数据库地址"} style={inputStyle} autoFocus required />
        </label>
        <label style={dbStyles.formLabel2w}>
          端口
          <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" style={inputStyle} />
        </label>
      </div>

      <div style={dbStyles.formRow2}>
        <label style={dbStyles.formLabel2}>
          {isNoSql ? "库名 / 索引" : "数据库名"}
          <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder={type === "redis" ? "0" : "可选"} style={inputStyle} />
        </label>
        <label style={dbStyles.formLabel2w}>
          名称
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="可选" style={inputStyle} />
        </label>
      </div>

      <div style={dbStyles.formRow2}>
        <label style={dbStyles.formLabel2}>
          {type === "redis" ? "（无需）" : "用户名"}
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={type === "redis" ? "" : "可选"} style={inputStyle} disabled={type === "redis"} />
        </label>
        <label style={dbStyles.formLabel2w}>
          {type === "redis" ? "密码" : "密码"}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="可选" style={inputStyle} />
        </label>
      </div>

      <div style={dbStyles.formRow2}>
        <label style={dbStyles.formLabel2w}>
          SSL
          <select value={ssl} onChange={(e) => setSsl(e.target.value)} style={inputStyle}>
            <option value="disabled">不加密</option>
            <option value="preferred">加密（不验证）</option>
            <option value="verify">加密 + 验证 CA</option>
          </select>
        </label>
        <label style={dbStyles.formLabel2}>
          SSH 隧道
          <select value={sshProfileId} onChange={(e) => onSshTunnelChange(e.target.value)} style={inputStyle}>
            <option value="">不使用</option>
            {sshProfiles.map((p) => <option key={p.profileId} value={p.profileId}>{p.name} ({p.host})</option>)}
          </select>
        </label>
      </div>

      <label style={dbStyles.checkRow}>
        <input type="checkbox" checked={saveProfile} onChange={(e) => setSaveProfile(e.target.checked)} />
        保存为数据库资源（下次一键连接）
      </label>

      <div style={dbStyles.formActions}>
        <button type="button" onClick={onCancel} style={dbStyles.btnSecondary}>取消 (Esc)</button>
        <button type="submit" disabled={busy || !host.trim()} style={dbStyles.btnPrimary}>{busy ? "连接中…" : "连接"}</button>
      </div>
    </form>
  );
}

// ── Query pane ───────────────────────────────────────────────────────────────

function QueryPane({ api, connection, onError }) {
  const isSql = connection.type === "mysql" || connection.type === "postgresql";
  const isRedis = connection.type === "redis";
  const isMongo = connection.type === "mongodb";

  const [sql, setSql] = useState(typeMeta(connection.type).placeholder);
  const [redisCmd, setRedisCmd] = useState("GET mykey");
  const [mongoCollection, setMongoCollection] = useState("");
  const [mongoOp, setMongoOp] = useState("find");
  const [mongoFilter, setMongoFilter] = useState("{}");
  const [result, setResult] = useState(null);
  const [resultType, setResultType] = useState(null); // "table" | "json" | "text"
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null);
  const editorRef = useRef(null);

  const run = useCallback(async () => {
    setBusy(true);
    setResult(null);
    setResultType(null);
    setInfo(null);
    const startedAt = Date.now();
    try {
      let value;
      if (isSql) {
        const trimmed = sql.trim();
        if (!trimmed) return;
        if (isReadSql(trimmed)) {
          value = await api.dbQuery(connection.dbConnectionId, trimmed);
          setResult({ columns: value.columns, rows: value.rows });
          setResultType("table");
          setInfo(`${value.rowCount} 行${value.truncated ? "（已截断 200 行）" : ""} · ${Date.now() - startedAt}ms`);
        } else {
          value = await api.dbExecute(connection.dbConnectionId, trimmed);
          setResult({ affectedRows: value.affectedRows, insertId: value.insertId });
          setResultType("text");
          setInfo(`影响 ${value.affectedRows} 行${value.insertId !== undefined ? ` · insertId=${value.insertId}` : ""} · ${Date.now() - startedAt}ms`);
        }
      } else if (isRedis) {
        const trimmed = redisCmd.trim();
        if (!trimmed) return;
        const parts = trimmed.split(/\s+/);
        value = await api.dbRun(connection.dbConnectionId, { command: parts[0], args: parts.slice(1) });
        setResult(value.result);
        setResultType(typeof value.result === "string" ? "text" : "json");
        setInfo(`${Date.now() - startedAt}ms`);
      } else if (isMongo) {
        if (!mongoCollection.trim()) { onError("请填写 collection"); return; }
        let filter;
        try { filter = JSON.parse(mongoFilter || "{}"); }
        catch { onError("filter 不是合法 JSON"); return; }
        value = await api.dbRun(connection.dbConnectionId, {
          collection: mongoCollection.trim(),
          operation: mongoOp,
          filter
        });
        setResult(value.result);
        setResultType("json");
        setInfo(`${Date.now() - startedAt}ms`);
      }
    } catch (err) {
      onError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }, [api, connection, isSql, isRedis, isMongo, sql, redisCmd, mongoCollection, mongoOp, mongoFilter, onError]);

  // Ctrl/Cmd+Enter to execute
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run]);

  const clear = () => {
    setResult(null);
    setResultType(null);
    setInfo(null);
  };

  return (
    <div style={dbStyles.queryPane}>
      <div style={dbStyles.queryHeader}>
        <span style={{ ...dbStyles.typeDot, background: typeColor(connection.type) }} />
        <span style={dbStyles.queryConnName}>{connection.name}</span>
        <span style={dbStyles.queryConnMeta}>{typeLabel(connection.type)} · {connection.host}:{connection.port}</span>
      </div>

      {/* Editor area — type-specific */}
      {isSql && (
        <textarea
          ref={editorRef}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          placeholder={typeMeta(connection.type).placeholder}
          style={dbStyles.sqlEditor}
          spellCheck={false}
        />
      )}

      {isRedis && (
        <input
          value={redisCmd}
          onChange={(e) => setRedisCmd(e.target.value)}
          placeholder="GET mykey  ·  KEYS *  ·  HGETALL hash"
          style={dbStyles.cmdInput}
          spellCheck={false}
        />
      )}

      {isMongo && (
        <div style={dbStyles.mongoForm}>
          <div style={dbStyles.mongoRow}>
            <input value={mongoCollection} onChange={(e) => setMongoCollection(e.target.value)} placeholder="collection 名" style={{ ...dbStyles.input, flex: 1 }} spellCheck={false} />
            <select value={mongoOp} onChange={(e) => setMongoOp(e.target.value)} style={{ ...dbStyles.input, flex: "none", width: 130 }}>
              {MONGO_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
            </select>
          </div>
          <textarea
            value={mongoFilter}
            onChange={(e) => setMongoFilter(e.target.value)}
            placeholder='{"status": "active"}'
            style={{ ...dbStyles.sqlEditor, minHeight: 48, fontFamily: "ui-monospace, monospace" }}
            spellCheck={false}
          />
        </div>
      )}

      <div style={dbStyles.queryActions}>
        <button onClick={run} disabled={busy} style={dbStyles.btnPrimary}>
          {busy ? "执行中…" : "执行"}
          <span style={dbStyles.shortcutHint}>⌘↵</span>
        </button>
        <button onClick={clear} style={dbStyles.btnSecondary}>清除</button>
        {info && <span style={dbStyles.infoText}>{info}</span>}
      </div>

      {/* Result area */}
      <div style={dbStyles.resultArea}>
        {resultType === "table" && result.columns && (
          <ResultTable columns={result.columns} rows={result.rows} />
        )}
        {resultType === "json" && (
          <pre style={dbStyles.jsonResult}>{JSON.stringify(result, null, 2)}</pre>
        )}
        {resultType === "text" && (
          <pre style={dbStyles.textResult}>{typeof result === "string" ? result : JSON.stringify(result, null, 2)}</pre>
        )}
        {!resultType && !busy && (
          <div style={dbStyles.resultEmpty}>按「执行」或 ⌘↵ 运行</div>
        )}
      </div>
    </div>
  );
}

// ── Result table ─────────────────────────────────────────────────────────────

function ResultTable({ columns, rows }) {
  if (!columns.length) return <div style={dbStyles.resultEmpty}>(无列信息)</div>;
  return (
    <div style={dbStyles.tableWrap}>
      <table style={dbStyles.table}>
        <thead>
          <tr>{columns.map((c) => <th key={c} style={dbStyles.th}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} style={dbStyles.emptyCell}>(空结果集)</td></tr>
          ) : rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => {
                const v = row?.[c];
                const text = v === null || v === undefined ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v);
                return <td key={c} style={dbStyles.td}>{text}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const dbStyles = {
  root: { display: "flex", flex: 1, minHeight: 0, gap: 0 },
  // sidebar
  sidebar: { width: 180, flex: "none", display: "flex", flexDirection: "column", minHeight: 0 },
  splitter: { width: 4, flex: "none", cursor: "col-resize", background: "#262b33", transition: "background .15s" },
  sidebarHeader: { display: "flex", alignItems: "center", gap: 4, padding: "6px 8px", flex: "none" },
  sidebarTitle: { flex: 1, fontSize: 11, fontWeight: 600, color: "#9aa3af", textTransform: "uppercase", letterSpacing: 0.5 },
  iconBtn: { background: "transparent", border: "1px solid #3a414b", color: "#d7dbe2", borderRadius: 5, width: 22, height: 22, fontSize: 13, cursor: "pointer", lineHeight: 1, padding: 0 },
  connList: { flex: 1, overflowY: "auto", padding: "0 4px 4px" },
  sidebarEmpty: { padding: "20px 8px", fontSize: 11, color: "#8b93a1", textAlign: "center", display: "flex", flexDirection: "column", gap: 8 },
  emptyLink: { background: "transparent", border: "none", color: "#2d6cdf", cursor: "pointer", fontSize: 11, padding: 0 },
  connItem: { display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 6, cursor: "pointer", marginBottom: 2 },
  connItemActive: { background: "rgba(45,108,223,.15)", border: "1px solid rgba(45,108,223,.3)" },
  typeDot: { width: 8, height: 8, borderRadius: "50%", flex: "none" },
  connInfo: { flex: 1, minWidth: 0 },
  connName: { fontSize: 12, color: "#d7dbe2", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  connMeta: { fontSize: 10, color: "#8b93a1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  connClose: { background: "transparent", border: "none", color: "#5b6472", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1, flex: "none" },
  sectionLabel: { display: "flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 600, color: "#5b6472", textTransform: "uppercase", letterSpacing: 0.5, padding: "8px 8px 4px", cursor: "pointer", userSelect: "none" },
  collapseIcon: { fontSize: 24, color: "#8b93a1", flex: "none", lineHeight: 1 },
  countBadge: { fontSize: 10, color: "#5b6472", background: "rgba(91,100,114,.2)", borderRadius: 4, padding: "0 4px" },
  badgeConnected: { fontSize: 10, color: "#3fb950", background: "rgba(63,185,80,.15)", padding: "2px 5px", borderRadius: 4, flex: "none" },
  connAction: { background: "transparent", border: "1px solid #3a414b", color: "#d7dbe2", borderRadius: 4, width: 20, height: 20, fontSize: 11, cursor: "pointer", padding: 0, lineHeight: 1, flex: "none" },
  checkRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#9aa3af", cursor: "pointer" },
  // main
  main: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0 },
  mainEmpty: { margin: "auto", fontSize: 12, color: "#8b93a1" },
  errorBar: { padding: "6px 10px", fontSize: 12, color: "#f85149", background: "rgba(248,81,73,.1)", border: "1px solid rgba(248,81,73,.3)", borderRadius: 6, margin: 6, flex: "none" },
  // form
  form: { display: "flex", flexDirection: "column", gap: 8, padding: 14, overflowY: "auto", flex: 1 },
  formTitle: { fontSize: 14, fontWeight: 600, color: "#d7dbe2", marginBottom: 2 },
  formRow: { display: "flex", flexDirection: "column", gap: 3 },
  formRow2: { display: "flex", gap: 8 },
  formLabel: { fontSize: 11, color: "#9aa3af" },
  formLabel2: { display: "flex", flexDirection: "column", gap: 3, fontSize: 11, color: "#9aa3af", flex: 1 },
  formLabel2w: { display: "flex", flexDirection: "column", gap: 3, fontSize: 11, color: "#9aa3af", flex: "none", width: 100 },
  input: { width: "100%", boxSizing: "border-box", background: "#101418", border: "1px solid #2a303a", borderRadius: 6, color: "#d7dbe2", padding: "6px 8px", fontSize: 12, outline: "none" },
  formActions: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 },
  // query pane
  queryPane: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: 8, gap: 6 },
  queryHeader: { display: "flex", alignItems: "center", gap: 6, flex: "none" },
  queryConnName: { fontSize: 12, fontWeight: 600, color: "#d7dbe2" },
  queryConnMeta: { fontSize: 11, color: "#8b93a1" },
  sqlEditor: { flex: "none", minHeight: 72, resize: "vertical", background: "#101418", border: "1px solid #2a303a", borderRadius: 6, color: "#d7dbe2", padding: "8px 10px", fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", outline: "none", lineHeight: 1.5, width: "100%", boxSizing: "border-box" },
  cmdInput: { flex: "none", background: "#101418", border: "1px solid #2a303a", borderRadius: 6, color: "#d7dbe2", padding: "7px 10px", fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", outline: "none", width: "100%", boxSizing: "border-box" },
  mongoForm: { display: "flex", flexDirection: "column", gap: 6, flex: "none" },
  mongoRow: { display: "flex", gap: 6 },
  queryActions: { display: "flex", alignItems: "center", gap: 8, flex: "none" },
  btnPrimary: { background: "#2d6cdf", color: "#fff", border: "none", borderRadius: 6, padding: "5px 14px", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 },
  btnSecondary: { background: "transparent", border: "1px solid #3a414b", color: "#d7dbe2", borderRadius: 6, padding: "4px 12px", fontSize: 12, cursor: "pointer" },
  shortcutHint: { fontSize: 10, opacity: 0.7, fontFamily: "ui-monospace, monospace" },
  infoText: { fontSize: 11, color: "#8b93a1" },
  // result
  resultArea: { flex: 1, minHeight: 0, overflow: "auto", background: "#101418", border: "1px solid #2a303a", borderRadius: 6, marginTop: 2 },
  resultEmpty: { margin: "auto", fontSize: 11, color: "#5b6472", display: "flex", alignItems: "center", justifyContent: "center", height: "100%" },
  tableWrap: { overflow: "auto", height: "100%" },
  table: { borderCollapse: "collapse", fontSize: 12, width: "100%" },
  th: { padding: "5px 10px", textAlign: "left", color: "#9aa3af", fontWeight: 600, borderBottom: "1px solid #2a303a", position: "sticky", top: 0, background: "#161a20", whiteSpace: "nowrap" },
  td: { padding: "4px 10px", color: "#d7dbe2", borderBottom: "1px solid #1e2329", whiteSpace: "nowrap", maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 },
  emptyCell: { padding: "16px 10px", color: "#5b6472", textAlign: "center", fontSize: 11 },
  jsonResult: { padding: "8px 10px", fontSize: 11, color: "#d7dbe2", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 },
  textResult: { padding: "8px 10px", fontSize: 11, color: "#d7dbe2", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 }
};
