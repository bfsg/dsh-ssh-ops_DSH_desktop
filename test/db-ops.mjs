import assert from "node:assert/strict";
import { buildMysqlSsl, buildPgSsl, buildRedisSocket, buildMongoOptions } from "../src/db-ops.js";

// mysql2: undefined = 不传 ssl；preferred/verify = { rejectUnauthorized }
assert.equal(buildMysqlSsl("disabled"), undefined);
assert.equal(buildMysqlSsl(undefined), undefined);
assert.deepEqual(buildMysqlSsl("preferred"), { rejectUnauthorized: false });
assert.deepEqual(buildMysqlSsl("verify"), { rejectUnauthorized: true });

// pg: false = 不加密；对象 = 加密
assert.equal(buildPgSsl("disabled"), false);
assert.equal(buildPgSsl(undefined), false);
assert.deepEqual(buildPgSsl("preferred"), { rejectUnauthorized: false });
assert.deepEqual(buildPgSsl("verify"), { rejectUnauthorized: true });

// redis: socket 对象，tls 标志
assert.deepEqual(buildRedisSocket("disabled", "h", 6379), { host: "h", port: 6379 });
assert.deepEqual(buildRedisSocket("verify", "h", 6379), { host: "h", port: 6379, tls: true, rejectUnauthorized: true });
assert.deepEqual(buildRedisSocket("preferred", "h", 6379), { host: "h", port: 6379, tls: true, rejectUnauthorized: false });

// mongodb: tls 标志
assert.deepEqual(buildMongoOptions("disabled"), {});
assert.deepEqual(buildMongoOptions("preferred"), { tls: true, tlsAllowInvalidCertificates: true });
assert.deepEqual(buildMongoOptions("verify"), { tls: true, tlsAllowInvalidCertificates: false });

console.log("db-ops ssl mappers: all cases passed");

// ── ssh tunnel routing for db_connect (pure, unit-tested) ───────────────────

import { isLoopbackHost, pickSshConnectionId } from "../src/db-ops.js";

// 回环地址判定
assert.equal(isLoopbackHost("127.0.0.1"), true);
assert.equal(isLoopbackHost("127.8.9.10"), true);
assert.equal(isLoopbackHost("localhost"), true);
assert.equal(isLoopbackHost("::1"), true);
assert.equal(isLoopbackHost("db.example.com"), false);
assert.equal(isLoopbackHost("10.0.0.5"), false);
assert.equal(isLoopbackHost(undefined), false);

const active = { ok: true, connectionId: "conn-1", connection: {} };
const none = { ok: false, error: { code: "no-connection", message: "no active SSH connection" } };

// 显式 ssh_connection_id 永远优先
assert.deepEqual(pickSshConnectionId({ sshConnectionId: "conn-x", viaSsh: "no", host: "127.0.0.1", resolveActive: () => active }), { sshConnectionId: "conn-x" });

// via_ssh=no：强制直连，忽略活动连接
assert.deepEqual(pickSshConnectionId({ viaSsh: "no", host: "127.0.0.1", resolveActive: () => active }), { sshConnectionId: undefined });

// via_ssh=auto + 回环地址 + 有活动连接 → 自动走隧道
assert.deepEqual(pickSshConnectionId({ viaSsh: "auto", host: "127.0.0.1", resolveActive: () => active }), { sshConnectionId: "conn-1" });
assert.deepEqual(pickSshConnectionId({ viaSsh: "auto", host: "localhost", resolveActive: () => active }), { sshConnectionId: "conn-1" });

// via_ssh=auto + 非回环地址 → 直连（不劫持公网/内网 IP 的直连语义）
assert.deepEqual(pickSshConnectionId({ viaSsh: "auto", host: "db.example.com", resolveActive: () => active }), { sshConnectionId: undefined });

// via_ssh=auto + 无活动连接 → 直连（不报错，保持原行为）
assert.deepEqual(pickSshConnectionId({ viaSsh: "auto", host: "127.0.0.1", resolveActive: () => none }), { sshConnectionId: undefined });

