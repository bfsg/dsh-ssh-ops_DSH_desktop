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
