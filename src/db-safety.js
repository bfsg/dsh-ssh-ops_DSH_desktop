/**
 * SQL safety assessment for db_execute: blocks statements that are not
 * recoverable (DROP DATABASE/SCHEMA/TABLE, TRUNCATE) or that stop the server
 * (SHUTDOWN). Recoverable writes (INSERT/UPDATE/DELETE/CREATE/ALTER) are
 * allowed; DELETE without WHERE is permitted because it is transactional and
 * a common legitimate bulk operation.
 */

const BLOCK_RULES = [
  { pattern: /\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b/, reason: "DROP DATABASE/SCHEMA/TABLE 不可恢复，已拦截" },
  { pattern: /\bTRUNCATE\b/, reason: "TRUNCATE 不可恢复，已拦截" },
  { pattern: /\bSHUTDOWN\b/, reason: "SHUTDOWN 会停止数据库服务，已拦截" }
];

/**
 * @param {string} sql
 * @returns {{ blocked: boolean, reason?: string }}
 */
export function assessSqlStatement(sql) {
  const normalized = String(sql ?? "").trim().toUpperCase();
  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(normalized)) {
      return { blocked: true, reason: rule.reason };
    }
  }
  return { blocked: false };
}