// via_ssh=yes：强制走当前活动连接，无连接时报错
assert.deepEqual(pickSshConnectionId({ viaSsh: "yes", host: "db.example.com", resolveActive: () => active }), { sshConnectionId: "conn-1" });
assert.deepEqual(pickSshConnectionId({ viaSsh: "yes", host: "127.0.0.1", resolveActive: () => none }), { error: none.error });

// 默认 viaSsh 视为 auto
assert.deepEqual(pickSshConnectionId({ host: "127.0.0.1", resolveActive: () => active }), { sshConnectionId: "conn-1" });

console.log("db-ops ssh tunnel routing: all cases passed");

// ── DB transport-loss handling (tunneled idle connections must not crash) ────

import { EventEmitter } from "node:events";
import { DbOpsManager } from "../src/db-ops.js";

{
  const manager = Object.create(DbOpsManager.prototype);
  manager.dbConnections = new Map();
  const warns = [];
  manager.sshOpsService = { ctx: { logger: { warn: (...a) => warns.push(a) } } };

  const makeRedis = () => {
    const client = new EventEmitter();
    client.disconnectCalls = 0;
    client.disconnect = () => { client.disconnectCalls += 1; };
    return client;
  };
  const baseRecord = (over = {}) => ({
    id: "db-test", type: "redis", name: "test",
    config: { host: "127.0.0.1", port: 6379 },
    createdAt: "x", ...over
  });

  // error → record removed, tunnel closed, redis client disconnected, warn logged
  const closedServers = [];
  const redis = makeRedis();
  manager.dbConnections.set("db-test", baseRecord({ client: redis, tunnel: { server: { close: () => closedServers.push(1) } } }));
  manager.attachDbTransportHandlers(manager.dbConnections.get("db-test"));
  redis.emit("error", Object.assign(new Error("Socket closed unexpectedly"), { code: "NR-SPAWN" }));
  assert.equal(manager.dbConnections.has("db-test"), false, "dead record is removed from the map");
  assert.equal(redis.disconnectCalls, 1, "redis retry loop is stopped via disconnect()");
  assert.equal(closedServers.length, 1, "tunnel server is closed exactly once");
  assert.equal(warns.length, 1, "loss is logged");

  // second error after removal → early return, no throw, no double cleanup
  redis.emit("error", new Error("again"));
  assert.equal(closedServers.length, 1);
  assert.equal(redis.disconnectCalls, 1);
  assert.equal(warns.length, 1);

  // non-redis clients are never force-disconnected (pool owns its lifecycle)
  const pgClient = new EventEmitter();
  pgClient.disconnect = () => { throw new Error("must not be called for pg"); };
  manager.dbConnections.set("db-pg", baseRecord({ id: "db-pg", type: "postgresql", client: pgClient }));
  manager.attachDbTransportHandlers(manager.dbConnections.get("db-pg"));
  pgClient.emit("error", new Error("terminating connection"));
  assert.equal(manager.dbConnections.has("db-pg"), false);

  // explicit dbDisconnect deleted the record first → handler is a no-op
  const orphan = makeRedis();
  manager.attachDbTransportHandlers({ id: "db-orphan", client: orphan, type: "redis", config: { host: "h", port: 1 } });
  orphan.emit("error", new Error("late event after explicit disconnect"));
  assert.equal(orphan.disconnectCalls, 0, "explicit disconnect path is not double-cleaned");

  // a record without tunnel and without a client.on-capable object must not throw
  manager.attachDbTransportHandlers({ id: "db-plain", client: {}, type: "mongodb", config: { host: "h", port: 27017 } });
}

console.log("db-ops transport-loss handling: all cases passed");

// ── identifier validation + paginated preview SQL builders ───────────────────

import { validateDbIdentifier, quotePgIdentifier, buildPreviewSql } from "../src/db-ops.js";

assert.equal(validateDbIdentifier("users").ok, true);
assert.equal(validateDbIdentifier("public.users").ok, true);
assert.equal(validateDbIdentifier("_t$1").ok, true);
assert.equal(validateDbIdentifier("users; DROP TABLE x").ok, false);
assert.equal(validateDbIdentifier("users--").ok, false);
assert.equal(validateDbIdentifier("'users'").ok, false);
assert.equal(validateDbIdentifier("users UNION SELECT 1").ok, false);
assert.equal(validateDbIdentifier(123).ok, false);
assert.equal(validateDbIdentifier("a".repeat(129)).ok, false);

