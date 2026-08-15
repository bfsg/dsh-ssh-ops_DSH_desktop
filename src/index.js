/**
 * dsh-ssh-ops host half: a Typert Remote service named `sshOps` that manages
 * ssh2 connections and PTY shell sessions, streaming output to the browser
 * through long-poll reads. Also registers agent tools (ssh_connect, ssh_exec,
 * ...) so the main conversation can drive the same sessions the panel shows.
 */
import { randomUUID } from "node:crypto";
import { Client } from "ssh2";
import { Service } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { z } from "zod";
import { assessShellCommand } from "./safety.js";
import { redactForModel } from "./redact.js";

const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_CAPTURE_BYTES = 128 * 1024;
const READ_TIMEOUT_MS = 300;
const MAX_SESSIONS = 64;

const profileRecordSchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  authKind: z.enum(["password", "key"]),
  groupId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const groupRecordSchema = z.object({
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const profileDomainSpec = defineDomain({
  name: "ssh_ops_profiles",
  version: 1,
  tables: {
    profiles: domainTable(profileRecordSchema),
    groups: domainTable(groupRecordSchema)
  }
});

function fail(code, message) {
  return { code, message };
}

function profileCredentialRefs(profileId) {
  const stem = profileId.replaceAll("-", "").toUpperCase();
  return {
    password: `DSH_SSH_OPS_${stem}_PASSWORD`,
    privateKey: `DSH_SSH_OPS_${stem}_PRIVATE_KEY`,
    passphrase: `DSH_SSH_OPS_${stem}_PASSPHRASE`
  };
}

/** Base64-decode a wire payload to a UTF-8 string. */
function decodeData(data) {
  return Buffer.from(data, "base64").toString("utf8");
}

/** Base64-encode a UTF-8 string for the wire. */
function encodeData(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function appendCapped(current, next, maxBytes) {
  const existing = Buffer.byteLength(current, "utf8");
  const incoming = Buffer.from(next, "utf8");
  if (existing >= maxBytes) return { text: current, truncated: incoming.length > 0 };
  const remaining = maxBytes - existing;
  if (incoming.length <= remaining) return { text: current + next, truncated: false };
  return { text: current + incoming.subarray(0, remaining).toString("utf8"), truncated: true };
}

function tailCapped(text, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= maxBytes ? text : bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

function promptFromTerminalData(text) {
  const visible = String(text)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const match = visible.match(/(?:^|[\r\n])([^\r\n]*[#$] )$/);
  return match?.[1] ?? null;
}

/**
 * ssh2 exec channels return LF-delimited text. xterm keeps the current column
 * on a bare LF, which makes multi-line agent output drift diagonally. Agent
 * output is synthetic terminal data, so normalize it to the terminal CRLF.
 */
export function normalizeTerminalEol(text) {
  return String(text ?? "").replace(/\r\n|\r|\n/g, "\r\n");
}

/**
 * SshOpsService: one cordis service (and Typert Remote) that owns all SSH
 * connections and their PTY shell sessions for the web profile.
 */
export default class SshOpsService extends TypertRemoteService {
  /** Host-owned profiles and secrets never cross the agent tool boundary. */
  static inject = ["tools", "storageDomain", "credentials"];

  /** connectionId -> live connection record */
  connections = new Map();
  /** sessionId -> live PTY shell session record */
  sessions = new Map();
  /** sessionId -> tombstoned exit records for late reads */
  exitedSessions = new Map();
  /** The connection currently represented by the right-side terminal panel. */
  activeConnectionId = null;
  profileTable = null;
  groupTable = null;

  constructor(ctx, config = {}) {
    super(ctx, "sshOps");
    this.config = {
      defaultReadTimeoutMs: READ_TIMEOUT_MS,
      maxBufferBytes: MAX_BUFFER_BYTES,
      maxCommandOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      maxCaptureBytes: MAX_CAPTURE_BYTES,
      ...config
    };
    // Tear down all connections when the plugin fiber unloads.
    ctx.effect(() => () => {
      for (const conn of this.connections.values()) {
        try { conn.client.end(); } catch {}
      }
      this.connections.clear();
      this.sessions.clear();
      this.exitedSessions.clear();
      this.activeConnectionId = null;
    }, "ssh-ops: cleanup");
    this.registerTools(ctx);
  }

  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(profileDomainSpec);
    this.profileTable = domain.table("profiles");
    this.groupTable = domain.table("groups");
    this.ctx.effect(() => () => domain.close(), "ssh-ops: profile domain close");
  }

  // ── Remote methods ─────────────────────────────────────────────────────────

  async list() {
    const connections = [];
    for (const [connectionId, c] of this.connections) {
      const connection = {
        connectionId,
        host: c.host,
        port: c.port,
        username: c.username,
        connected: true,
        sessions: [...c.sessions]
      };
      // Strict Typert results must be JSON-safe: optional fields must be
      // absent, rather than present with an `undefined` value.
      if (c.name !== undefined) connection.name = c.name;
      connections.push(connection);
    }
    return { ok: true, value: { connections, activeConnectionId: this.activeConnectionId } };
  }

  async connect(request) {
    return this.connectInternal(request);
  }

  async connectInternal(request, profileId = undefined) {
    const id = request.name ? `${request.name}-${randomUUID().slice(0, 8)}` : randomUUID();
    const client = new Client();
    const connectConfig = {
      host: request.host,
      port: request.port ?? 22,
      username: request.username,
      readyTimeout: request.readyTimeout ?? 20000
    };
    if (request.auth.kind === "password") {
      connectConfig.password = request.auth.password;
    } else {
      connectConfig.privateKey = request.auth.privateKey;
      if (request.auth.passphrase !== void 0) connectConfig.passphrase = request.auth.passphrase;
    }
    const record = {
      id,
      client,
      host: connectConfig.host,
      port: connectConfig.port,
      username: connectConfig.username,
      name: request.name,
      profileId,
      sessions: new Set()
    };
    this.connections.set(id, record);
    try {
      await new Promise((resolve, reject) => {
        client.once("ready", resolve);
        client.once("error", (error) => {
          this.connections.delete(id);
          reject(error);
        });
        client.connect(connectConfig);
      });
    } catch (error) {
      return { ok: false, error: fail("connect-failed", `${connectConfig.username}@${connectConfig.host}:${connectConfig.port}: ${error.message}`) };
    }
    const value = {
      connectionId: id,
      host: connectConfig.host,
      port: connectConfig.port,
      username: connectConfig.username
    };
    // See list(): the RPC gateway rejects `undefined` as a JSON value.
    if (request.name !== undefined) value.name = request.name;
    // A newly connected server is the natural target for the conversation,
    // even if the browser has not rendered its PTY yet.
    this.activeConnectionId = id;
    return {
      ok: true,
      value
    };
  }

  requireProfileTable() {
    if (this.profileTable === null) throw new Error("SSH resource storage is not ready");
    return this.profileTable;
  }

  requireGroupTable() {
    if (this.groupTable === null) throw new Error("SSH resource storage is not ready");
    return this.groupTable;
  }

  groupPublic(groupId, record) {
    const profileCount = [...this.requireProfileTable().entries()].filter(([, profile]) => profile.groupId === groupId).length;
    return { groupId, name: record.name, profileCount };
  }

  async profilePublic(profileId, record) {
    const refs = profileCredentialRefs(profileId);
    const primaryRef = record.authKind === "password" ? refs.password : refs.privateKey;
    const [primary, passphrase] = await Promise.all([
      this.ctx.credentials.describe(credentialRef(primaryRef)),
      this.ctx.credentials.describe(credentialRef(refs.passphrase))
    ]);
    const connected = [...this.connections.values()].some((connection) => connection.profileId === profileId);
    const group = record.groupId === null ? undefined : this.requireGroupTable().get(record.groupId);
    return {
      profileId,
      name: record.name,
      host: record.host,
      port: record.port,
      username: record.username,
      authKind: record.authKind,
      groupId: group === undefined ? null : record.groupId,
      groupName: group?.name ?? null,
      credentialConfigured: primary.configured,
      passphraseConfigured: passphrase.configured,
      connected
    };
  }

  async profileList() {
    try {
      const profiles = await Promise.all(
        [...this.requireProfileTable().entries()].map(async ([profileId, record]) => await this.profilePublic(profileId, record))
      );
      profiles.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
      return { ok: true, value: { profiles } };
    } catch (error) {
      return { ok: false, error: fail("profile-list-failed", error.message) };
    }
  }

  async profileSave(request) {
    try {
      const table = this.requireProfileTable();
      const profileId = request.profileId ?? randomUUID();
      const previous = table.get(profileId);
      if (request.profileId !== undefined && previous === undefined) {
        return { ok: false, error: fail("no-profile", `SSH resource "${profileId}" does not exist`) };
      }
      const now = new Date().toISOString();
      const groupId = request.groupId ?? null;
      if (groupId !== null && this.requireGroupTable().get(groupId) === undefined) {
        return { ok: false, error: fail("no-group", `SSH group "${groupId}" does not exist`) };
      }
      const record = {
        name: request.name.trim(),
        host: request.host.trim(),
        port: request.port ?? 22,
        username: request.username.trim(),
        authKind: request.authKind,
        groupId,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      };
      await table.put(profileId, record);
      return {
        ok: true,
        value: {
          profile: await this.profilePublic(profileId, record),
          credentialRefs: profileCredentialRefs(profileId)
        }
      };
    } catch (error) {
      return { ok: false, error: fail("profile-save-failed", error.message) };
    }
  }

  async profileDelete(request) {
    try {
      const table = this.requireProfileTable();
      const record = table.get(request.profileId);
      if (record === undefined) return { ok: true, value: { deleted: false } };
      const refs = profileCredentialRefs(request.profileId);
      // Only names derived from this resource id are ever removed. A live SSH
      // transport keeps running; deletion only forgets future quick-connect.
      await Promise.all(Object.values(refs).map(async (ref) => await this.ctx.credentials.unset(credentialRef(ref))));
      await table.delete(request.profileId);
      return { ok: true, value: { deleted: true } };
    } catch (error) {
      return { ok: false, error: fail("profile-delete-failed", error.message) };
    }
  }

  async profileConnect(request) {
    try {
      const record = this.requireProfileTable().get(request.profileId);
      if (record === undefined) return { ok: false, error: fail("no-profile", `SSH resource "${request.profileId}" does not exist`) };
      const refs = profileCredentialRefs(request.profileId);
      const primaryRef = record.authKind === "password" ? refs.password : refs.privateKey;
      const primary = await this.ctx.credentials.resolve(credentialRef(primaryRef));
      if (primary === undefined) {
        return { ok: false, error: fail("credential-missing", `SSH resource "${record.name}" has no saved ${record.authKind === "password" ? "password" : "private key"}`) };
      }
      const passphrase = record.authKind === "key"
        ? await this.ctx.credentials.resolve(credentialRef(refs.passphrase))
        : undefined;
      return await this.connectInternal({
        name: record.name,
        host: record.host,
        port: record.port,
        username: record.username,
        auth: record.authKind === "password"
          ? { kind: "password", password: primary.value }
          : { kind: "key", privateKey: primary.value, ...(passphrase === undefined ? {} : { passphrase: passphrase.value }) }
      }, request.profileId);
    } catch (error) {
      return { ok: false, error: fail("profile-connect-failed", error.message) };
    }
  }

  async groupList() {
    try {
      const groups = [...this.requireGroupTable().entries()]
        .map(([groupId, record]) => this.groupPublic(groupId, record))
        .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
      return { ok: true, value: { groups } };
    } catch (error) {
      return { ok: false, error: fail("group-list-failed", error.message) };
    }
  }

  async groupSave(request) {
    try {
      const table = this.requireGroupTable();
      const groupId = request.groupId ?? randomUUID();
      const previous = table.get(groupId);
      if (request.groupId !== undefined && previous === undefined) {
        return { ok: false, error: fail("no-group", `SSH group "${groupId}" does not exist`) };
      }
      const name = request.name.trim();
      if ([...table.entries()].some(([id, group]) => id !== groupId && group.name.localeCompare(name, "zh-Hans-CN", { sensitivity: "accent" }) === 0)) {
        return { ok: false, error: fail("duplicate-group", `SSH group "${name}" already exists`) };
      }
      const now = new Date().toISOString();
      const record = { name, createdAt: previous?.createdAt ?? now, updatedAt: now };
      await table.put(groupId, record);
      return { ok: true, value: { group: this.groupPublic(groupId, record) } };
    } catch (error) {
      return { ok: false, error: fail("group-save-failed", error.message) };
    }
  }

  async groupDelete(request) {
    try {
      const groups = this.requireGroupTable();
      if (groups.get(request.groupId) === undefined) return { ok: true, value: { deleted: false, movedProfiles: 0 } };
      const profiles = this.requireProfileTable();
      let movedProfiles = 0;
      for (const [profileId, profile] of profiles.entries()) {
        if (profile.groupId !== request.groupId) continue;
        movedProfiles += 1;
        await profiles.put(profileId, { ...profile, groupId: null, updatedAt: new Date().toISOString() });
      }
      await groups.delete(request.groupId);
      return { ok: true, value: { deleted: true, movedProfiles } };
    } catch (error) {
      return { ok: false, error: fail("group-delete-failed", error.message) };
    }
  }

  async openSession(request) {
    const conn = this.connections.get(request.connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${request.connectionId}" does not exist`) };
    if (this.sessions.size >= MAX_SESSIONS) return { ok: false, error: fail("session-limit", `too many live sessions (${MAX_SESSIONS})`) };
    const sessionId = randomUUID();
    const cols = request.cols ?? 80;
    const rows = request.rows ?? 24;
    const session = {
      id: sessionId,
      connectionId: request.connectionId,
      cols,
      rows,
      buffer: "",
      // Browser reads drain `buffer`. Retain a separate bounded capture for
      // an explicit ssh_read without coupling it to UI polling.
      captureBuffer: "",
      lastPrompt: null,
      waiters: [],
      exited: null,
      stream: null,
      // The PTY receives keystrokes one at a time. Track the current command
      // locally, then allow or cancel it only when Enter is pressed.
      inputLine: "",
      inputKnown: true
    };
    this.sessions.set(sessionId, session);
    this.exitedSessions.delete(sessionId);
    conn.sessions.add(sessionId);
    try {
      const stream = await new Promise((resolve, reject) => {
        conn.client.shell({ term: "xterm-256color", cols, rows }, (error, s) => {
          if (error) reject(error);
          else resolve(s);
        });
      });
      session.stream = stream;
      stream.on("data", (chunk) => {
        this.appendSessionOutput(session, chunk.toString("utf8"));
      });
      stream.on("close", () => {
        this.recordExit(session, { code: 0 });
      });
      stream.on("error", () => {
        this.recordExit(session, { code: 1 });
      });
      // The panel opens this session immediately after a successful manual
      // connection. Remember it so agent tools can act on the same server
      // without making the model discover an opaque connection id first.
      this.activeConnectionId = request.connectionId;
    } catch (error) {
      this.sessions.delete(sessionId);
      conn.sessions.delete(sessionId);
      return { ok: false, error: fail("shell-failed", `could not open shell on connection "${request.connectionId}": ${error.message}`) };
    }
    return {
      ok: true,
      value: {
        sessionId,
        connectionId: request.connectionId,
        cols,
        rows,
        alive: true
      }
    };
  }

  async write(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    if (session.exited !== null || session.stream === null) return { ok: false, error: fail("exited", `session "${request.sessionId}" has already exited`) };
    let text;
    try {
      text = decodeData(request.data);
    } catch {
      return { ok: false, error: fail("bad-data", "input is not valid base64") };
    }
    // This path is invoked only by the interactive browser terminal. Manual
    // operator input may include a deliberate high-risk command; agent tool
    // calls use writeToConnection()/execOnConnection() and keep the guard.
    try {
      if (text) session.stream.write(text);
    } catch (error) {
      return { ok: false, error: fail("write-failed", error.message) };
    }
    return { ok: true, value: { written: text.length } };
  }

  async read(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) {
      const exit = this.exitedSessions.get(request.sessionId);
      if (exit !== void 0) return { ok: true, value: { data: "", exit } };
      return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    }
    if (session.exited !== null) {
      return { ok: true, value: { data: this.drain(session), exit: session.exited } };
    }
    const pending = this.drain(session);
    if (pending !== "") {
      return { ok: true, value: { data: pending, exit: null } };
    }
    const timeoutMs = request.timeoutMs ?? this.config.defaultReadTimeoutMs;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = session.waiters.indexOf(waiter);
        if (index >= 0) session.waiters.splice(index, 1);
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish({ ok: true, value: { data: this.drain(session), exit: null } });
      }, timeoutMs);
      const waiter = { resolve: finish, timer };
      session.waiters.push(waiter);
    });
  }

  async resize(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    if (session.stream === null || session.exited !== null) return { ok: false, error: fail("exited", `session "${request.sessionId}" is not alive`) };
    try {
      session.stream.setWindow(request.rows, request.cols);
    } catch (error) {
      return { ok: false, error: fail("resize-failed", error.message) };
    }
    session.cols = request.cols;
    session.rows = request.rows;
    return { ok: true, value: { cols: request.cols, rows: request.rows } };
  }

  async closeSession(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    this.sessions.delete(request.sessionId);
    const conn = this.connections.get(session.connectionId);
    if (conn) conn.sessions.delete(request.sessionId);
    if (session.exited === null && session.stream !== null) {
      try { session.stream.end(); } catch {}
      session.exited = { code: 0 };
    }
    this.rememberExit(request.sessionId, session.exited ?? { code: 0 });
    return { ok: true, value: { closed: true } };
  }

  async disconnect(request) {
    const conn = this.connections.get(request.connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${request.connectionId}" does not exist`) };
    for (const sessionId of [...conn.sessions]) {
      const session = this.sessions.get(sessionId);
      if (session) {
        this.sessions.delete(sessionId);
        if (session.exited === null && session.stream !== null) {
          try { session.stream.end(); } catch {}
          session.exited = { code: 0 };
        }
        this.rememberExit(sessionId, session.exited ?? { code: 0 });
      }
    }
    conn.sessions.clear();
    this.connections.delete(request.connectionId);
    if (this.activeConnectionId === request.connectionId) {
      this.activeConnectionId = null;
    }
    try { conn.client.end(); } catch {}
    return { ok: true, value: { disconnected: true } };
  }

  // ── Agent-facing helpers (called directly by tools, not over the wire) ────

  /**
   * Run one command over a dedicated exec channel on a connection. The
   * command line and its output are ALSO appended to the connection's shell
   * session buffers (if any), so the panel shows what the agent did.
   */
  async execOnConnection(connectionId, command, timeoutMs = 30000) {
    const decision = assessShellCommand(command);
    if (!decision.ok) return { ok: false, error: fail("unsafe-command", decision.reason) };
    const conn = this.connections.get(connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    const commandId = randomUUID();
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    let stdout = "";
    let stderr = "";
    let exitCode = null;
    let truncated = false;
    let timedOut = false;
    try {
      const stream = await new Promise((resolve, reject) => {
        conn.client.exec(command, { pty: false }, (error, s) => {
          if (error) reject(error);
          else resolve(s);
        });
      });
      const timer = setTimeout(() => {
        timedOut = true;
        try { stream.close(); } catch {}
      }, timeoutMs);
      await new Promise((resolve) => {
        stream.on("data", (chunk) => {
          const result = appendCapped(stdout, chunk.toString("utf8"), this.config.maxCommandOutputBytes);
          stdout = result.text;
          truncated ||= result.truncated;
        });
        stream.stderr.on("data", (chunk) => {
          const result = appendCapped(stderr, chunk.toString("utf8"), this.config.maxCommandOutputBytes);
          stderr = result.text;
          truncated ||= result.truncated;
        });
        stream.on("close", (code, signal) => {
          clearTimeout(timer);
          exitCode = typeof code === "number" ? code : null;
          resolve();
        });
        stream.on("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } catch (error) {
      return { ok: false, error: fail("exec-failed", error.message) };
    }
    // Mirror the command and output into every live shell session of this
    // connection so the panel displays agent-driven commands too.
    const display = normalizeTerminalEol(`$ ${command}\n${stdout}${stderr.length > 0 ? stderr : ""}`)
      .replace(/(?:\r\n)+$/, "");
    for (const sessionId of conn.sessions) {
      const session = this.sessions.get(sessionId);
      if (session && session.exited === null) {
        const prompt = session.lastPrompt ?? this.fallbackPrompt(conn);
        // exec() is a separate non-interactive SSH channel. It never makes
        // the PTY shell emit a prompt, so restore the last real prompt here.
        this.appendSessionOutput(session, `${display}\r\n${prompt}`, { capture: false, observePrompt: false });
      }
    }
    return {
      ok: true,
      value: {
        exitCode,
        stdout,
        stderr,
        display,
        commandId,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        truncated,
        timedOut
      }
    };
  }

  /** Send raw input into every live shell session of a connection. */
  writeToConnection(connectionId, input) {
    const conn = this.connections.get(connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    let written = 0;
    let blockedReason = null;
    for (const sessionId of conn.sessions) {
      const session = this.sessions.get(sessionId);
      if (session && session.exited === null && session.stream !== null) {
        try {
          const guarded = this.prepareTerminalInput(session, input);
          if (guarded.forwarded) session.stream.write(guarded.forwarded);
          written += guarded.forwarded.length;
          blockedReason ??= guarded.blockedReason;
        } catch {}
      }
    }
    if (blockedReason) return { ok: false, error: fail("unsafe-command", blockedReason) };
    return { ok: true, value: { written } };
  }

  /** Add a local policy notice to the same buffer rendered by the terminal. */
  appendTerminalNotice(session, message) {
    this.appendSessionOutput(session, `\r\n\x1b[33m[DSH SSH 安全策略] ${message}\x1b[0m\r\n`);
  }

  /**
   * Preserve normal terminal editing, but submit a line only after host-side
   * policy approval. A denied line is cleared with Ctrl-U before the shell can
   * execute it. History navigation and tab completion fail closed as well.
   */
  prepareTerminalInput(session, text) {
    let forwarded = "";
    let blockedReason = null;
    for (const char of text) {
      if (char === "\r" || char === "\n") {
        const decision = session.inputKnown
          ? assessShellCommand(session.inputLine)
          : { ok: false, reason: "安全策略已阻止：无法验证历史命令或自动补全后的内容。请手动输入只读诊断命令。" };
        if (decision.ok) {
          forwarded += char;
        } else {
          // The already-echoed command remains in the remote line editor until
          // Ctrl-U clears it; crucially, Enter itself never reaches the shell.
          forwarded += "\x15";
          blockedReason ??= decision.reason;
          this.appendTerminalNotice(session, decision.reason);
        }
        session.inputLine = "";
        session.inputKnown = true;
        continue;
      }
      if (char === "\x03") {
        session.inputLine = "";
        session.inputKnown = true;
        forwarded += char;
        continue;
      }
      if (char === "\b" || char === "\x7f") {
        if (session.inputKnown) session.inputLine = session.inputLine.slice(0, -1);
        forwarded += char;
        continue;
      }
      if (char === "\x1b" || char === "\t") {
        // Escape sequences (history/navigation) and completion can change the
        // remote line without a trustworthy local representation.
        session.inputKnown = false;
        forwarded += char;
        continue;
      }
      if (char.codePointAt(0) < 32) {
        forwarded += char;
        continue;
      }
      if (session.inputKnown) {
        session.inputLine += char;
        if (session.inputLine.length > 8192) session.inputKnown = false;
      }
      forwarded += char;
    }
    return { forwarded, blockedReason };
  }

  /** Current buffered text of a connection's first live shell session. */
  readConnectionOutput(connectionId) {
    const conn = this.connections.get(connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    const first = [...conn.sessions].map((id) => this.sessions.get(id)).find((s) => s !== void 0 && s.exited === null);
    if (first === void 0) {
      return { ok: true, value: { data: "", hasSession: false, truncated: false, redacted: false } };
    }
    const redaction = redactForModel(first.captureBuffer);
    return {
      ok: true,
      value: {
        data: redaction.text,
        hasSession: true,
        truncated: Buffer.byteLength(first.captureBuffer, "utf8") >= this.config.maxCaptureBytes,
        redacted: redaction.redacted
      }
    };
  }

  /**
   * Select the connection represented by the right-side terminal. For a
   * single connection, fall back to it so a normal conversational request
   * never has to expose an implementation-only UUID to the user.
   */
  resolveConnection(connectionId) {
    if (connectionId !== undefined) {
      const connection = this.connections.get(connectionId);
      if (connection !== undefined) return { ok: true, connectionId, connection };
      return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    }
    if (this.activeConnectionId !== null) {
      const connection = this.connections.get(this.activeConnectionId);
      if (connection !== undefined) {
        return { ok: true, connectionId: this.activeConnectionId, connection };
      }
      this.activeConnectionId = null;
    }
    if (this.connections.size === 1) {
      const [resolvedId, connection] = this.connections.entries().next().value;
      return { ok: true, connectionId: resolvedId, connection };
    }
    if (this.connections.size === 0) {
      return { ok: false, error: fail("no-connection", "no active SSH connection; connect a server in the SSH panel first") };
    }
    return { ok: false, error: fail("connection-selection-required", "multiple SSH connections are open; select a server in the SSH panel or provide connection_id") };
  }

  /** Execute a command on the explicit or current SSH connection. */
  async executeCommand(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const result = await this.execOnConnection(selected.connectionId, request.command, request.timeoutMs);
    if (!result.ok) return result;
    const { exitCode, stdout, stderr, commandId, startedAt, finishedAt, durationMs, truncated, timedOut } = result.value;
    const safeStdout = redactForModel(stdout);
    const safeStderr = redactForModel(stderr);
    return {
      ok: true,
      value: {
        connectionId: selected.connectionId,
        host: selected.connection.host,
        exitCode,
        stdout: safeStdout.text,
        stderr: safeStderr.text,
        commandId,
        startedAt,
        finishedAt,
        durationMs,
        truncated,
        timedOut,
        redacted: safeStdout.redacted || safeStderr.redacted
      }
    };
  }

  /** Read terminal output from the explicit or current SSH connection. */
  readCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const result = this.readConnectionOutput(selected.connectionId);
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        connectionId: selected.connectionId,
        host: selected.connection.host,
        ...result.value
      }
    };
  }

  /** Send tool input to the explicit or current SSH connection. */
  writeCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    return this.writeToConnection(selected.connectionId, request.input);
  }

  /** Disconnect the explicit or current SSH connection. */
  async disconnectCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    return this.disconnect({ connectionId: selected.connectionId });
  }

  /** Append transport data and retain a bounded, explicit-read capture. */
  appendSessionOutput(session, text, { capture = true, observePrompt = true } = {}) {
    session.buffer = tailCapped((session.buffer ?? "") + text, this.config.maxBufferBytes);
    if (capture) {
      session.captureBuffer = tailCapped((session.captureBuffer ?? "") + text, this.config.maxCaptureBytes);
    }
    if (observePrompt) {
      const prompt = promptFromTerminalData(text);
      if (prompt !== null) session.lastPrompt = prompt;
    }
    this.wakeWaiters(session, null);
  }

  fallbackPrompt(connection) {
    return `${connection.username}@${connection.host}:~${connection.username === "root" ? "#" : "$"} `;
  }

  // ── Agent tools ────────────────────────────────────────────────────────────

  registerTools(ctx) {
    // defineTool invokes execute as a bare function; bind the service via closure.
    const service = this;
    ctx.tools.register(defineTool({
      name: "ssh_list",
      description: "List currently open SSH connections and identify the active server. This reports only live connection metadata (name, host, port, username and active state); it never lists saved SSH resources or credentials. Use it only when the user asks which server is connected. For normal server work, ssh_exec/ssh_read/ssh_write already target the active connection automatically.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            activeConnectionId: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
            connections: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  connectionId: { type: "string", required: true },
                  name: { type: "string" },
                  host: { type: "string", required: true },
                  port: { type: "integer", required: true },
                  username: { type: "string", required: true },
                  connected: { type: "boolean", required: true },
                  sessions: { type: "array", required: true, items: { type: "string" } }
                }
              }
            }
          }
        },
        render(_args, value) {
          if (value.connections.length === 0) return [{ type: "text", text: "No SSH connection is currently open." }];
          const lines = value.connections.map((connection) => `${connection.connectionId === value.activeConnectionId ? "* " : "- "}${connection.name ?? connection.host}: ${connection.username}@${connection.host}:${connection.port}${connection.sessions.length ? " (terminal open)" : ""}`);
          return [{ type: "text", text: lines.join("\n") }];
        }
      },
      async execute() {
        const result = await service.list();
        if (!result.ok) throw new Error(`ssh_list failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "ssh_connect",
      description: "Connect to a remote server over SSH, open it in the right-side terminal, and make it the current connection for later SSH tools. Subsequent ssh_exec, ssh_read, ssh_write, and ssh_disconnect calls automatically use this connection unless a connection_id is explicitly supplied.",
      parameters: {
        host: { type: "string", required: true, description: "Remote hostname or IP address." },
        port: { type: "integer", description: "SSH port, defaults to 22." },
        username: { type: "string", required: true, description: "SSH username." },
        auth: {
          type: "object",
          required: true,
          additionalProperties: false,
          description: "Authentication. Either {kind: 'password', password} or {kind: 'key', privateKey, passphrase?}.",
          properties: {
            kind: { type: "string", enum: ["password", "key"], required: true },
            password: { type: "string" },
            privateKey: { type: "string" },
            passphrase: { type: "string" }
          }
        },
        name: { type: "string", description: "Optional display name for this connection." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            connectionId: { type: "string", required: true },
            name: { type: "string" },
            host: { type: "string", required: true },
            port: { type: "integer", required: true },
            username: { type: "string", required: true }
          }
        },
        render(args, value) {
          const conn = value ?? {};
          return [{ type: "text", text: `Connected ${args.username}@${args.host} (id: ${conn.connectionId ?? "?"})` }];
        }
      },
      async execute(args) {
        const result = await service.connect({
          host: args.host,
          port: args.port,
          username: args.username,
          auth: args.auth,
          name: args.name
        });
        if (!result.ok) throw new Error(`ssh_connect failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "ssh_exec",
      description: "Run a normal SSH command on the server currently open in the right-side SSH terminal and return its output. Omit connection_id when the user means the current server; do not call ssh_list first. SSL configuration, package changes, service reloads, and config edits are allowed and remain subject to DSH permissions. Explicitly destructive or irreversible operations are blocked from agent execution and must be typed manually by the user in the SSH terminal. The command and output are also shown in the terminal panel.",
      parameters: {
        connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." },
        command: { type: "string", required: true, description: "The shell command to execute." },
        timeout_ms: { type: "integer", description: "Timeout in milliseconds, defaults to 30000." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            connectionId: { type: "string", required: true },
            host: { type: "string", required: true },
            exitCode: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
            stdout: { type: "string", required: true },
            stderr: { type: "string", required: true },
            commandId: { type: "string", required: true },
            startedAt: { type: "string", required: true },
            finishedAt: { type: "string", required: true },
            durationMs: { type: "integer", required: true },
            truncated: { type: "boolean", required: true },
            timedOut: { type: "boolean", required: true },
            redacted: { type: "boolean", required: true }
          }
        },
        render(args, value) {
          const out = value.stdout ?? "";
          const err = value.stderr ?? "";
          let body = out;
          if (err.length > 0) {
            if (body.length > 0 && !body.endsWith("\n")) body += "\n";
            body += `[stderr]\n${err}`;
          }
          if (body.length === 0) body = "(no output)";
          if (value.exitCode !== null && value.exitCode !== 0) body += `\n[exit code: ${value.exitCode}]`;
          if (value.timedOut) body += "\n[command timed out]";
          if (value.truncated) body += "\n[output truncated for safe model context]";
          if (value.redacted) body += "\n[sensitive values redacted]";
          return [{ type: "text", text: body }];
        }
      },
      async execute(args) {
        const result = await service.executeCommand({
          connectionId: args.connection_id,
          command: args.command,
          timeoutMs: args.timeout_ms ?? 30000
        });
        if (!result.ok) throw new Error(`ssh_exec failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "ssh_read",
      description: "Read buffered output from the current right-side SSH terminal. Omit connection_id for the current server; do not call ssh_list first. Useful after ssh_write or when the user typed something in the panel.",
      parameters: {
        connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            connectionId: { type: "string", required: true },
            host: { type: "string", required: true },
            data: { type: "string", required: true },
            hasSession: { type: "boolean", required: true },
            truncated: { type: "boolean", required: true },
            redacted: { type: "boolean", required: true }
          }
        },
        render(args, value) {
          const body = !value.hasSession
            ? "(no open shell session on this connection)"
            : value.data || "(no output yet)";
          const notes = [
            value.truncated ? "[terminal capture truncated]" : "",
            value.redacted ? "[sensitive values redacted]" : ""
          ].filter(Boolean);
          return [{ type: "text", text: notes.length > 0 ? `${body}\n${notes.join("\n")}` : body }];
        }
      },
      async execute(args) {
        const result = service.readCurrentConnection({ connectionId: args.connection_id });
        if (!result.ok) throw new Error(`ssh_read failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "ssh_write",
      description: "Send input into the current right-side SSH terminal. Omit connection_id for the current server. Normal operations are permitted through DSH permissions; explicitly destructive or irreversible commands are stopped before agent execution. Ctrl-C remains available to cancel an in-progress command.",
      parameters: {
        connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." },
        input: { type: "string", required: true, description: "The input to send, e.g. 'y\\n' to answer a prompt." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            written: { type: "integer", required: true }
          }
        },
        render(args, value) {
          return [{ type: "text", text: `Sent ${value.written} bytes to the terminal session.` }];
        }
      },
      async execute(args) {
        const result = service.writeCurrentConnection({ connectionId: args.connection_id, input: args.input });
        if (!result.ok) throw new Error(`ssh_write failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "ssh_disconnect",
      description: "Close the current SSH connection and any open shell sessions on it. Omit connection_id for the current right-side SSH server.",
      parameters: {
        connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            disconnected: { type: "boolean", required: true }
          }
        },
        render(args, value) {
          return [{ type: "text", text: value.disconnected ? "Disconnected." : "Connection not found." }];
        }
      },
      async execute(args) {
        const result = await service.disconnectCurrentConnection({ connectionId: args.connection_id });
        if (!result.ok) throw new Error(`ssh_disconnect failed: ${result.error.message}`);
        return result.value;
      }
    }));

  }

  // ── internals ──────────────────────────────────────────────────────────────

  recordExit(session, exit) {
    if (session.exited !== null) return;
    session.exited = exit;
    this.wakeWaiters(session, exit);
  }

  rememberExit(id, exit) {
    if (this.exitedSessions.size >= 64) {
      const oldest = this.exitedSessions.keys().next().value;
      if (oldest !== void 0) this.exitedSessions.delete(oldest);
    }
    this.exitedSessions.set(id, exit);
  }

  wakeWaiters(session, exit) {
    if (session.waiters.length === 0) return;
    session.waiters.shift().resolve({
      ok: true,
      value: { data: this.drain(session), exit }
    });
    if (exit !== null) {
      for (const rest of session.waiters.splice(0)) {
        rest.resolve({ ok: true, value: { data: "", exit } });
      }
    }
  }

  drain(session) {
    const pending = session.buffer;
    session.buffer = "";
    return encodeData(pending);
  }
}
