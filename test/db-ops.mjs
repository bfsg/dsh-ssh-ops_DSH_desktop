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
