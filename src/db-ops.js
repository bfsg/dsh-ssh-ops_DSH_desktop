/**
 * DbOpsManager: in-memory database connection manager for the sshOps service.
 * Supports MySQL, PostgreSQL, Redis, MongoDB. Optional SSH tunnel reuses an
 * existing ssh2 connection (forwardOut + net.createServer) so agents can reach
 * databases on private networks. High-risk SQL (DROP DATABASE/SCHEMA/TABLE,
 * TRUNCATE, SHUTDOWN) is blocked on db_execute via db-safety.js.
 */
import net from "node:net";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise.js";
import pg from "pg";
import { createClient as createRedisClient } from "redis";
import { MongoClient } from "mongodb";
import { assessSqlStatement } from "./db-safety.js";

const MAX_DB_ROWS = 200;

// ── SSL option mappers (pure, unit-tested) ──────────────────────────────────

/** mysql2: undefined omits ssl; preferred/verify set rejectUnauthorized. */
export function buildMysqlSsl(ssl) {
  if (!ssl || ssl === "disabled") return undefined;
  return { rejectUnauthorized: ssl === "verify" };
}

/** pg: false disables ssl; object enables it. */
export function buildPgSsl(ssl) {
  if (!ssl || ssl === "disabled") return false;
  return { rejectUnauthorized: ssl === "verify" };
}

/** redis v4: socket options with tls flag. */
export function buildRedisSocket(ssl, host, port) {
  const socket = { host, port };
  if (ssl && ssl !== "disabled") {
    socket.tls = true;
    socket.rejectUnauthorized = ssl === "verify";
  }
  return socket;
}

/** mongodb: tls flags. preferred allows self-signed certs. */
export function buildMongoOptions(ssl) {
  if (!ssl || ssl === "disabled") return {};
  return { tls: true, tlsAllowInvalidCertificates: ssl === "preferred" };
}

// ── SSH tunnel routing for db_connect (pure, unit-tested) ──────────────────

const LOOPBACK_RE = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|::1)$/i;

/** True when host is a loopback address, i.e. "this machine" from the caller. */
export function isLoopbackHost(host) {
  return LOOPBACK_RE.test(String(host ?? ""));
}

/**
 * Decide which SSH connection (if any) a db_connect request should tunnel
 * through, so the agent can reach databases on the already-connected server
 * without knowing its internal connection id.
 *
 * - explicit sshConnectionId always wins;
 * - viaSsh "no" forces a direct connection;
 * - viaSsh "yes" forces the current active SSH connection (errors if none);
 * - viaSsh "auto" (default) tunnels only loopback hosts through the active
 *   connection, leaving public/private addresses as direct connections.
 */
export function pickSshConnectionId({ sshConnectionId, viaSsh, host, resolveActive }) {
  if (sshConnectionId !== undefined) return { sshConnectionId };
  const mode = viaSsh ?? "auto";
  if (mode === "no") return { sshConnectionId: undefined };
  const resolved = resolveActive();
  if (!resolved.ok) {
    if (mode === "yes") return { error: resolved.error };
    return { sshConnectionId: undefined };
  }
  if (mode === "yes" || isLoopbackHost(host)) {
    return { sshConnectionId: resolved.connectionId };
  }
  return { sshConnectionId: undefined };
}

// ── value serialization (MongoDB ObjectId/Decimal/Date, Buffer, bigint) ─────