assert.equal(quotePgIdentifier("public.users"), '"public"."users"');
assert.equal(quotePgIdentifier('weird"name'), '"weird""name"');

const pm = buildPreviewSql("mysql", "users", 50, 0);
assert.equal(pm.ok, true);
assert.equal(pm.sql, "SELECT * FROM ?? LIMIT ? OFFSET ?");
assert.deepEqual(pm.params, ["users", 50, 0]);
const pp = buildPreviewSql("postgresql", "public.users", 50, 50);
assert.equal(pp.ok, true);
assert.equal(pp.sql, 'SELECT * FROM "public"."users" LIMIT $1 OFFSET $2');
assert.deepEqual(pp.params, [50, 50]);
assert.equal(buildPreviewSql("mysql", "t; DROP TABLE x", 50, 0).ok, false, "identifier injection is rejected before SQL is built");

console.log("db-ops identifier/preview builders: all cases passed");

// ── interactive transaction state machine (mocked mysql pool) ────────────────

{
  const manager = Object.create(DbOpsManager.prototype);
  manager.dbConnections = new Map();
  manager.dbTransactions = new Map();
  manager.sshOpsService = { ctx: { logger: { warn: () => {} } } };

  const queries = [];
  const released = [];
  const destroyed = [];
  const conn = {
    query: async (sql, params) => {
      queries.push([sql, params]);
      if (sql === "BOOM") throw new Error("boom");
      return [{ affectedRows: 2, insertId: 7 }, []];
    },
    release: () => released.push(1),
    destroy: () => destroyed.push(1)
  };
  const endCalls = [];
  manager.dbConnections.set("db-tx", {
    id: "db-tx", type: "mysql",
    client: { getConnection: async () => conn, end: async () => endCalls.push(1) }
  });

  const begun = await manager.dbTxBegin({ dbConnectionId: "db-tx" });
  assert.equal(begun.ok, true);
  assert.ok(begun.value.txId.startsWith("tx-"));
  assert.deepEqual(queries.at(-1), ["START TRANSACTION", undefined]);

  const exec = await manager.dbTxExecute({ txId: begun.value.txId, sql: "UPDATE t SET a = 1" });
  assert.equal(exec.ok, true);
  assert.equal(exec.value.affectedRows, 2);
  assert.equal(exec.value.insertId, 7);
  assert.equal(exec.value.rowCount, 0);

  const blocked = await manager.dbTxExecute({ txId: begun.value.txId, sql: "DROP TABLE t" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "unsafe-sql", "destructive verbs stay blocked inside transactions");

  const committed = await manager.dbTxCommit({ txId: begun.value.txId });
  assert.equal(committed.value.committed, true);
  assert.deepEqual(queries.at(-1), ["COMMIT", undefined]);
  assert.equal(released.length, 1, "connection is released back to the pool on commit");
  assert.equal(manager.dbTransactions.size, 0);

  const afterCommit = await manager.dbTxExecute({ txId: begun.value.txId, sql: "SELECT 1" });
  assert.equal(afterCommit.error.code, "tx-missing");

  const begun2 = await manager.dbTxBegin({ dbConnectionId: "db-tx" });
  const rolled = await manager.dbTxRollback({ txId: begun2.value.txId });
  assert.equal(rolled.value.rolledBack, true);
  assert.deepEqual(queries.at(-1), ["ROLLBACK", undefined]);

  // Explicit disconnect rolls back open transactions before ending the pool.
  const begun3 = await manager.dbTxBegin({ dbConnectionId: "db-tx" });
  assert.equal(manager.dbTransactions.size, 1);
  await manager.disconnect({ dbConnectionId: "db-tx" });
  assert.equal(manager.dbTransactions.size, 0, "disconnect disposes open transactions");
  assert.ok(queries.some(([sql]) => sql === "ROLLBACK"), "rollback ran against the live connection");
  assert.equal(endCalls.length, 1, "pool ended after rollback");
}

console.log("db-ops transaction state machine: all cases passed");
