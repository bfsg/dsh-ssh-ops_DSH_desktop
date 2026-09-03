/**
 * dsh-ssh-ops host half: a Typert Remote service named `sshOps` that manages
 * ssh2 connections and PTY shell sessions, streaming output to the browser
 * through long-poll reads. Also registers agent tools (ssh_connect, ssh_exec,
 * ...) so the main conversation can drive the same sessions the panel shows.
 */
import { randomUUID } from "node:crypto";
import net from "node:net";
import { Client } from "ssh2";
import { Service } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { z } from "zod";
import { assessShellCommand, isPrefillable, shellQuote } from "./safety.js";
import { scpCommand, scpDownload, scpUpload } from "./scp.js";
import { redactForModel } from "./redact.js";
import { DbOpsManager, pickSshConnectionId } from "./db-ops.js";
import {
  KnownHosts,
  decideHostKey,
  keyFingerprint,
  blobAlgorithm,
  DEFAULT_HOST_KEY_MODE
} from "./hostkey.js";

const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_CAPTURE_BYTES = 128 * 1024;
const READ_TIMEOUT_MS = 300;
const MAX_SESSIONS = 64;
// ssh2 disables keepalives by default; without them NATs and cloud firewalls
// silently drop idle connections and every later operation fails on a dead
// transport. Keep the mapping alive and detect a truly dead link fast.
const KEEPALIVE_INTERVAL_MS = 20000;
const KEEPALIVE_COUNT_MAX = 3;
// Transient connect failures (resets, timeouts, scanner-induced refusals) are
// retried with backoff; authentication failures are never retried.
const CONNECT_RETRIES = 3;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_WAIT_MS = 30000;

const profileRecordSchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  authKind: z.enum(["password", "key"]),
  groupId: z.string().uuid().nullable(),
  // Host-key TOFU mode persisted per saved server; optional so records saved
  // before this feature existed still load (treated as the accept-new default).
  hostKeyMode: z.string().optional(),
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

const dbProfileRecordSchema = z.object({
  name: z.string(),
  type: z.enum(["mysql", "postgresql", "redis", "mongodb"]),
  host: z.string(),
  port: z.number().int(),
  database: z.string().nullable(),
  username: z.string().nullable(),
  ssl: z.string(),
  sshProfileId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const dbProfileDomainSpec = defineDomain({
  name: "db_ops_profiles",
  version: 1,
  tables: {
    profiles: domainTable(dbProfileRecordSchema)
  }
});

const knownHostRecordSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  algorithm: z.string(),
  fingerprint: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string()
});

