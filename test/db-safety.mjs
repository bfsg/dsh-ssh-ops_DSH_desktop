import assert from "node:assert/strict";
import { assessSqlStatement } from "../src/db-safety.js";

// 不可恢复 / 停库语句必须拦截（大小写、空格、分号不敏感）
const blockedSql = [
  "DROP DATABASE production",
  "drop database production",
  "  DROP  DATABASE  production  ",
  "DROP SCHEMA public",
  "DROP TABLE users",
  "DROP TABLE IF EXISTS users",
  "TRUNCATE TABLE users",
  "truncate users",
  "SHUTDOWN",
  "shutdown;",
  // 多语句注入：第二条语句的 DROP / TRUNCATE 必须被拦
  "SELECT 1; DROP TABLE x",
  "-- note line\nDROP TABLE x",
  "/* c */ TRUNCATE TABLE t"
];

// 可恢复 / 正常写操作放行。高频 CRUD 里常出现含 DROP/TRUNCATE/SHUTDOWN
// 字样的字符串、注释或列名——动词识别必须不误伤这些。
const allowedSql = [
  "SELECT * FROM users",
  "SELECT 1",
  "INSERT INTO users (id) VALUES (1)",
  "UPDATE users SET name='x' WHERE id=1",
  "DELETE FROM users WHERE id=1",
  "DELETE FROM users",
  "CREATE TABLE t (id int)",
  "ALTER TABLE t ADD COLUMN c int",
  "SHOW TABLES",
  "SHOW DATABASES",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "INSERT INTO audit_log(event) VALUES ('user ran TRUNCATE TABLE orders')",
  "INSERT INTO t(msg) VALUES ('DROP TABLE secrets')",
  "SELECT 'SHUTDOWN' AS label",
  "CREATE TABLE meta(note text) /* TRUNCATE demo */",
  "SELECT note FROM truncate_log WHERE note LIKE '%DROP%'"
];

for (const sql of blockedSql) {
  const result = assessSqlStatement(sql);
  assert.equal(result.blocked, true, `expected blocked: ${sql}`);
  assert.ok(typeof result.reason === "string" && result.reason.length > 0, `expected reason for: ${sql}`);
}

for (const sql of allowedSql) {
  const result = assessSqlStatement(sql);
  assert.equal(result.blocked, false, `expected allowed: ${sql}`);
}

console.log(`db-safety: ${blockedSql.length} blocked and ${allowedSql.length} allowed cases passed`);