function serializeDbValue(value) {
  return JSON.parse(JSON.stringify(value, (_key, val) => {
    if (val === undefined) return null;
    if (typeof val === "bigint") return val.toString();
    if (Buffer.isBuffer(val)) return val.toString("utf8");
    if (val && typeof val === "object") {
      if (typeof val.toISOString === "function" && val instanceof Date) return val.toISOString();
      if (typeof val.toHexString === "function") return val.toHexString();
      if (typeof val.toString === "function" && val.constructor?.name === "Decimal128") return val.toString();
    }
    return val;
  }));
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

// ── DbOpsManager ────────────────────────────────────────────────────────────

export class DbOpsManager {
  /** @param {import("./index.js").default} sshOpsService */
  constructor(sshOpsService) {
    this.sshOpsService = sshOpsService;
    this.dbConnections = new Map();
  }

  /**
   * Open a local TCP listener that forwards each accepted socket through an
   * existing ssh2 connection to dbHost:dbPort. Returns { server, port }.
   */
  async createTunnel(sshConnectionId, dbHost, dbPort) {
    const conn = this.sshOpsService.connections.get(sshConnectionId);
    if (!conn) throw new Error(`SSH connection ${sshConnectionId} not found`);
    if (conn.dead) throw new Error(`SSH connection ${sshConnectionId} is dead`);
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        conn.client.forwardOut("127.0.0.1", 0, dbHost, dbPort, (error, stream) => {
          if (error) { socket.destroy(); return; }
          stream.on("error", () => socket.destroy());
          socket.on("error", () => stream.destroy());
          socket.pipe(stream);
          stream.pipe(socket);
        });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const { port } = server.address();
        resolve({ server, port });
      });
    });
  }

  async connect(request) {
    const { type, host, port, database, username, password, ssl, sshConnectionId, name } = request;
    let tunnel = null;
    let connectHost = host;
    let connectPort = port;

    if (sshConnectionId) {
      try {
        tunnel = await this.createTunnel(sshConnectionId, host, port);
        connectHost = "127.0.0.1";
        connectPort = tunnel.port;
      } catch (error) {
        return fail("db-tunnel-failed", `SSH tunnel to ${host}:${port} via ${sshConnectionId}: ${error.message}`);
      }
    }

    const id = `db-${randomUUID().slice(0, 8)}`;
    let client;
    try {
      if (type === "mysql") {
        client = mysql.createPool({
          host: connectHost, port: connectPort, user: username, password, database,
          ssl: buildMysqlSsl(ssl), connectionLimit: 4, supportBigNumbers: true
        });
        const c = await client.getConnection();
        c.release();
      } else if (type === "postgresql") {
        client = new pg.Pool({
          host: connectHost, port: connectPort, user: username, password, database,
          ssl: buildPgSsl(ssl), max: 4
        });
        const c = await client.connect();
        c.release();
      } else if (type === "redis") {
        client = createRedisClient({
          socket: buildRedisSocket(ssl, connectHost, connectPort),
          password,
          database: database ? Number(database) : undefined
        });
        await client.connect();
      } else if (type === "mongodb") {
        const cred = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password ?? "")}@` : "";
        const uri = `mongodb://${cred}${connectHost}:${connectPort}/${database ?? ""}`;
        client = new MongoClient(uri, buildMongoOptions(ssl));
        await client.connect();
      } else {
        throw new Error(`unsupported database type: ${type}`);
      }
    } catch (error) {
      if (tunnel) { try { tunnel.server.close(); } catch {} }
      const target = tunnel ? `${connectHost}:${connectPort} (tunneled to ${host}:${port})` : `${connectHost}:${connectPort}`;
      return fail("db-connect-failed", `${type} connect to ${target}: ${error.message}`);
    }

    const record = {
      id, type, name: name ?? `${type}:${host}:${port}`,
      config: { host, port, database, username, ssl: ssl ?? "disabled", sshConnectionId: sshConnectionId ?? null },
      client, tunnel, createdAt: new Date().toISOString()
    };
    this.dbConnections.set(id, record);
    return { ok: true, value: { dbConnectionId: id, name: record.name, type } };
  }

  getRecord(dbConnectionId) {
    const record = this.dbConnections.get(dbConnectionId);
    if (!record) throw new Error(`database connection ${dbConnectionId} not found`);
    return record;
  }

  async disconnect(request) {
    const record = this.dbConnections.get(request.dbConnectionId);
    if (!record) return fail("no-db-connection", `database connection ${request.dbConnectionId} not found`);
    this.dbConnections.delete(request.dbConnectionId);
    try {
      if (record.type === "mysql" || record.type === "postgresql") await record.client.end();
      else if (record.type === "redis") await record.client.quit();
      else if (record.type === "mongodb") await record.client.close();
    } catch {}
    if (record.tunnel) { try { record.tunnel.server.close(); } catch {} }
    return { ok: true, value: { dbConnectionId: request.dbConnectionId, disconnected: true } };
  }

  /** Close every database connection (called from sshOps cleanup/disconnect). */
  async closeAll() {
    const ids = [...this.dbConnections.keys()];
    for (const id of ids) {
      await this.disconnect({ dbConnectionId: id }).catch(() => {});
    }
  }

  list() {
    const connections = [...this.dbConnections.values()].map((r) => ({
      dbConnectionId: r.id, name: r.name, type: r.type,
      host: r.config.host, port: r.config.port,
      database: r.config.database ?? null,
      ssl: r.config.ssl, sshConnectionId: r.config.sshConnectionId ?? null,
      createdAt: r.createdAt
    }));
    return { ok: true, value: { connections } };
  }

  async query(request) {
    let record;
    try { record = this.getRecord(request.dbConnectionId); }
    catch (error) { return fail("no-db-connection", error.message); }
    if (record.type !== "mysql" && record.type !== "postgresql") {
      return fail("unsupported-op", `db_query only supports mysql/postgresql, use db_run for ${record.type}`);
    }
    try {
      let rows, fieldNames;
      if (record.type === "mysql") {
        const [r, fields] = await record.client.query(request.sql, request.params ?? []);
        rows = Array.isArray(r) ? r : [r];
        fieldNames = (fields ?? []).map((f) => f.name);
      } else {
        const r = await record.client.query(request.sql, request.params ?? []);
        rows = r.rows ?? [];
        fieldNames = (r.fields ?? []).map((f) => f.name);
      }
      const columns = fieldNames.length > 0 ? fieldNames : (rows[0] ? Object.keys(rows[0]) : []);
      const truncated = rows.length > MAX_DB_ROWS;
      if (truncated) rows = rows.slice(0, MAX_DB_ROWS);
      return { ok: true, value: { columns, rows: rows.map(serializeDbValue), rowCount: rows.length, truncated } };
    } catch (error) {
      return fail("db-query-failed", error.message);
    }
  }

  async execute(request) {
    let record;
    try { record = this.getRecord(request.dbConnectionId); }
    catch (error) { return fail("no-db-connection", error.message); }
    const assessment = assessSqlStatement(request.sql);
    if (assessment.blocked) return fail("unsafe-sql", assessment.reason);
    if (record.type !== "mysql" && record.type !== "postgresql") {
      return fail("unsupported-op", `db_execute only supports mysql/postgresql, use db_run for ${record.type}`);
    }
    try {
      let affectedRows, insertId;
      if (record.type === "mysql") {
        const [r] = await record.client.query(request.sql, request.params ?? []);
        if (Array.isArray(r)) {
          affectedRows = r.length;
        } else {
          affectedRows = r.affectedRows ?? 0;
          if (r.insertId) insertId = r.insertId;
        }
      } else {
        const r = await record.client.query(request.sql, request.params ?? []);
        affectedRows = r.rowCount ?? r.rows?.length ?? 0;
      }
      const value = { affectedRows, truncated: false };
      if (insertId !== undefined) value.insertId = insertId;
      return { ok: true, value };
    } catch (error) {
      return fail("db-execute-failed", error.message);
    }
  }

  async listTables(request) {
    let record;
    try { record = this.getRecord(request.dbConnectionId); }
    catch (error) { return fail("no-db-connection", error.message); }
    if (record.type !== "mysql" && record.type !== "postgresql") {
      return fail("unsupported-op", `db_list_tables only supports mysql/postgresql, use db_run for ${record.type}`);
    }
    try {
      let rows;
      if (record.type === "mysql") {
        const [r] = await record.client.query("SHOW TABLES");
        rows = r;
      } else {
        const r = await record.client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name");
        rows = r.rows;
      }
      const tables = rows.map((row) => Object.values(row)[0]);
      return { ok: true, value: { tables } };
    } catch (error) {
      return fail("db-list-tables-failed", error.message);
    }
  }

  async describeTable(request) {
    let record;
    try { record = this.getRecord(request.dbConnectionId); }
    catch (error) { return fail("no-db-connection", error.message); }
    if (record.type !== "mysql" && record.type !== "postgresql") {
      return fail("unsupported-op", `db_describe_table only supports mysql/postgresql, use db_run for ${record.type}`);
    }
    try {
      let columns;
      if (record.type === "mysql") {
        const [r] = await record.client.query("SHOW COLUMNS FROM ??", [request.table]);
        columns = r.map((c) => ({
          name: c.Field, type: c.Type, nullable: c.Null === "YES",
          key: c.Key, default: c.Default, extra: c.Extra
        }));
      } else {
        const r = await record.client.query(
          "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 AND table_schema = current_schema() ORDER BY ordinal_position",
          [request.table]
        );
        columns = r.rows.map((c) => ({
          name: c.column_name, type: c.data_type, nullable: c.is_nullable === "YES",
          default: c.column_default, extra: null
        }));
      }
      return { ok: true, value: { table: request.table, columns } };
    } catch (error) {
      return fail("db-describe-failed", error.message);
    }
  }

  async run(request) {
    let record;
    try { record = this.getRecord(request.dbConnectionId); }
    catch (error) { return fail("no-db-connection", error.message); }
    try {
      if (record.type === "redis") {
        const { command, args } = request;
        if (!command) return fail("bad-request", "redis run requires { command, args }");
        const result = await record.client.sendCommand([command, ...(args ?? [])]);
        return { ok: true, value: { result: serializeDbValue(result) } };
      }
      if (record.type === "mongodb") {
        const { collection, operation, filter, document, update, options } = request;
        if (!collection || !operation) return fail("bad-request", "mongodb run requires { collection, operation }");
        const col = record.client.db(record.config.database).collection(collection);
        let result;
        switch (operation) {
          case "find": result = await col.find(filter ?? {}).limit(100).toArray(); break;
          case "findOne": result = await col.findOne(filter ?? {}); break;
          case "insertOne": result = await col.insertOne(document); break;
          case "updateOne": result = await col.updateOne(filter ?? {}, update, options); break;
          case "deleteOne": result = await col.deleteOne(filter ?? {}); break;
          case "countDocuments": result = await col.countDocuments(filter ?? {}); break;
          default: throw new Error(`unsupported mongo operation: ${operation}`);
        }
        return { ok: true, value: { result: serializeDbValue(result) } };
      }
      return fail("unsupported-op", `db_run only supports redis/mongodb, use db_query for ${record.type}`);
    } catch (error) {
      return fail("db-run-failed", error.message);
    }
  }
}