const knownHostDomainSpec = defineDomain({
  name: "ssh_ops_known_hosts",
  version: 1,
  tables: {
    known_hosts: domainTable(knownHostRecordSchema)
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

function dbProfileCredentialRefs(dbProfileId) {
  const stem = dbProfileId.replaceAll("-", "").toUpperCase();
  return { password: `DSH_DB_OPS_${stem}_PASSWORD` };
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
  /** confirmationId -> agent-originated dangerous command awaiting a human. */
  pendingConfirmations = new Map();
  /** batchId -> operator-selected batch exec task awaiting selection/execution. */
  batchTasks = new Map();

  /** The connection currently represented by the right-side terminal panel. */
  activeConnectionId = null;
  profileTable = null;
  groupTable = null;
  /** known_hosts table (host:port → fingerprint record); null until [Service.init]. */
  knownHostTable = null;
  /** KnownHosts adapter over `knownHostTable`; null until [Service.init]. */
  knownHosts = null;

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
        conn.closing = true;
        if (conn.reconnectTimer !== null) clearTimeout(conn.reconnectTimer);
        try { conn.client?.end(); } catch {}
        for (const hop of conn.hops ?? []) { try { hop.end(); } catch {} }
      }
      this.connections.clear();
      this.sessions.clear();
      this.exitedSessions.clear();
      this.pendingConfirmations.clear();
      this.activeConnectionId = null;
      try { this.dbOps?.closeAll().catch(() => {}); } catch {}
    }, "ssh-ops: cleanup");
    this.dbOps = new DbOpsManager(this);
    this.registerTools(ctx);
  }

  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(profileDomainSpec);
    this.profileTable = domain.table("profiles");
    this.groupTable = domain.table("groups");
    this.ctx.effect(() => () => domain.close(), "ssh-ops: profile domain close");
    const dbDomain = await this.ctx.storageDomain.open(dbProfileDomainSpec);
    this.dbProfileTable = dbDomain.table("profiles");
    this.ctx.effect(() => () => dbDomain.close(), "ssh-ops: db profile domain close");
    const knownHostDomain = await this.ctx.storageDomain.open(knownHostDomainSpec);
    this.knownHostTable = knownHostDomain.table("known_hosts");
    this.knownHosts = new KnownHosts(this.knownHostTable);
    this.ctx.effect(() => () => knownHostDomain.close(), "ssh-ops: known-host domain close");
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
    const connectConfig = {
      host: request.host,
      port: request.port ?? 22,
      username: request.username,
      readyTimeout: request.readyTimeout ?? 20000,
      keepaliveInterval: request.keepaliveInterval ?? KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: request.keepaliveCountMax ?? KEEPALIVE_COUNT_MAX
    };
    if (request.auth.kind === "password") {
      connectConfig.password = request.auth.password;
    } else {
      connectConfig.privateKey = request.auth.privateKey;
      if (request.auth.passphrase !== void 0) connectConfig.passphrase = request.auth.passphrase;
    }
    const record = {
      id,
      client: null,
      hops: [],
      host: connectConfig.host,
      port: connectConfig.port,
      username: connectConfig.username,
      name: request.name,
      profileId,
      sessions: new Set(),
      sftp: null,
      tunnels: new Map(),
      // Transport health / self-healing state: keep the auth config around so
      // a dropped transport can be re-established transparently instead of
      // forcing the user to open a brand-new session.
      connectConfig,
      proxyJump: Array.isArray(request.proxyJump) ? request.proxyJump : [],
      // Host-key TOFU mode for this connection (undefined → accept-new default
      // resolved in attachHostVerifier). Persisted on the record so transparent
      // reconnects re-check with the same policy.
      hostKeyMode: request.hostKeyMode,
      dead: true,
      closing: false,
      connecting: true,
      reconnectTimer: null,
      reconnectAttempts: 0,
      reconnectWaiters: []
    };
    this.connections.set(id, record);
    const connected = await this.connectClient(record, request.retries ?? CONNECT_RETRIES);
    record.connecting = false;
    if (!connected.ok) {
      this.connections.delete(id);
      return connected;
    }
    this.attachTransportHandlers(record);
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

  // ── host-key TOFU ──────────────────────────────────────────────────────────

  /**
   * Build an ssh2 `hostVerifier` (key, verify) => boolean for a host:port.
   * Decides accept/record/reject against the known_hosts store; on rejection
   * stashes a verdict on `state` so the caller surfaces a non-retriable error,
   * and on first-seen acceptance stashes a record-to-persist after `ready`.
   */
  makeHostVerifier(state, host, port, mode) {
    return (key) => {
      try {
        const algorithm = blobAlgorithm(key);
        const presented = keyFingerprint(key);
        const known = this.knownHosts?.get(host, port);
        const verdict = decideHostKey({ mode, known, presentedFingerprint: presented, algorithm });
        if (!verdict.accept) {
          state.hostKeyMismatch = { reason: verdict.reason, host, port, mode, expected: verdict.expected, got: verdict.got ?? presented };
          return false;
        }
        if (verdict.record) {
          state.hostKeyToRecord = { host, port, fingerprint: verdict.record.fingerprint, algorithm: verdict.record.algorithm };
        }
        return true;
      } catch (error) {
        state.hostKeyMismatch = { reason: "verifier-error", host, port, mode, message: error.message };
        return false;
      }
    };
  }

  /** Attach a TOFU verifier to an ssh2 connect config (no-op when off or store not ready). */
  attachHostVerifier(config, state, host, port, mode) {
    const effective = mode ?? DEFAULT_HOST_KEY_MODE;
    if (this.knownHosts === null || effective === "off") return;
    config.hostVerifier = this.makeHostVerifier(state, host, port, effective);
  }

  /** Persist a first-seen host key after a successful handshake. */
  async persistFirstSeenHostKey(state) {
    const pending = state.hostKeyToRecord;
    if (!pending) return;
    state.hostKeyToRecord = null;
    if (this.knownHosts !== null) {
      await this.knownHosts.record(pending.host, pending.port, { fingerprint: pending.fingerprint, algorithm: pending.algorithm });
    }
  }

  /** Turn a stashed host-key verdict into a non-retriable result error. */
  hostKeyError(m) {
    const where = `${m.host}:${m.port}`;
    if (m.reason === "unseen-host") {
      return fail("host-key-unseen", `host key for ${where} is not previously trusted (mode ${m.mode}). Presented SHA256:${m.got}; verify it out of band. Strict mode will not create a trust record; follow your approved process before changing the profile policy.`);
    }
    if (m.reason === "host-key-mismatch") {
      return fail("host-key-mismatch", `host key for ${where} changed (mode ${m.mode}). Expected SHA256:${m.expected}; presented SHA256:${m.got}. This may be a man-in-the-middle or a re-provisioned server. Verify it out of band; if legitimate, use "忘记主机指纹" and reconnect.`);
    }
    return fail("host-key-error", `host key verification error for ${where} (mode ${m.mode}): ${m.message ?? m.reason}`);
  }

  /**
   * Establish (or re-establish) the ssh2 transport of a connection record.
   * Transient network failures are retried with backoff; authentication
   * failures are not.
   */
  async connectClient(record, retries = CONNECT_RETRIES) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (record.closing) {
        return { ok: false, error: fail("connect-cancelled", `connection "${record.id}" was closed`) };
      }
      // Build the jump chain first (if configured): each hop connects through
      // the previous one via forwardOut, producing a stream that becomes the
      // `sock` of the target connection. On failure the whole chain is torn down.
      let sock;
      if (record.proxyJump.length > 0) {
        try {
          const chain = await this.connectChain(record.proxyJump, record.connectConfig.host, record.connectConfig.port);
          record.hops = chain.hops;
          sock = chain.sock;
        } catch (error) {
          lastError = error;
          if (error?.code === "host-key-mismatch" || error?.code === "host-key-unseen" || error?.code === "host-key-error") {
            return { ok: false, error: fail(error.code, error.message) };
          }
          if (attempt >= retries) break;
          await this.sleep(Math.min(2000, 500 * 2 ** attempt));
          continue;
        }
      }
      const client = new Client();
      record.client = client;
      try {
        await new Promise((resolve, reject) => {
          // ssh2 can emit several protocol errors while a handshake is dying
          // (observed live: "Connection lost before handshake" twice in a
          // row). The first event settles the wait; the standing error
          // listener must outlive it, because an 'error' emission with zero
          // listeners crashes the whole DSH process. A cancelled connect is
          // broken out of via the close event below.
          let settled = false;
          const onReady = () => { if (!settled) { settled = true; resolve(); } };
          const onError = (cause) => { if (!settled) { settled = true; reject(cause); } };
          const onClose = () => { if (!settled) { settled = true; reject(new Error("connection closed before handshake completed")); } };
          client.once("ready", onReady);
          client.on("error", onError);
          client.once("close", onClose);
          const config = { ...record.connectConfig };
          if (sock !== undefined) config.sock = sock;
          this.attachHostVerifier(config, record, record.host, record.port, record.hostKeyMode);
          client.connect(config);
        });
        record.dead = false;
        record.reconnectAttempts = 0;
        await this.persistFirstSeenHostKey(record);
        return { ok: true };
      } catch (error) {
        // Host-key TOFU rejection is never transient: surface it, don't retry.
        if (record.hostKeyMismatch) {
          for (const hop of record.hops) { try { hop.end(); } catch {} }
          record.hops = [];
          return { ok: false, error: this.hostKeyError(record.hostKeyMismatch) };
        }
        lastError = error;
        // A cancelled connect must not spend its remaining retry attempts.
        if (record.closing) break;
        // Tear down hops on failure so the retry starts fresh.
        for (const hop of record.hops) { try { hop.end(); } catch {} }
        record.hops = [];
        const message = String(error?.message ?? error);
        const transient = /reset|timeout|timed out|kex|handshake|socket|ECONN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN/i.test(message)
          && !/authenticat|permission|denied/i.test(message);
        if (!transient || attempt >= retries) break;
        await this.sleep(Math.min(2000, 500 * 2 ** attempt));
      }
    }
    if (record.closing) {
      return { ok: false, error: fail("connect-cancelled", `connection "${record.id}" was closed`) };
    }
    return {
      ok: false,
      error: fail("connect-failed", `${record.username}@${record.host}:${record.port}: ${lastError?.message ?? "connection failed"}`)
    };
  }

  /**
   * Build one full jump chain: hop clients connected through in order, each
   * forwarding a stream to the next destination, ending with a stream usable
   * as the `sock` of the target connection. Returns the final stream and the
   * list of hop clients (for teardown). Each hop config is an inline object
   * {host, port, username, auth, readyTimeout}.
   */
  async connectChain(proxyJump, targetHost, targetPort) {
    const hops = [];
    let sock;
    for (let index = 0; index < proxyJump.length; index += 1) {
      const hopConfig = proxyJump[index];
      const hopConnectConfig = {
        host: hopConfig.host,
        port: hopConfig.port ?? 22,
        username: hopConfig.username,
        readyTimeout: hopConfig.readyTimeout ?? 20000
      };
      if (hopConfig.auth?.kind === "password") {
        hopConnectConfig.password = hopConfig.auth.password;
      } else if (hopConfig.auth?.kind === "key") {
        hopConnectConfig.privateKey = hopConfig.auth.privateKey;
        if (hopConfig.auth.passphrase !== void 0) hopConnectConfig.passphrase = hopConfig.auth.passphrase;
      }
      if (sock !== undefined) hopConnectConfig.sock = sock;
      const hopState = { hostKeyMismatch: null, hostKeyToRecord: null };
      this.attachHostVerifier(hopConnectConfig, hopState, hopConnectConfig.host, hopConnectConfig.port, hopConfig.hostKeyMode);
      const hopClient = new Client();
      try {
        await new Promise((resolve, reject) => {
          // Standing error listener for the hop's whole life: ssh2 may emit a
          // second protocol error after the first one settled this promise,
          // and an unhandled 'error' crashes the DSH process.
          let settled = false;
          hopClient.once("ready", () => { if (!settled) { settled = true; resolve(); } });
          hopClient.on("error", (cause) => { if (!settled) { settled = true; reject(cause); } });
          hopClient.connect(hopConnectConfig);
        });
        await this.persistFirstSeenHostKey(hopState);
      } catch (error) {
        for (const h of hops) { try { h.end(); } catch {} }
        if (hopState.hostKeyMismatch) {
          const m = hopState.hostKeyMismatch;
          const hostKeyFailure = this.hostKeyError(m);
          const hopError = new Error(`proxyJump hop ${index + 1} (${hopConnectConfig.username}@${hopConnectConfig.host}:${hopConnectConfig.port}): ${hostKeyFailure.message}`);
          hopError.code = hostKeyFailure.code;
          throw hopError;
        }
        throw new Error(`proxyJump hop ${index + 1} (${hopConnectConfig.username}@${hopConnectConfig.host}:${hopConnectConfig.port}): ${error.message}`);
      }
      hops.push(hopClient);
      // forwardOut to the next destination: the next hop, or the final target.
      const next = index + 1 < proxyJump.length ? proxyJump[index + 1] : null;
      const nextHost = next !== null ? next.host : targetHost;
      const nextPort = next !== null ? (next.port ?? 22) : targetPort;
      sock = await new Promise((resolve, reject) => {
        hopClient.forwardOut("127.0.0.1", 0, nextHost, nextPort, (error, stream) => {
          if (error) {
            for (const h of hops) { try { h.end(); } catch {} }
            reject(new Error(`proxyJump hop ${index + 1} forwardOut to ${nextHost}:${nextPort}: ${error.message}`));
          } else {
            resolve(stream);
          }
        });
      });
    }
    return { hops, sock };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Wire transport-loss handlers to the record's current client. */
  attachTransportHandlers(record) {
    const client = record.client;
    client.on("error", (error) => this.handleTransportLoss(record, client, error));
    client.on("close", () => this.handleTransportLoss(record, client, null));
  }

  /**
   * The transport died under us (idle NAT drop, network blip, server reset).
   * Mark the record dead, retire its shell sessions and SFTP channel, then
   * schedule a transparent reconnect so later operations self-heal instead of
   * forcing a brand-new session every time.
   */
  handleTransportLoss(record, client, error) {
    if (record.closing || record.client !== client || record.dead) return;
    record.dead = true;
    record.sftp = null;
    for (const sessionId of [...record.sessions]) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.exited = session.exited ?? { code: 1 };
        session.stream = null;
        this.rememberExit(sessionId, session.exited);
      }
      this.sessions.delete(sessionId);
    }
    record.sessions.clear();
    for (const tunnel of record.tunnels.values()) tunnel.active = false;
    this.scheduleReconnect(record);
  }

  /** Auto-reconnect a dead record with capped exponential backoff. */
  scheduleReconnect(record) {
    if (record.closing || !record.dead || record.reconnectTimer !== null) return;
    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** Math.min(record.reconnectAttempts, 5)
    );
    record.reconnectAttempts += 1;
    record.reconnectTimer = setTimeout(async () => {
      record.reconnectTimer = null;
      if (record.closing || !record.dead) return;
      const connected = await this.connectClient(record, 0);
      if (!connected.ok) {
        // A host-key mismatch/unseen must NOT trigger a reconnect storm against
        // a possibly re-provisioned or impersonated server: stop retrying and
        // let the operator decide (forget the key or investigate).
        const code = connected.error?.code;
        if (code === "host-key-mismatch" || code === "host-key-unseen" || code === "host-key-error") {
          return;
        }
        this.scheduleReconnect(record);
        return;
      }
      this.attachTransportHandlers(record);
      for (const tunnel of record.tunnels.values()) {
        if (tunnel.kind === "remote" && tunnel.bridgeInfo?.bridge) {
          record.client.prependListener("tcp connection", tunnel.bridgeInfo.bridge);
        }
        tunnel.active = true;
      }
      const waiters = record.reconnectWaiters.splice(0);
      for (const waiter of waiters) waiter();
    }, delay);
  }

  /**
   * Wait until the record's transport is usable. If it is dead, waits for the
   * in-flight reconnect (bounded). Resolves false only when the connection was
   * explicitly closed or reconnect did not complete in time.
   */
  ensureAlive(record, timeoutMs = RECONNECT_WAIT_MS) {
    if (record.closing) return Promise.resolve(false);
    if (!record.dead) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      record.reconnectWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  requireProfileTable() {
    if (this.profileTable === null) throw new Error("SSH resource storage is not ready");
    return this.profileTable;
  }

  requireKnownHostTable() {
    if (this.knownHostTable === null) throw new Error("known-host storage is not ready");
    return this.knownHostTable;
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
      hostKeyMode: record.hostKeyMode ?? DEFAULT_HOST_KEY_MODE,
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
        hostKeyMode: request.hostKeyMode ?? DEFAULT_HOST_KEY_MODE,
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

  /**
   * Disconnect every live connection opened for a saved profile. The
   * resources page owns this path so a "已连接" badge always has a matching
   * operator control, including connections re-adopted after a page reload.
   */
  async profileDisconnect(request) {
    try {
      const targets = [...this.connections.values()].filter((connection) => connection.profileId === request.profileId);
      for (const record of targets) await this.disconnect({ connectionId: record.id });
      return { ok: true, value: { disconnected: targets.length } };
    } catch (error) {
      return { ok: false, error: fail("profile-disconnect-failed", error.message) };
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
        hostKeyMode: record.hostKeyMode,
        readyTimeout: request.readyTimeout,
        retries: request.retries,
        auth: record.authKind === "password"
          ? { kind: "password", password: primary.value }
          : { kind: "key", privateKey: primary.value, ...(passphrase === undefined ? {} : { passphrase: passphrase.value }) }
      }, request.profileId);
    } catch (error) {
      return { ok: false, error: fail("profile-connect-failed", error.message) };
    }
  }

  /**
   * Abort an in-flight profile connect. Safe to call after the connect
   * settled (then it is a no-op); while the handshake is pending, ending the
   * socket breaks the wait immediately.
   */
  async cancelProfileConnect(request) {
    try {
      let cancelled = 0;
      for (const record of this.connections.values()) {
        if (!record.connecting) continue;
        if (request?.profileId !== undefined && record.profileId !== request.profileId) continue;
        record.closing = true;
        cancelled += 1;
        try { for (const hop of record.hops) { hop.end(); } } catch {}
        record.hops = [];
        try { record.client?.end(); } catch {}
      }
      return { ok: true, value: { cancelled } };
    } catch (error) {
      return { ok: false, error: fail("cancel-connect-failed", error.message) };
    }
  }

  /** Connect a saved profile, run one command, then disconnect. Batch channel only. */
  async runCommandOnProfile(profileId, command, timeoutMs = 30000) {
    const record = this.requireProfileTable().get(profileId);
    if (record === undefined) return { ok: false, error: fail("no-profile", `SSH resource "${profileId}" does not exist`) };
    const connect = await this.profileConnect({ profileId });
    if (!connect.ok) return connect;
    const connectionId = connect.value.connectionId;
    try {
      const raw = await this.execRawOnClient(this.connections.get(connectionId).client, command, timeoutMs);
      if (!raw.ok) return raw;
      return { ok: true, value: { ...raw.value, profileId, name: record.name, host: record.host } };
    } catch (error) {
      return { ok: false, error: fail("exec-failed", error.message) };
    } finally {
      await this.disconnect({ connectionId }).catch(() => {});
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

  // ── known-hosts management (operator only; NOT exposed as agent tools) ────

  async listKnownHosts() {
    try {
      const hosts = this.knownHosts ? this.knownHosts.list() : [];
      return { ok: true, value: { hosts } };
    } catch (error) {
      return { ok: false, error: fail("known-hosts-list-failed", error.message) };
    }
  }

  async forgetHostKey(request) {
    try {
      if (this.knownHosts === null) {
        return { ok: false, error: fail("known-hosts-not-ready", "known-host storage is not ready") };
      }
      const forgotten = await this.knownHosts.forget(request.host, request.port);
      return { ok: true, value: { forgotten } };
    } catch (error) {
      return { ok: false, error: fail("forget-host-key-failed", error.message) };
    }
  }

  async openSession(request) {
    const conn = this.connections.get(request.connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${request.connectionId}" does not exist`) };
    if (this.sessions.size >= MAX_SESSIONS) return { ok: false, error: fail("session-limit", `too many live sessions (${MAX_SESSIONS})`) };
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${request.connectionId}" is down and could not be re-established`) };
    }
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
    try {
      if (text) {
        const pending = this.pendingForSession(session.id);
        if (pending) {
          // A card's Execute button is the only confirmation path for an
          // agent-originated dangerous command.  Keyboard Enter cannot submit
          // it, while Ctrl-C and any edit revoke the pending approval first.
          if (text === "\r" || text === "\n") {
            this.appendTerminalNotice(session, "此危险命令不会因回车执行：请使用面板弹出的确认卡片，点击“执行”或“撤销”。");
            return { ok: true, value: { written: 0 } };
          }
          if (text === "\x03") {
            this.removePendingConfirmation(pending.confirmationId);
            session.stream.write(text);
            session.inputLine = "";
            session.inputKnown = true;
            return { ok: true, value: { written: text.length } };
          }
          this.removePendingConfirmation(pending.confirmationId);
          // Clear the protected prefill before allowing the operator's new
          // input through.  From this point the terminal is fully manual.
          session.stream.write(`\x15${text}`);
          session.inputLine = "";
          session.inputKnown = true;
          this.updateInputMirror(session, text);
          return { ok: true, value: { written: text.length } };
        }
        // This path is interactive operator input. It remains intentionally
        // unguarded; agent calls use writeToConnection()/execOnConnection().
        session.stream.write(text);
        this.updateInputMirror(session, text);
      }
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

  pendingConfirmationList() {
    return {
      ok: true,
      value: {
        confirmations: [...this.pendingConfirmations.values()]
          .map((item) => this.publicPendingConfirmation(item))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      }
    };
  }

  batchPlan(request) {
    const decision = assessShellCommand(request.command);
    // Clamp here, not just in the RPC schema: the ssh_batch tool calls this
    // method directly and bypasses zod, so an agent-supplied timeout_ms must
    // still land inside the 1s–120s window.
    const timeoutMs = Math.min(120000, Math.max(1000, request.timeoutMs ?? 30000));
    const task = {
      batchId: randomUUID(),
      command: request.command.trim(),
      timeoutMs,
      dangerous: !decision.ok,
      reason: decision.ok ? null : (decision.category ?? decision.reason),
      createdAt: new Date().toISOString()
    };
    this.batchTasks.set(task.batchId, task);
    return { ok: true, value: { task } };
  }

  batchTaskList() {
    return { ok: true, value: { tasks: [...this.batchTasks.values()] } };
  }

  async batchRun(request) {
    const task = this.batchTasks.get(request.batchId);
    if (!task) return { ok: false, error: fail("batch-missing", `批量任务 "${request.batchId}" 不存在或已执行`) };
    if (request.profileIds.length === 0) return { ok: false, error: fail("batch-no-targets", "未选择任何服务器") };
    this.batchTasks.delete(request.batchId);
    const results = await Promise.all(request.profileIds.map(async (profileId) => {
      try {
        const r = await this.runCommandOnProfile(profileId, task.command, task.timeoutMs);
        if (!r.ok) return { profileId, name: "", host: "", ok: false, exitCode: null, stdout: "", stderr: "", error: r.error.message };
        return { profileId, name: r.value.name, host: r.value.host, ok: true, exitCode: r.value.exitCode, stdout: r.value.stdout, stderr: r.value.stderr, error: null };
      } catch (error) {
        return { profileId, name: "", host: "", ok: false, exitCode: null, stdout: "", stderr: "", error: error.message };
      }
    }));
    return { ok: true, value: { results } };
  }

  batchCancel(request) {
    const cancelled = this.batchTasks.delete(request.batchId);
    return { ok: true, value: { cancelled } };
  }

  pendingConfirmationApprove(request) {
    const pending = this.pendingConfirmations.get(request.confirmationId);
    if (!pending) return { ok: false, error: fail("confirmation-missing", "待确认命令不存在或已处理") };
    const session = this.sessions.get(pending.sessionId);
    if (!session || session.exited !== null || session.stream === null) {
      this.removePendingConfirmation(pending.confirmationId);
      return { ok: false, error: fail("confirmation-session-closed", "终端已关闭，无法执行待确认命令") };
    }
    if (pending.prefilled && (!session.inputKnown || session.inputLine !== pending.command)) {
      this.removePendingConfirmation(pending.confirmationId);
      return { ok: false, error: fail("confirmation-modified", "终端命令已变化，待确认项已作废") };
    }
    try {
      this.removePendingConfirmation(pending.confirmationId);
      // Clear any text the operator may have typed, then send the command +
      // Enter.  Without the line-kill the command would concatenate onto
      // unsaved input and produce a garbled, unsafe shell line.
      session.stream.write(`\x15${pending.command}\r`);
      session.inputLine = "";
      session.inputKnown = true;
      return { ok: true, value: { executed: true } };
    } catch (error) {
      return { ok: false, error: fail("confirmation-execute-failed", error.message) };
    }
  }

  pendingConfirmationCancel(request) {
    const pending = this.pendingConfirmations.get(request.confirmationId);
    if (!pending) return { ok: false, error: fail("confirmation-missing", "待确认命令不存在或已处理") };
    const session = this.sessions.get(pending.sessionId);
    this.removePendingConfirmation(pending.confirmationId);
    if (pending.prefilled && session && session.exited === null && session.stream !== null) {
      try { session.stream.write("\x15"); } catch {}
      session.inputLine = "";
      session.inputKnown = true;
    }
    return { ok: true, value: { cancelled: true } };
  }

  /** The one protected line currently visible in a terminal, if any. */
  pendingForSession(sessionId) {
    for (const pending of this.pendingConfirmations.values()) {
      if (pending.sessionId === sessionId && pending.prefilled) return pending;
    }
    return null;
  }

  removePendingConfirmation(confirmationId) {
    this.pendingConfirmations.delete(confirmationId);
  }

  removePendingForSession(sessionId) {
    for (const [confirmationId, pending] of this.pendingConfirmations) {
      if (pending.sessionId === sessionId) this.pendingConfirmations.delete(confirmationId);
    }
  }

  publicPendingConfirmation(pending) {
    return {
      confirmationId: pending.confirmationId,
      connectionId: pending.connectionId,
      sessionId: pending.sessionId,
      ...(pending.name ? { name: pending.name } : {}),
      host: pending.host,
      command: pending.command,
      reason: pending.reason,
      createdAt: pending.createdAt,
      prefilled: pending.prefilled
    };
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
    this.removePendingForSession(request.sessionId);
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
    // Explicit disconnect: never auto-reconnect, and stop any in-flight one.
    conn.closing = true;
    if (conn.reconnectTimer !== null) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    for (const sessionId of [...conn.sessions]) {
      const session = this.sessions.get(sessionId);
      if (session) {
        this.sessions.delete(sessionId);
        this.removePendingForSession(sessionId);
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
    for (const hop of conn.hops ?? []) { try { hop.end(); } catch {} }
    conn.hops = [];
    return { ok: true, value: { disconnected: true } };
  }

  // ── Database ops (proxied to DbOpsManager) ─────────────────────────────────

  async dbConnect(request) {
    return this.dbOps.connect(request);
  }

  async dbListConnections(request) {
    return this.dbOps.list(request);
  }

  async dbQuery(request) {
    return this.dbOps.query(request);
  }

  async dbExecute(request) {
    return this.dbOps.execute(request);
  }

  async dbListTables(request) {
    return this.dbOps.listTables(request);
  }

  async dbDescribeTable(request) {
    return this.dbOps.describeTable(request);
  }

  async dbRun(request) {
    return this.dbOps.run(request);
  }

  async dbDisconnect(request) {
    return this.dbOps.disconnect(request);
  }

  async dbPreview(request) {
    return this.dbOps.preview(request);
  }

  async dbExplain(request) {
    return this.dbOps.explain(request);
  }

  async dbTxBegin(request) {
    return this.dbOps.dbTxBegin(request);
  }

  async dbTxExecute(request) {
    return this.dbOps.dbTxExecute(request);
  }

  async dbTxCommit(request) {
    return this.dbOps.dbTxCommit(request);
  }

  async dbTxRollback(request) {
    return this.dbOps.dbTxRollback(request);
  }

  // ── Database profile CRUD (durable connections) ────────────────────────────

  requireDbProfileTable() {
    if (this.dbProfileTable === null) throw new Error("DB profile storage is not ready");
    return this.dbProfileTable;
  }

  async dbProfilePublic(dbProfileId, record) {
    const refs = dbProfileCredentialRefs(dbProfileId);
    const cred = await this.ctx.credentials.describe(credentialRef(refs.password));
    const connected = [...this.dbOps.dbConnections.values()].some((c) => c.config.name === record.name);
    return {
      dbProfileId,
      name: record.name,
      type: record.type,
      host: record.host,
      port: record.port,
      database: record.database,
      username: record.username,
      ssl: record.ssl,
      sshProfileId: record.sshProfileId,
      credentialConfigured: cred.configured,
      connected
    };
  }

  async dbProfileList() {
    try {
      const profiles = await Promise.all(
        [...this.requireDbProfileTable().entries()].map(async ([id, rec]) => await this.dbProfilePublic(id, rec))
      );
      profiles.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
      return { ok: true, value: { profiles } };
    } catch (error) {
      return { ok: false, error: fail("db-profile-list-failed", error.message) };
    }
  }

  async dbProfileSave(request) {
    try {
      const table = this.requireDbProfileTable();
      const dbProfileId = request.dbProfileId ?? randomUUID();
      const previous = table.get(dbProfileId);
      if (request.dbProfileId !== undefined && previous === undefined) {
        return { ok: false, error: fail("no-db-profile", `DB profile "${dbProfileId}" does not exist`) };
      }
      const now = new Date().toISOString();
      const record = {
        name: request.name.trim(),
        type: request.type,
        host: request.host.trim(),
        port: request.port,
        database: request.database?.trim() || null,
        username: request.username?.trim() || null,
        ssl: request.ssl ?? "disabled",
        sshProfileId: request.sshProfileId || null,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      };
      await table.put(dbProfileId, record);
      // If a password was provided, store it as an encrypted credential.
      if (request.password !== undefined && request.password.length > 0) {
        const refs = dbProfileCredentialRefs(dbProfileId);
        await this.ctx.credentials.set(credentialRef(refs.password), request.password);
      }
      return {
        ok: true,
        value: {
          profile: await this.dbProfilePublic(dbProfileId, record),
          credentialRefs: dbProfileCredentialRefs(dbProfileId)
        }
      };
    } catch (error) {
      return { ok: false, error: fail("db-profile-save-failed", error.message) };
    }
  }

  async dbProfileDelete(request) {
    try {
      const table = this.requireDbProfileTable();
      const record = table.get(request.dbProfileId);
      if (record === undefined) return { ok: true, value: { deleted: false } };
      const refs = dbProfileCredentialRefs(request.dbProfileId);
      await Promise.all(Object.values(refs).map(async (ref) => await this.ctx.credentials.unset(credentialRef(ref))));
      await table.delete(request.dbProfileId);
      return { ok: true, value: { deleted: true } };
    } catch (error) {
      return { ok: false, error: fail("db-profile-delete-failed", error.message) };
    }
  }

  async dbProfileConnect(request) {
    try {
      const record = this.requireDbProfileTable().get(request.dbProfileId);
      if (record === undefined) return { ok: false, error: fail("no-db-profile", `DB profile "${request.dbProfileId}" does not exist`) };
      const refs = dbProfileCredentialRefs(request.dbProfileId);
      const cred = await this.ctx.credentials.resolve(credentialRef(refs.password));
      // Resolve SSH tunnel: if sshProfileId is set, find a live SSH connection
      // for that profile, or connect it first.
      let sshConnectionId = undefined;
      if (record.sshProfileId) {
        const sshConn = [...this.connections.values()].find((c) => c.profileId === record.sshProfileId);
        if (sshConn) {
          sshConnectionId = sshConn.id;
        } else {
          // Auto-connect the SSH profile to establish the tunnel.
          const sshResult = await this.profileConnect({ profileId: record.sshProfileId });
          if (!sshResult.ok) return sshResult;
          sshConnectionId = sshResult.value.connectionId;
        }
      }
      const result = await this.dbOps.connect({
        type: record.type,
        host: record.host,
        port: record.port,
        database: record.database ?? undefined,
        username: record.username ?? undefined,
        password: cred?.value,
        ssl: record.ssl,
        sshConnectionId,
        name: record.name
      });
      if (!result.ok) return result;
      // Tag the db connection with the profile name for connected-status lookup.
      const dbRecord = this.dbOps.dbConnections.get(result.value.dbConnectionId);
      if (dbRecord) dbRecord.config.name = record.name;
      return result;
    } catch (error) {
      return { ok: false, error: fail("db-profile-connect-failed", error.message) };
    }
  }

  // ── Agent-facing helpers (called directly by tools, not over the wire) ────

  /**
   * Run one command over a dedicated exec channel on a connection. The
   * command line and its output are ALSO appended to the connection's shell
   * session buffers (if any), so the panel shows what the agent did.
   */

  /**
   * Run one command over a dedicated exec channel. No policy gate and no
   * terminal mirror: used by the batch channel, where the operator already
   * confirmed the command against a chosen server list. Returns raw output.
   */
  async execRawOnClient(client, command, timeoutMs = 30000) {
    let stdout = "";
    let stderr = "";
    let exitCode = null;
    let truncated = false;
    let timedOut = false;
    try {
      const stream = await new Promise((resolve, reject) => {
        client.exec(command, { pty: false }, (error, s) => {
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
        stream.on("close", (code) => {
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
    return { ok: true, value: { exitCode, stdout, stderr, truncated, timedOut } };
  }

  async execOnConnection(connectionId, command, timeoutMs = 30000, retried = false) {
    const decision = assessShellCommand(command);
    if (!decision.ok) return this.prefillBlockedResult(connectionId, command, decision.category ?? decision.reason);
    const conn = this.connections.get(connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${connectionId}" is down and could not be re-established`) };
    }
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
      // The transport may have died between the liveness check and the exec.
      // Wait for the self-healing reconnect and retry once transparently.
      if (!retried && conn.dead && (await this.ensureAlive(conn))) {
        return this.execOnConnection(connectionId, command, timeoutMs, true);
      }
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

  /**
   * Prefill a blocked command into the first live interactive terminal session
   * of a connection WITHOUT submitting it (no Enter). Returns whether the
   * command was actually prefilled (false when no live session is open or the
   * command contains control characters that would be unsafe to send to a PTY).
   * The operator — never the agent — is the one who presses Enter.
   */
  prefillBlockedCommand(connectionId, command, reason = "危险操作") {
    // Agent tools commonly omit connection_id to mean the selected right-side
    // server. Resolve it here so safety confirmations follow exactly the same
    // current-connection semantics as ssh_exec and the other SFTP tools.
    const effectiveConnectionId = connectionId ?? this.activeConnectionId;
    const conn = this.connections?.get(effectiveConnectionId);
    if (!conn) return { queued: false, prefilled: false };
    for (const sessionId of conn.sessions ?? []) {
      const session = this.sessions.get(sessionId);
      if (session && session.exited === null && session.stream !== null) {
        if (isPrefillable(command)) {
          // The command is queued for confirmation but NOT written to the
          // terminal input line.  This avoids the contradiction of a visible
          // command that Enter cannot submit — the only execution path is the
          // panel's Execute button, which sends the full command + Enter.
          const confirmation = {
            confirmationId: randomUUID(),
            connectionId: effectiveConnectionId,
            sessionId: session.id,
            name: conn.name,
            host: conn.host,
            command,
            reason,
            createdAt: new Date().toISOString(),
            prefilled: false
          };
          this.pendingConfirmations.set(confirmation.confirmationId, confirmation);
          this.appendTerminalNotice(session, `危险命令已被拦截并弹出确认卡片，请在右侧 SSH 面板点击“执行”或“撤销”：${command}`);
          return { queued: true, prefilled: false, confirmationId: confirmation.confirmationId };
        }
        return { queued: false, prefilled: false };
      }
    }
    return { queued: false, prefilled: false };
  }

  /**
   * Build the ssh_exec result for a blocked destructive command: prefilled into
   * the terminal when possible, otherwise a copyable command card.
   */
  prefillBlockedResult(connectionId, command, reason) {
    const pending = this.prefillBlockedCommand(connectionId, command, reason);
    const now = new Date().toISOString();
    return {
      blocked: true,
      value: {
        exitCode: null,
        stdout: "",
        stderr: "",
        commandId: "(blocked)",
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        truncated: false,
        timedOut: false,
        blocked: true,
        reason,
        command,
        prefilled: pending.prefilled,
        queued: pending.queued
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

  /**
   * Keep the local input-line mirror in sync with raw operator input written
   * directly to the PTY (the interactive browser terminal path). The agent's
   * prepareTerminalInput() gate relies on this mirror; without syncing it
   * here, a human-typed destructive line would be invisible to the gate and a
   * later agent-driven Enter could submit it. Mirrors the per-char tracking of
   * prepareTerminalInput but never blocks or rewrites — the operator is trusted
   * on this path, only the mirror is kept honest.
   */
  updateInputMirror(session, text) {
    if (typeof text !== "string") return;
    if (session.inputLine === undefined) session.inputLine = "";
    if (session.inputKnown === undefined) session.inputKnown = true;
    for (const char of text) {
      if (char === "\r" || char === "\n" || char === "\x03") {
        session.inputLine = "";
        session.inputKnown = true;
      } else if (char === "\b" || char === "\x7f") {
        if (session.inputKnown) session.inputLine = session.inputLine.slice(0, -1);
      } else if (char === "\x1b" || char === "\t") {
        session.inputKnown = false;
      } else if (char.codePointAt(0) < 32) {
        // Other control chars: leave mirror as-is.
      } else if (session.inputKnown) {
        session.inputLine += char;
        if (session.inputLine.length > 8192) session.inputKnown = false;
      }
    }
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

  // ── SFTP (file management) ─────────────────────────────────────────────────

  /** Lazily open (or reuse) the sftp subsystem of a connection. */
  async requireSftp(connection, retried = false) {
    if (connection.sftp !== null) return { ok: true, sftp: connection.sftp };
    if (!(await this.ensureAlive(connection))) {
      return { ok: false, error: fail("connection-lost", `connection "${connection.id}" is down and could not be re-established`) };
    }
    try {
      const sftp = await new Promise((resolve, reject) => {
        connection.client.sftp((error, s) => {
          if (error) reject(error);
          else resolve(s);
        });
      });
      connection.sftp = sftp;
      return { ok: true, sftp };
    } catch (error) {
      if (!retried && connection.dead && (await this.ensureAlive(connection))) {
        return this.requireSftp(connection, true);
      }
      return { ok: false, error: fail("sftp-failed", `could not open SFTP subsystem: ${error.message}`) };
    }
  }

  /** List one remote directory: entries with type, size, mtime, and mode. */
  async sftpList(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    const remotePath = request.path || ".";
    try {
      const entries = await new Promise((resolve, reject) => {
        sftp.sftp.readdir(remotePath, (error, list) => {
          if (error) reject(error);
          else resolve(list);
        });
      });
      const items = entries.map((entry) => ({
        name: entry.filename,
        isDirectory: (entry.attrs.mode & 0o170000) === 0o040000,
        size: entry.attrs.size,
        mtime: entry.attrs.mtime * 1000,
        mode: entry.attrs.mode
      }));
      return { ok: true, value: { path: remotePath, entries: items } };
    } catch (error) {
      return { ok: false, error: fail("sftp-list-failed", `${remotePath}: ${error.message}`) };
    }
  }

  /** Stat one remote path. */
  async sftpStat(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      const attrs = await new Promise((resolve, reject) => {
        sftp.sftp.stat(request.path, (error, a) => {
          if (error) reject(error);
          else resolve(a);
        });
      });
      return {
        ok: true,
        value: {
          path: request.path,
          isDirectory: (attrs.mode & 0o170000) === 0o040000,
          size: attrs.size,
          mtime: attrs.mtime * 1000,
          mode: attrs.mode
        }
      };
    } catch (error) {
      return { ok: false, error: fail("sftp-stat-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Read a remote file as base64 (bounded; large files spill a hint). */
  async sftpReadFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    const maxBytes = request.maxBytes ?? 4 * 1024 * 1024;
    const chunks = [];
    let total = 0;
    try {
      const stream = sftp.sftp.createReadStream(request.path);
      const done = new Promise((resolve, reject) => {
        stream.on("data", (chunk) => {
          total += chunk.length;
          if (total <= maxBytes) chunks.push(chunk);
        });
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      await done;
      const truncated = total > maxBytes;
      const data = Buffer.concat(chunks).toString("base64");
      return { ok: true, value: { path: request.path, data, truncated, bytes: total } };
    } catch (error) {
      return { ok: false, error: fail("sftp-read-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Write base64 content to a remote file. */
  async sftpWriteFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      const buf = Buffer.from(request.data, "base64");
      await new Promise((resolve, reject) => {
        const stream = sftp.sftp.createWriteStream(request.path);
        stream.on("close", resolve);
        stream.on("error", reject);
        stream.end(buf);
      });
      return { ok: true, value: { path: request.path, bytes: buf.length } };
    } catch (error) {
      return { ok: false, error: fail("sftp-write-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Open one non-interactive SCP channel on a live SSH connection. */
  async openScpChannel(connection, command) {
    if (!(await this.ensureAlive(connection))) {
      throw new Error(`connection "${connection.id}" is down and could not be re-established`);
    }
    return new Promise((resolve, reject) => {
      connection.client.exec(command, { pty: false }, (error, stream) => {
        if (error) reject(error);
        else {
          // SCP itself reports startup failures (not installed, exec denied)
          // on stderr rather than through the binary protocol channel.
          stream.scpStderr = "";
          stream.stderr?.on("data", (chunk) => {
            stream.scpStderr = tailCapped(stream.scpStderr + Buffer.from(chunk).toString("utf8"), MAX_COMMAND_OUTPUT_BYTES);
          });
          resolve(stream);
        }
      });
    });
  }

  /** Download one file through SCP when the SSH server has no SFTP subsystem. */
  async scpReadFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const maxBytes = request.maxBytes ?? 4 * 1024 * 1024;
    let stream;
    try {
      stream = await this.openScpChannel(selected.connection, scpCommand("f", request.path));
      const result = await scpDownload(stream, maxBytes);
      return {
        ok: true,
        value: { path: request.path, data: result.data.toString("base64"), truncated: result.truncated, bytes: result.bytes }
      };
    } catch (error) {
      return { ok: false, error: fail("scp-read-failed", `${request.path}: ${stream?.scpStderr?.trim() || error.message}`) };
    }
  }

  /** Upload one file through SCP when the SSH server has no SFTP subsystem. */
  async scpWriteFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    let stream;
    try {
      const data = Buffer.from(request.data, "base64");
      stream = await this.openScpChannel(selected.connection, scpCommand("t", request.path));
      const result = await scpUpload(stream, request.path, data);
      return { ok: true, value: { path: request.path, bytes: result.bytes } };
    } catch (error) {
      return { ok: false, error: fail("scp-write-failed", `${request.path}: ${stream?.scpStderr?.trim() || error.message}`) };
    }
  }

  /** Create a remote directory (mkdir -p semantics via mkdir + stat). */
  async sftpMkdir(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      await new Promise((resolve, reject) => {
        sftp.sftp.mkdir(request.path, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return { ok: true, value: { path: request.path } };
    } catch (error) {
      return { ok: false, error: fail("sftp-mkdir-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Delete a remote file (or empty directory). */
  async sftpDelete(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      const isDir = await new Promise((resolve, reject) => {
        sftp.sftp.stat(request.path, (error, attrs) => {
          if (error) reject(error);
          else resolve((attrs.mode & 0o170000) === 0o040000);
        });
      });
      await new Promise((resolve, reject) => {
        const fn = isDir ? sftp.sftp.rmdir : sftp.sftp.unlink;
        fn.call(sftp.sftp, request.path, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return { ok: true, value: { path: request.path, isDirectory: isDir } };
    } catch (error) {
      return { ok: false, error: fail("sftp-delete-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Rename a remote file or directory. */
  async sftpRename(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      await new Promise((resolve, reject) => {
        sftp.sftp.rename(request.from, request.to, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return { ok: true, value: { from: request.from, to: request.to } };
    } catch (error) {
      return { ok: false, error: fail("sftp-rename-failed", `${request.from} -> ${request.to}: ${error.message}`) };
    }
  }

  // ── Port forwarding (tunnels) ──────────────────────────────────────────────

  /**
   * Start a local port forward: the DSH host listens on bindAddr:bindPort and
   * forwards connections through the SSH connection to remoteHost:remotePort
   * (ssh2 Client.forwardOut semantics). Returns the assigned local endpoint.
   */
  async tunnelStartLocal(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const conn = selected.connection;
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${conn.id}" is down and could not be re-established`) };
    }
    const tunnelId = `tun-${randomUUID().slice(0, 8)}`;
    const bindAddr = request.bindAddr ?? "127.0.0.1";
    const bindPort = request.bindPort ?? 0;
    const net = await import("node:net");
    try {
      const server = net.createServer((socket) => {
        conn.client.forwardOut(bindAddr, bindPort, request.remoteHost, request.remotePort, (error, stream) => {
          if (error) {
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(bindPort, bindAddr, () => resolve());
      });
      const address = server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : bindPort;
      conn.tunnels.set(tunnelId, {
        id: tunnelId,
        kind: "local",
        bindAddr,
        bindPort: actualPort,
        remoteHost: request.remoteHost,
        remotePort: request.remotePort,
        server,
        active: true
      });
      return {
        ok: true,
        value: {
          tunnelId,
          kind: "local",
          bindAddr,
          bindPort: actualPort,
          remoteHost: request.remoteHost,
          remotePort: request.remotePort
        }
      };
    } catch (error) {
      return { ok: false, error: fail("tunnel-start-failed", `local ${bindAddr}:${bindPort} -> ${request.remoteHost}:${request.remotePort}: ${error.message}`) };
    }
  }

  /**
   * Start a remote port forward: connections to remoteHost:remotePort on the
   * server are forwarded back through the SSH connection to bindAddr:bindPort
   * on the DSH host (ssh2 Client.forwardIn). Requires the server's sshd to
   * allow remote forwards (AllowTcpForwarding); typically needs root or a
   * GatewayPorts-capable sshd.
   */
  async tunnelStartRemote(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const conn = selected.connection;
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${conn.id}" is down and could not be re-established`) };
    }
    const tunnelId = `tun-${randomUUID().slice(0, 8)}`;
    const bindAddr = request.bindAddr ?? "127.0.0.1";
    const bindPort = request.bindPort ?? 0;
    try {
      await new Promise((resolve, reject) => {
        conn.client.forwardIn(bindAddr, bindPort, (error, port) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
      // Bridge every accepted remote connection to the local target.
      const bridge = (info, accept) => {
        if (info.destIP !== bindAddr || info.destPort !== bindPort) return;
        const stream = accept();
        const socket = net.connect(request.targetPort, request.targetHost);
        socket.on("error", () => stream.destroy());
        stream.on("error", () => socket.destroy());
        stream.pipe(socket).pipe(stream);
      };
      conn.client.prependListener("tcp connection", bridge);
      const bridgeInfo = { kind: "remote", bindAddr, bindPort, bridge };
      conn.tunnels.set(tunnelId, {
        id: tunnelId,
        kind: "remote",
        bindAddr,
        bindPort,
        remoteHost: request.remoteHost,
        remotePort: request.remotePort,
        targetHost: request.targetHost,
        targetPort: request.targetPort,
        active: true,
        bridgeInfo
      });
      return {
        ok: true,
        value: {
          tunnelId,
          kind: "remote",
          bindAddr,
          bindPort,
          remoteHost: request.remoteHost,
          remotePort: request.remotePort,
          targetHost: request.targetHost,
          targetPort: request.targetPort
        }
      };
    } catch (error) {
      return { ok: false, error: fail("tunnel-start-failed", `remote ${bindAddr}:${bindPort}: ${error.message}`) };
    }
  }

  /** Stop a tunnel by id. */
  async tunnelStop(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const conn = selected.connection;
    const tunnel = conn.tunnels.get(request.tunnelId);
    if (tunnel === void 0) return { ok: false, error: fail("no-tunnel", `tunnel "${request.tunnelId}" does not exist on this connection`) };
    try {
      if (tunnel.kind === "local") {
        await new Promise((resolve) => tunnel.server.close(() => resolve()));
      } else {
        if (tunnel.bridgeInfo?.bridge) {
          conn.client.removeListener("tcp connection", tunnel.bridgeInfo.bridge);
        }
        await new Promise((resolve) => conn.client.unforwardIn(tunnel.bindAddr, tunnel.bindPort, () => resolve()));
      }
      conn.tunnels.delete(request.tunnelId);
      return { ok: true, value: { tunnelId: request.tunnelId, stopped: true } };
    } catch (error) {
      return { ok: false, error: fail("tunnel-stop-failed", error.message) };
    }
  }

  /** List tunnels on a connection. */
  async tunnelList(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const tunnels = [...selected.connection.tunnels.values()].map((t) => {
      const entry = {
        tunnelId: t.id,
        kind: t.kind,
        bindAddr: t.bindAddr,
        bindPort: t.bindPort,
        remoteHost: t.remoteHost,
        remotePort: t.remotePort,
        active: t.active
      };
      if (t.targetHost !== undefined) entry.targetHost = t.targetHost;
      if (t.targetPort !== undefined) entry.targetPort = t.targetPort;
      return entry;
    });
    return { ok: true, value: { tunnels } };
  }

  // ── SSH config import ──────────────────────────────────────────────────────

  /**
   * Parse the user's ~/.ssh/config and return host entries suitable for
   * saving as profiles. Each Host block becomes one entry with host, port,
   * user, and auth kind (key path is detected but the key content is NOT
   * read — the caller saves the path and the profile connect flow reads it
   * at connect time).
   */
  async sshConfigImport() {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const os = await import("node:os");
    const configPath = join(os.default.homedir(), ".ssh", "config");
    if (!existsSync(configPath)) {
      return { ok: false, error: fail("no-ssh-config", `~/.ssh/config not found at ${configPath}`) };
    }
    let content;
    try {
      content = readFileSync(configPath, "utf8");
    } catch (error) {
      return { ok: false, error: fail("ssh-config-read-failed", error.message) };
    }
    const hosts = [];
    let current = null;
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      const spaceIdx = line.search(/\s/);
      if (spaceIdx === -1) continue;
      const key = line.slice(0, spaceIdx).toLowerCase();
      const value = line.slice(spaceIdx + 1).trim();
      if (key === "host") {
        // Skip wildcards like Host *
        if (value.includes("*")) { current = null; continue; }
        if (current !== null) hosts.push(current);
        current = { name: value, host: value, port: 22, username: "", authKind: "key", identityFile: "", proxyJump: "" };
      } else if (current !== null) {
        if (key === "hostname") current.host = value;
        else if (key === "port") current.port = parseInt(value, 10) || 22;
        else if (key === "user") current.username = value;
        else if (key === "identityfile") current.identityFile = value.replace(/^~/, os.default.homedir());
        else if (key === "proxyjump") current.proxyJump = value;
      }
    }
    if (current !== null) hosts.push(current);
    return { ok: true, value: { hosts } };
  }

  /** Execute a command on the explicit or current SSH connection. */
  async executeCommand(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const result = await this.execOnConnection(selected.connectionId, request.command, request.timeoutMs);
    if (result.blocked) {
      return {
        ok: true,
        value: {
          connectionId: selected.connectionId,
          host: selected.connection.host,
          ...result.value,
          redacted: false
        }
      };
    }
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

  /**
   * Make sure the target connection has a live PTY session so agent input can
   * actually be submitted. With multiple open connections and no terminal open
   * on the target yet, a plain write would otherwise drop the input (0 bytes
   * written). Resolves the connection by id or the active one, then opens a
   * session lazily when none is live.
   */
  async ensureSessionForWrite(connectionId) {
    const selected = this.resolveConnection(connectionId);
    if (!selected.ok) return selected;
    const live = [...selected.connection.sessions].some((sessionId) => {
      const session = this.sessions.get(sessionId);
      return session !== void 0 && session.exited === null && session.stream !== null;
    });
    if (live) return { ok: true, connectionId: selected.connectionId };
    const opened = await this.openSession({ connectionId: selected.connectionId, cols: 100, rows: 30 });
    if (!opened.ok) return opened;
    return { ok: true, connectionId: selected.connectionId };
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
      description: "List currently open SSH connections/terminals and identify the active one. Reports connection ids together with name, host, port, username and whether a terminal session is open; it never lists saved SSH resources or credentials. Use this to discover a terminal's id when you must target a specific (non-active) terminal: pass that id as connection_id to ssh_write / ssh_exec / ssh_read / ssh_disconnect. When no connection_id is passed those tools default to the active terminal marked with '*'.",
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
          // Include the connection id so the agent can pass it back as
          // connection_id to target a specific terminal, not just the active one.
          const lines = value.connections.map((connection) => {
            const marker = connection.connectionId === value.activeConnectionId ? "* " : "- ";
            const label = connection.name || `${connection.username}@${connection.host}`;
            const sessions = connection.sessions.length ? " (terminal open)" : " (no terminal)";
            return `${marker}${label} [id: ${connection.connectionId}]: ${connection.username}@${connection.host}:${connection.port}${sessions}`;
          });
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
      description: "Run a normal SSH command on the terminal shown in the right-side SSH panel and return its output. Omit connection_id to target the current/active terminal (the default); to run on a specific other terminal, call ssh_list first and pass its id as connection_id. SSL configuration, package changes, service reloads, and config edits are allowed and remain subject to DSH permissions. Explicitly destructive or irreversible operations are not run: a confirmation popup appears in the right-side SSH panel, where only the operator can execute or cancel them. The command and output are also shown in the terminal panel.",
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
            redacted: { type: "boolean", required: true },
            blocked: { type: "boolean" },
            reason: { type: "string" },
            command: { type: "string" },
            prefilled: { type: "boolean" },
            queued: { type: "boolean" }
          }
        },
        render(args, value) {
          if (value.blocked) {
            const where = value.queued
              ? "命令未执行；右侧 SSH 终端面板已弹出确认卡片，等待操作员点击“执行”或“撤销”："
              : "命令未执行，无法预填，请粘贴到右侧终端执行：";
            return [{ type: "text", text: `⚠️ 已拦截：${value.reason ?? ""}\n${where}\n\`\`\`bash\n${value.command ?? ""}\n\`\`\`\n请勿重试/绕行，由人工确认执行。` }];
          }
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
      description: "Read buffered output from the terminal shown in the right-side SSH panel. Omit connection_id to target the current/active terminal (the default); to read a specific other terminal, call ssh_list first and pass its id as connection_id. Useful after ssh_write or when the user typed something in the panel.",
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
      description: "Send input into a right-side SSH terminal and, by default, press Enter afterwards so the input is submitted like a human typing Enter (a carriage return \\r is appended unless the input already ends with a newline). Omit connection_id to target the current/active terminal; provide connection_id to target a specific server's terminal. If the target connection has no open terminal, one is opened automatically so the input is never silently dropped. Normal operations are permitted through DSH permissions; explicitly destructive or irreversible commands are stopped before agent execution. Ctrl-C remains available to cancel an in-progress command.",
      parameters: {
        connection_id: { type: "string", description: "Optional. Omit to target the current/active terminal; specify to target that server's terminal (e.g. from ssh_connect/ssh_list)." },
        input: { type: "string", required: true, description: "The input to send, e.g. 'y' to answer a prompt, or 'ls -la' to run a command." },
        press_enter: { type: "boolean", description: "Whether to append a carriage return (Enter) after the input so the command or prompt answer is submitted. Defaults to true; set false to send raw input without submitting." }
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
        let input = typeof args.input === "string" ? args.input : String(args.input ?? "");
        // The physical Enter key emits a carriage return (\\r). Send that —
        // not a bare \\n — so the input also submits to programs that put the
        // terminal in raw mode (password prompts, [Y/n] confirmations).
        if (args.press_enter !== false && !/[\r\n]$/.test(input)) input += "\r";
        // The input must land in a live terminal session. If the target
        // connection has none open, open one first so "write + enter" actually
        // executes instead of silently writing 0 bytes.
        const ensure = await service.ensureSessionForWrite(args.connection_id);
        if (!ensure.ok) throw new Error(`ssh_write failed: ${ensure.error.message}`);
        const result = service.writeCurrentConnection({ connectionId: ensure.connectionId, input });
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

    ctx.tools.register(defineTool({
      name: "sftp_list",
      description: "List the entries of a remote directory over SFTP on a connected server (the one open in the right-side SSH terminal unless connection_id is given). Returns file/directory entries with sizes and mtimes.",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
        path: { type: "string", required: true, description: "Remote directory path, e.g. /etc or /var/log." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true },
            entries: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
              name: { type: "string", required: true },
              isDirectory: { type: "boolean", required: true },
              size: { type: "number", required: true },
              mtime: { type: "number", required: true },
              mode: { type: "number", required: true }
            } } }
          }
        },
        render(args, value) {
          if (!value.entries.length) return [{ type: "text", text: `(empty directory ${value.path})` }];
          const lines = value.entries.map((e) => `${e.isDirectory ? "d" : "-"} ${e.isDirectory ? "" : String(e.size).padStart(10)}  ${new Date(e.mtime).toISOString().slice(0, 16).replace("T", " ")}  ${e.name}`);
          return [{ type: "text", text: `Directory ${value.path} (${value.entries.length} entries):\n` + lines.join("\n") }];
        }
      },
      async execute(args) {
        const result = await service.sftpList({ connectionId: args.connection_id, path: args.path });
        if (!result.ok) throw new Error(`sftp_list failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "sftp_read",
      description: "Read a remote file's contents over SFTP (base64-decoded to text). Useful for inspecting config files, logs, or small artifacts on a connected server. Omit connection_id for the current server.",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
        path: { type: "string", required: true, description: "Remote file path." },
        max_bytes: { type: "integer", description: "Maximum bytes to read, defaults to 4 MiB." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true },
            data: { type: "string", required: true },
            truncated: { type: "boolean", required: true },
            bytes: { type: "number", required: true }
          }
        },
        render(args, value) {
          const body = value.data || "(empty file)";
          return [{ type: "text", text: value.truncated ? `${body}\n[output truncated at ${value.bytes} bytes]` : body }];
        }
      },
      async execute(args) {
        const result = await service.sftpReadFile({ connectionId: args.connection_id, path: args.path, maxBytes: args.max_bytes });
        if (!result.ok) throw new Error(`sftp_read failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "sftp_write",
      description: "Write text content to a remote file over SFTP (creates or overwrites). Omit connection_id for the current server.",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
        path: { type: "string", required: true, description: "Remote file path to write." },
        content: { type: "string", required: true, description: "File content to write." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true },
            bytes: { type: "number", required: true }
          }
        },
        render(args, value) {
          return [{ type: "text", text: `Wrote ${value.bytes} bytes to ${value.path}` }];
        }
      },
      async execute(args) {
        const result = await service.sftpWriteFile({ connectionId: args.connection_id, path: args.path, data: Buffer.from(args.content, "utf8").toString("base64") });
        if (!result.ok) throw new Error(`sftp_write failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "sftp_mkdir",
      description: "Create a remote directory over SFTP. Omit connection_id for the current server.",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
        path: { type: "string", required: true, description: "Remote directory path to create." }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { path: { type: "string", required: true } } },
        render(args, value) { return [{ type: "text", text: `Created directory ${value.path}` }]; }
      },
      async execute(args) {
        const result = await service.sftpMkdir({ connectionId: args.connection_id, path: args.path });
        if (!result.ok) throw new Error(`sftp_mkdir failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "sftp_delete",
      description: "Delete a remote file or empty directory over SFTP. Omit connection_id for the current server. Deleting is irreversible and is never executed by the agent directly: the equivalent `rm -rf <path>` triggers a confirmation popup in the right-side SSH panel (or returns a copyable command when no terminal is open) for the operator to execute or cancel.",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
        path: { type: "string", required: true, description: "Remote path to delete." }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { path: { type: "string", required: true }, isDirectory: { type: "boolean" }, blocked: { type: "boolean" }, reason: { type: "string" }, command: { type: "string" }, prefilled: { type: "boolean" }, queued: { type: "boolean" } } },
        render(args, value) {
          if (value.blocked) {
            const where = value.queued
              ? "命令未执行；右侧 SSH 终端面板已弹出确认卡片，等待操作员点击“执行”或“撤销”："
              : "命令未执行，无法预填，请粘贴到右侧终端执行：";
            return [{ type: "text", text: `⚠️ 已拦截：${value.reason ?? ""}\n${where}\n\`\`\`bash\n${value.command ?? ""}\n\`\`\`\n请勿重试/绕行，由人工确认执行。` }];
          }
          return [{ type: "text", text: `Deleted ${value.path}` }];
        }
      },
      async execute(args) {
        const command = `rm -rf ${shellQuote(args.path)}`;
        const pending = service.prefillBlockedCommand(args.connection_id, command, "删除文件或目录（SFTP）");
        return { path: args.path, blocked: true, reason: "删除文件或目录（SFTP）", command, prefilled: pending.prefilled, queued: pending.queued };
      }
    }));

    ctx.tools.register(defineTool({
      name: "sftp_rename",
      description: "Rename or move a remote file/directory over SFTP. Omit connection_id for the current server.",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
        from: { type: "string", required: true, description: "Current remote path." },
        to: { type: "string", required: true, description: "New remote path." }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { from: { type: "string", required: true }, to: { type: "string", required: true } } },
        render(args, value) { return [{ type: "text", text: `Renamed ${value.from} -> ${value.to}` }]; }
      },
      async execute(args) {
        const result = await service.sftpRename({ connectionId: args.connection_id, from: args.from, to: args.to });
        if (!result.ok) throw new Error(`sftp_rename failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "tunnel_start",
      description: "Start a port forward through a connected server. kind='local' (default): the DSH host listens on bind_addr:bind_port and forwards to remote_host:remote_port on the server — use to reach services only the server can see. kind='remote': the server listens on remote_host:remote_port and forwards back to target_host:target_port on this machine. Returns a tunnel_id for tunnel_stop.",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
        kind: { type: "string", enum: ["local", "remote"], description: "Forward direction: 'local' (default) or 'remote'." },
        bind_addr: { type: "string", description: "Local bind address (local kind), defaults to 127.0.0.1." },
        bind_port: { type: "integer", description: "Local bind port (local kind); 0 picks a free port." },
        remote_host: { type: "string", required: true, description: "The remote host to reach (local kind) or to listen on (remote kind)." },
        remote_port: { type: "integer", required: true, description: "The remote port to reach (local kind) or to listen on (remote kind)." },
        target_host: { type: "string", description: "Local target host for remote kind, defaults to 127.0.0.1." },
        target_port: { type: "integer", description: "Local target port for remote kind (required when kind='remote')." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            tunnelId: { type: "string", required: true },
            kind: { type: "string", required: true },
            bindAddr: { type: "string", required: true },
            bindPort: { type: "number", required: true },
            remoteHost: { type: "string", required: true },
            remotePort: { type: "number", required: true },
            targetHost: { type: "string" },
            targetPort: { type: "number" }
          }
        },
        render(args, value) {
          return [{ type: "text", text: value.kind === "local"
            ? `Tunnel started: ${value.bindAddr}:${value.bindPort} -> ${value.remoteHost}:${value.remotePort} (id: ${value.tunnelId})`
            : `Remote forward started: ${value.remoteHost}:${value.remotePort} -> ${value.bindAddr}:${value.bindPort} (id: ${value.tunnelId})` }];
        }
      },
      async execute(args) {
        const result = args.kind === "remote"
          ? await service.tunnelStartRemote({ connectionId: args.connection_id, bindAddr: args.bind_addr, bindPort: args.bind_port, remoteHost: args.remote_host, remotePort: args.remote_port, targetHost: args.target_host ?? "127.0.0.1", targetPort: args.target_port })
          : await service.tunnelStartLocal({ connectionId: args.connection_id, bindAddr: args.bind_addr, bindPort: args.bind_port, remoteHost: args.remote_host, remotePort: args.remote_port });
        if (!result.ok) throw new Error(`tunnel_start failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "tunnel_list",
      description: "List active port forwards on a connected server. Omit connection_id for the current server.",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            tunnels: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
              tunnelId: { type: "string", required: true },
              kind: { type: "string", required: true },
              bindAddr: { type: "string", required: true },
              bindPort: { type: "number", required: true },
              remoteHost: { type: "string" },
              remotePort: { type: "number" },
              targetHost: { type: "string" },
              targetPort: { type: "number" },
              active: { type: "boolean", required: true }
            } } }
          }
        },
        render(args, value) {
          if (!value.tunnels.length) return [{ type: "text", text: "(no active tunnels)" }];
          return [{ type: "text", text: value.tunnels.map((t) => `${t.kind}: ${t.bindAddr}:${t.bindPort} -> ${t.remoteHost}:${t.remotePort} (${t.tunnelId})`).join("\n") }];
        }
      },
      async execute(args) {
        const result = await service.tunnelList({ connectionId: args.connection_id });
        if (!result.ok) throw new Error(`tunnel_list failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "tunnel_stop",
      description: "Stop an active port forward by tunnel_id (see tunnel_list / tunnel_start).",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
        tunnel_id: { type: "string", required: true, description: "The tunnel id returned by tunnel_start." }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { tunnelId: { type: "string", required: true }, stopped: { type: "boolean", required: true } } },
        render(args, value) { return [{ type: "text", text: `Stopped tunnel ${value.tunnelId}` }]; }
      },
      async execute(args) {
        const result = await service.tunnelStop({ connectionId: args.connection_id, tunnelId: args.tunnel_id });
        if (!result.ok) throw new Error(`tunnel_stop failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "ssh_batch",
      description: "Run one command on MULTIPLE servers chosen from the SAVED server resources (not the currently connected one). The operator picks the target servers in the right-side SSH panel and confirms — this tool only creates the batch task and returns immediately; it does NOT execute. Dangerous commands are blocked from agent execution and shown for operator confirmation. Use when the user asks to run the same command on several/multiple servers.",
      parameters: {
        command: { type: "string", required: true, description: "The shell command to run on each selected server." },
        timeout_ms: { type: "integer", description: "Per-server timeout in milliseconds, defaults to 30000." }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: {
          batchId: { type: "string", required: true },
          command: { type: "string", required: true },
          dangerous: { type: "boolean", required: true },
          reason: { oneOf: [{ type: "string" }, { type: "null" }], required: true }
        } },
        render(_args, value) {
          return [{ type: "text", text: value.dangerous
            ? `已创建批量任务（危险命令，等待操作者在面板确认）：${value.command}`
            : `已创建批量任务，请在右侧 SSH 面板勾选服务器后执行：${value.command}（任务 ${value.batchId}）` }];
        }
      },
      async execute(args) {
        const result = await service.batchPlan({ command: args.command, timeoutMs: args.timeout_ms });
        if (!result.ok) throw new Error(`ssh_batch failed: ${result.error.message}`);
        return { batchId: result.value.task.batchId, command: result.value.task.command, dangerous: result.value.task.dangerous, reason: result.value.task.reason };
      }
    }));

    // ssh_cluster (run on every open connection) was removed on purpose: it
    // executed with no operator confirmation, so a casually phrased request
    // could hit every connected server at once (observed: one named server
    // requested, every open connection upgraded). Multi-server work goes
    // through ssh_batch, where the operator ticks targets in the panel.

    ctx.tools.register(defineTool({
      name: "db_connect",
      description: "Connect to a database (MySQL, PostgreSQL, Redis, or MongoDB) so the agent can query or run commands in later db_query/db_execute/db_run calls. When an SSH server is connected, a loopback host (127.0.0.1/localhost) is automatically tunneled through the current server (via_ssh=auto), so 'connect to the database on the server' works without an internal connection id; pass via_ssh='no' to force a local connection, or ssh_connection_id to pick a specific server. For cloud-managed databases requiring TLS, set ssl to 'verify' (public-CA certs) or 'preferred' (self-signed certs). Returns a db_connection_id.",
      parameters: {
        type: { type: "string", enum: ["mysql", "postgresql", "redis", "mongodb"], required: true, description: "Database type." },
        host: { type: "string", required: true, description: "Database host. When reached via SSH, this is the address as seen from the SSH server (127.0.0.1 if the DB runs on that server)." },
        port: { type: "integer", required: true, description: "Database port (e.g. 3306 MySQL, 5432 PostgreSQL, 6379 Redis, 27017 MongoDB)." },
        database: { type: "string", description: "Database/schema name (MySQL/PostgreSQL/MongoDB) or numeric DB index (Redis)." },
        username: { type: "string", description: "Database username (not needed for Redis)." },
        password: { type: "string", description: "Database password." },
        ssl: { type: "string", enum: ["disabled", "preferred", "verify"], description: "TLS mode: 'disabled' (default) plain TCP; 'preferred' encrypt without cert verification (self-signed cloud DBs); 'verify' encrypt and verify CA (public-CA cloud DBs)." },
        ssh_connection_id: { type: "string", description: "Optional. An existing SSH connection id to tunnel through, reaching databases on private networks. Takes precedence over via_ssh." },
        via_ssh: { type: "string", enum: ["auto", "yes", "no"], description: "Tunnel routing when ssh_connection_id is omitted: 'auto' (default) tunnels loopback hosts (127.0.0.1/localhost) through the current SSH server; 'yes' always tunnels through the current server; 'no' always connects directly." },
        name: { type: "string", description: "Optional display name." }
      },
      output: {
        schema: {
          type: "object", additionalProperties: false,
          properties: {
            dbConnectionId: { type: "string", required: true },
            name: { type: "string", required: true },
            type: { type: "string", required: true }
          }
        },
        render(args, value) {
          return [{ type: "text", text: `Connected ${value.type} ${args.host}:${args.port} (id: ${value.dbConnectionId})` }];
        }
      },
      async execute(args) {
        const routed = pickSshConnectionId({
          sshConnectionId: args.ssh_connection_id,
          viaSsh: args.via_ssh,
          host: args.host,
          resolveActive: () => service.resolveConnection(undefined)
        });
        if (routed.error) throw new Error(`db_connect failed: ${routed.error.message}`);
        const result = await service.dbConnect({
          type: args.type, host: args.host, port: args.port, database: args.database,
          username: args.username, password: args.password, ssl: args.ssl,
          sshConnectionId: routed.sshConnectionId, name: args.name
        });
        if (!result.ok) throw new Error(`db_connect failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_list_connections",
      description: "List currently open database connections (db_connection_id, type, host, port). Use it only when the user asks which databases are connected.",
      parameters: {},
      output: {
        schema: {
          type: "object", additionalProperties: false,
          properties: {
            connections: { type: "array", required: true, items: {
              type: "object", additionalProperties: false,
              properties: {
                dbConnectionId: { type: "string", required: true },
                name: { type: "string", required: true },
                type: { type: "string", required: true },
                host: { type: "string", required: true },
                port: { type: "integer", required: true },
                database: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
                ssl: { type: "string", required: true },
                sshConnectionId: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
                createdAt: { type: "string", required: true }
              }
            }}
          }
        },
        render(_args, value) {
          if (!value.connections.length) return [{ type: "text", text: "No database connection is currently open." }];
          return [{ type: "text", text: value.connections.map((c) => `- ${c.name} (${c.type}): ${c.host}:${c.port}${c.sshConnectionId ? " via SSH" : ""} (id: ${c.dbConnectionId})`).join("\n") }];
        }
      },
      async execute() {
        const result = await service.dbListConnections({});
        if (!result.ok) throw new Error(`db_list_connections failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_query",
      description: "Run a read-only SQL query on a connected MySQL or PostgreSQL database and return columns and rows. Read-only is LEXICALLY ENFORCED: only SELECT/SHOW/DESCRIBE/EXPLAIN/WITH(read-only) statements pass; write verbs, SELECT INTO, FOR UPDATE locking reads and data-modifying CTEs are rejected (use db_execute for writes, db_tx_* for verified change workflows). For Redis or MongoDB, use db_run instead. Results stream and are capped at 200 rows; queries time out after 30s.",
      parameters: {
        db_connection_id: { type: "string", required: true, description: "A db_connection_id from db_connect." },
        sql: { type: "string", required: true, description: "SELECT statement. MySQL uses ? placeholders, PostgreSQL uses $1 placeholders." },
        params: { type: "array", description: "Optional parameter values for placeholders." }
      },
      output: {
        schema: {
          type: "object", additionalProperties: false,
          properties: {
            columns: { type: "array", required: true, items: { type: "string" } },
            rows: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
            rowCount: { type: "integer", required: true },
            truncated: { type: "boolean", required: true }
          }
        },
        render(args, value) {
          const header = value.columns.join("\t");
          const body = value.rows.map((r) => value.columns.map((c) => r[c] ?? "").join("\t")).join("\n");
          let text = header.length > 0 ? `${header}\n${body}` : "(empty)";
          if (value.truncated) text += "\n[truncated to 200 rows]";
          return [{ type: "text", text }];
        }
      },
      async execute(args) {
        const result = await service.dbQuery({ dbConnectionId: args.db_connection_id, sql: args.sql, params: args.params });
        if (!result.ok) throw new Error(`db_query failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_execute",
      description: "Run a write SQL statement (INSERT/UPDATE/DELETE/CREATE/ALTER) on a connected MySQL or PostgreSQL database. Destructive statements (DROP/TRUNCATE/SHUTDOWN, detected by leading statement verb so keywords inside string literals or comments are not false-positives) are not executed by the agent: the SQL is returned as a copyable card to paste into the database panel's SQL editor and run manually. For Redis or MongoDB, use db_run instead.",
      parameters: {
        db_connection_id: { type: "string", required: true },
        sql: { type: "string", required: true, description: "Write statement. MySQL uses ? placeholders, PostgreSQL uses $1 placeholders." },
        params: { type: "array", description: "Optional parameter values." }
      },
      output: {
        schema: {
          type: "object", additionalProperties: false,
          properties: {
            affectedRows: { type: "integer", required: true },
            insertId: { oneOf: [{ type: "integer" }, { type: "string" }] },
            truncated: { type: "boolean", required: true },
            blocked: { type: "boolean" },
            reason: { type: "string" },
            sql: { type: "string" }
          }
        },
        render(_args, value) {
          if (value.blocked) {
            return [{ type: "text", text: `⚠️ 已拦截：${value.reason ?? ""}\nSQL 未执行，请在数据库面板 SQL 编辑器粘贴执行：\n\`\`\`sql\n${value.sql ?? ""}\n\`\`\`\n请勿重试/绕行，由人工执行。` }];
          }
          let text = `Affected ${value.affectedRows} row(s).`;
          if (value.insertId !== undefined) text += ` Insert id: ${value.insertId}.`;
          return [{ type: "text", text }];
        }
      },
      async execute(args) {
        const result = await service.dbExecute({ dbConnectionId: args.db_connection_id, sql: args.sql, params: args.params });
        if (!result.ok) {
          if (result.error.code === "unsafe-sql") {
            return { affectedRows: 0, truncated: false, blocked: true, reason: result.error.message, sql: args.sql };
          }
          throw new Error(`db_execute failed: ${result.error.message}`);
        }
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_list_tables",
      description: "List tables in the current schema of a connected MySQL or PostgreSQL database. For MongoDB, use db_run with operation 'countDocuments' on a collection instead.",
      parameters: {
        db_connection_id: { type: "string", required: true }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { tables: { type: "array", required: true, items: { type: "string" } } } },
        render(_args, value) {
          return [{ type: "text", text: value.tables.length ? value.tables.join("\n") : "(no tables)" }];
        }
      },
      async execute(args) {
        const result = await service.dbListTables({ dbConnectionId: args.db_connection_id });
        if (!result.ok) throw new Error(`db_list_tables failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_describe_table",
      description: "Full structural introspection of a table in a connected MySQL or PostgreSQL database: columns (name, type, nullable, default), indexes, foreign keys, row-count/data-size estimates from planner statistics, and the MySQL SHOW CREATE TABLE DDL.",
      parameters: {
        db_connection_id: { type: "string", required: true },
        table: { type: "string", required: true, description: "Table name." }
      },
      output: {
        schema: {
          type: "object", additionalProperties: false,
          properties: {
            table: { type: "string", required: true },
            columns: { type: "array", required: true, items: {
              type: "object", additionalProperties: false,
              properties: {
                name: { type: "string", required: true },
                type: { type: "string", required: true },
                nullable: { type: "boolean", required: true },
                key: { type: "string" },
                default: { oneOf: [{ type: "string" }, { type: "null" }, { type: "number" }] },
                extra: { oneOf: [{ type: "string" }, { type: "null" }] }
              }
            }},
            indexes: { type: "array", required: true, items: {
              type: "object", additionalProperties: false,
              properties: {
                name: { type: "string", required: true },
                unique: { type: "boolean", required: true },
                columns: { type: "array", required: true, items: { type: "string" } },
                definition: { oneOf: [{ type: "string" }, { type: "null" }], required: true }
              }
            }},
            foreignKeys: { type: "array", required: true, items: {
              type: "object", additionalProperties: false,
              properties: {
                name: { type: "string", required: true },
                column: { type: "string", required: true },
                foreignTable: { type: "string", required: true },
                foreignColumn: { type: "string", required: true }
              }
            }},
            ddl: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
            stats: {
              oneOf: [
                { type: "object", additionalProperties: false, properties: {
                  estimatedRows: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
                  dataBytes: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
                  indexBytes: { oneOf: [{ type: "integer" }, { type: "null" }], required: true }
                } },
                { type: "null" }
              ],
              required: true
            }
          }
        },
        render(args, value) {
          const lines = [`${args.table}:`];
          lines.push(value.columns.map((c) => `${c.name}\t${c.type}\t${c.nullable ? "NULL" : "NOT NULL"}${c.default !== undefined && c.default !== null ? `\tDEFAULT ${c.default}` : ""}`).join("\n"));
          if (value.indexes?.length) {
            lines.push("", "indexes:");
            for (const idx of value.indexes) {
              const cols = idx.columns?.length ? ` (${idx.columns.join(", ")})` : "";
              const def = idx.definition ? ` — ${idx.definition}` : "";
              lines.push(`  ${idx.name}${idx.unique ? " UNIQUE" : ""}${cols}${def}`);
            }
          }
          if (value.foreignKeys?.length) {
            lines.push("", "foreign keys:");
            for (const fk of value.foreignKeys) lines.push(`  ${fk.column} → ${fk.foreignTable}.${fk.foreignColumn} (${fk.name})`);
          }
          if (value.stats) {
            const bits = [];
            if (value.stats.estimatedRows != null) bits.push(`~${value.stats.estimatedRows} rows`);
            if (value.stats.dataBytes != null) bits.push(`data ${(value.stats.dataBytes / 1048576).toFixed(2)}MB`);
            if (value.stats.indexBytes != null) bits.push(`index ${(value.stats.indexBytes / 1048576).toFixed(2)}MB`);
            if (bits.length) lines.push("", `stats: ${bits.join(", ")}`);
          }
          if (value.ddl) lines.push("", "DDL:", value.ddl);
          return [{ type: "text", text: lines.join("\n") }];
        }
      },
      async execute(args) {
        const result = await service.dbDescribeTable({ dbConnectionId: args.db_connection_id, table: args.table });
        if (!result.ok) throw new Error(`db_describe_table failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_preview",
      description: "Sample rows of a table (SELECT * with LIMIT/OFFSET) on a connected MySQL or PostgreSQL database without hand-writing SQL. Returns columns, rows, and a row-count estimate from planner statistics (no full-table COUNT). The table identifier is validated against injection; limit/offset are bound as parameters.",
      parameters: {
        db_connection_id: { type: "string", required: true },
        table: { type: "string", required: true, description: "Table name, optionally schema-qualified (e.g. public.users)." },
        limit: { type: "integer", description: "Rows per page, 1-200, default 50." },
        offset: { type: "integer", description: "Rows to skip, default 0 (use for pagination)." }
      },
      output: {
        schema: {
          type: "object", additionalProperties: false,
          properties: {
            table: { type: "string", required: true },
            columns: { type: "array", required: true, items: { type: "string" } },
            rows: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
            rowCount: { type: "integer", required: true },
            truncated: { type: "boolean", required: true },
            limit: { type: "integer", required: true },
            offset: { type: "integer", required: true },
            estimatedTotal: { oneOf: [{ type: "integer" }, { type: "null" }], required: true }
          }
        },
        render(_args, value) {
          const header = value.columns.join("\t");
          const body = value.rows.map((r) => value.columns.map((c) => r[c] ?? "").join("\t")).join("\n");
          const range = value.rowCount > 0 ? `${value.offset + 1}-${value.offset + value.rowCount}` : "0";
          const est = value.estimatedTotal != null ? ` (estimate ~${value.estimatedTotal})` : "";
          let text = `${value.table} rows ${range}${est}:\n${header.length > 0 ? `${header}\n${body}` : "(empty)"}`;
          if (value.truncated) text += "\n[truncated to 200 rows]";
          return [{ type: "text", text }];
        }
      },
      async execute(args) {
        const result = await service.dbPreview({ dbConnectionId: args.db_connection_id, table: args.table, limit: args.limit, offset: args.offset });
        if (!result.ok) throw new Error(`db_preview failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_explain",
      description: "Get the execution plan of a SELECT/WITH query (MySQL EXPLAIN FORMAT=JSON / PostgreSQL EXPLAIN (FORMAT JSON)) on a connected database, e.g. to check index usage before optimizing. The statement must pass the same lexically read-only gate as db_query.",
      parameters: {
        db_connection_id: { type: "string", required: true },
        sql: { type: "string", required: true, description: "SELECT or WITH ... SELECT statement to explain." },
        params: { type: "array", description: "Optional parameter values for placeholders." }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { plan: { type: "json", required: true } } },
        render(_args, value) {
          return [{ type: "text", text: JSON.stringify(value.plan, null, 2) }];
        }
      },
      async execute(args) {
        const result = await service.dbExplain({ dbConnectionId: args.db_connection_id, sql: args.sql, params: args.params });
        if (!result.ok) throw new Error(`db_explain failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_tx_begin",
      description: "Begin an interactive transaction on a dedicated connection (MySQL/PostgreSQL) for verified change workflows: db_tx_begin → db_tx_execute (the write) → db_tx_execute (SELECT to verify) → db_tx_commit or db_tx_rollback. Idle transactions are rolled back automatically after 5 minutes.",
      parameters: {
        db_connection_id: { type: "string", required: true }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { txId: { type: "string", required: true }, dbConnectionId: { type: "string", required: true } } },
        render(_args, value) {
          return [{ type: "text", text: `Transaction ${value.txId} started on ${value.dbConnectionId}. Run db_tx_execute next; finish with db_tx_commit or db_tx_rollback.` }];
        }
      },
      async execute(args) {
        const result = await service.dbTxBegin({ dbConnectionId: args.db_connection_id });
        if (!result.ok) throw new Error(`db_tx_begin failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_tx_execute",
      description: "Run one statement inside a transaction opened with db_tx_begin. Use SELECT there to verify the effect of your write before committing. Destructive verbs (DROP/TRUNCATE/SHUTDOWN) remain blocked.",
      parameters: {
        tx_id: { type: "string", required: true },
        sql: { type: "string", required: true },
        params: { type: "array", description: "Optional parameter values for placeholders." }
      },
      output: {
        schema: {
          type: "object", additionalProperties: false,
          properties: {
            affectedRows: { type: "integer", required: true },
            rowCount: { type: "integer", required: true },
            truncated: { type: "boolean", required: true },
            rows: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
            insertId: { oneOf: [{ type: "integer" }, { type: "string" }] }
          }
        },
        render(_args, value) {
          if (value.rowCount > 0) {
            const columns = value.rows[0] ? Object.keys(value.rows[0]) : [];
            const body = value.rows.map((r) => columns.map((c) => r[c] ?? "").join("\t")).join("\n");
            const header = columns.length > 0 ? `${columns.join("\t")}\n${body}` : "(empty)";
            const suffix = value.truncated ? "\n[truncated to 200 rows]" : "";
            return [{ type: "text", text: `${header}${suffix}` }];
          }
          let text = `Affected ${value.affectedRows} row(s).`;
          if (value.insertId !== undefined) text += ` Insert id: ${value.insertId}.`;
          return [{ type: "text", text }];
        }
      },
      async execute(args) {
        const result = await service.dbTxExecute({ txId: args.tx_id, sql: args.sql, params: args.params });
        if (!result.ok) throw new Error(`db_tx_execute failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_tx_commit",
      description: "Commit a transaction opened with db_tx_begin. Call this only after db_tx_execute verification looked right.",
      parameters: { tx_id: { type: "string", required: true } },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { txId: { type: "string", required: true }, finished: { type: "boolean", required: true }, committed: { type: "boolean", required: true } } },
        render(_args, value) { return [{ type: "text", text: `Transaction ${value.txId} committed.` }]; }
      },
      async execute(args) {
        const result = await service.dbTxCommit({ txId: args.tx_id });
        if (!result.ok) throw new Error(`db_tx_commit failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_tx_rollback",
      description: "Roll back a transaction opened with db_tx_begin, undoing every statement executed in it.",
      parameters: { tx_id: { type: "string", required: true } },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { txId: { type: "string", required: true }, finished: { type: "boolean", required: true }, rolledBack: { type: "boolean", required: true } } },
        render(_args, value) { return [{ type: "text", text: `Transaction ${value.txId} rolled back.` }]; }
      },
      async execute(args) {
        const result = await service.dbTxRollback({ txId: args.tx_id });
        if (!result.ok) throw new Error(`db_tx_rollback failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_run",
      description: "Run a command on a connected Redis or MongoDB database. Redis: pass {command, args} (e.g. command='GET', args=['mykey'], or command='KEYS', args=['*']). MongoDB: pass {collection, operation} where operation is 'find'|'findOne'|'insertOne'|'updateOne'|'deleteOne'|'countDocuments', plus filter/document/update as needed. For MySQL/PostgreSQL, use db_query or db_execute instead.",
      parameters: {
        db_connection_id: { type: "string", required: true },
        command: { type: "string", description: "Redis command name (e.g. GET, SET, KEYS, HGETALL)." },
        args: { type: "array", description: "Redis command arguments (as strings)." },
        collection: { type: "string", description: "MongoDB collection name." },
        operation: { type: "string", enum: ["find", "findOne", "insertOne", "updateOne", "deleteOne", "countDocuments"], description: "MongoDB operation." },
        filter: { type: "object", additionalProperties: true, description: "MongoDB query filter (for find/findOne/updateOne/deleteOne/countDocuments)." },
        document: { type: "object", additionalProperties: true, description: "MongoDB document to insert (insertOne)." },
        update: { type: "object", additionalProperties: true, description: "MongoDB update spec (updateOne)." },
        options: { type: "object", additionalProperties: true, description: "MongoDB update options (updateOne)." }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { result: { type: "json" } } },
        render(_args, value) {
          const text = typeof value.result === "string" ? value.result : JSON.stringify(value.result, null, 2);
          return [{ type: "text", text }];
        }
      },
      async execute(args) {
        const result = await service.dbRun({
          dbConnectionId: args.db_connection_id, command: args.command, args: args.args,
          collection: args.collection, operation: args.operation, filter: args.filter,
          document: args.document, update: args.update, options: args.options
        });
        if (!result.ok) throw new Error(`db_run failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_disconnect",
      description: "Close a database connection opened with db_connect. Use it when the user is done querying a database.",
      parameters: {
        db_connection_id: { type: "string", required: true }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { dbConnectionId: { type: "string", required: true }, disconnected: { type: "boolean", required: true } } },
        render(args) { return [{ type: "text", text: `Disconnected ${args.db_connection_id}` }]; }
      },
      async execute(args) {
        const result = await service.dbDisconnect({ dbConnectionId: args.db_connection_id });
        if (!result.ok) throw new Error(`db_disconnect failed: ${result.error.message}`);
        return result.value;
      }
    }));

  }

  // ── internals ──────────────────────────────────────────────────────────────

  recordExit(session, exit) {
    if (session.exited !== null) return;
    session.exited = exit;
    this.removePendingForSession(session.id);
    // A naturally-exited shell must no longer count as an open terminal:
    // drop it from the connection's live-session set so list() reports only
    // live PTYs and the panel can offer to open a fresh one on that tab.
    if (session.connectionId !== undefined) {
      const conn = this.connections.get(session.connectionId);
      if (conn !== undefined) conn.sessions.delete(session.id);
    }
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
