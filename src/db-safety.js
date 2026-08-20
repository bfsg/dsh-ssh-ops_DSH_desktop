/**
 * SQL safety assessment for db_execute. Database CRUD is far more frequent than
 * host-shell ops, so detection is statement-verb based rather than a substring
 * scan: keywords that merely appear inside string literals, comments, or
 * column names must NOT trip the guard (otherwise a logging INSERT that quotes
 * the word "TRUNCATE" would be falsely blocked). Destructive leading verbs are
 * DROP / TRUNCATE / SHUTDOWN, detected per statement across multi-statement
 * input so `SELECT 1; DROP TABLE x` is still caught. Recoverable writes
 * (INSERT/UPDATE/DELETE/CREATE/ALTER) are allowed; DELETE without WHERE remains
 * permitted because it is transactional and a common legitimate bulk operation.
 */

const DESTRUCTIVE_VERBS = new Set(["DROP", "TRUNCATE", "SHUTDOWN"]);

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/**
 * Walk the SQL text and return the leading verb (uppercased) of every
 * top-level statement, skipping over string/identifier literals and comments
 * so keywords inside them never register as statement verbs.
 */
function statementVerbs(sql) {
  const verbs = [];
  const n = sql.length;
  let i = 0;
  let wantVerb = true;
  while (i < n) {
    const ch = sql[i];
    if (WHITESPACE.has(ch)) { i++; continue; }
    // Line comments: -- and # (MySQL). /* */ block comments.
    if ((ch === "-" && sql[i + 1] === "-") || ch === "#") {
      i += ch === "#" ? 1 : 2;
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // String and identifier quotes: ' " `
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < n) {
        const c = sql[i];
        if (c === "\\") { i += 2; continue; }
        if (c === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; } // doubled quote escape
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (ch === ";") { wantVerb = true; i++; continue; }
    if (wantVerb && IDENT_START.test(ch)) {
      let j = i;
      while (j < n && IDENT_PART.test(sql[j])) j++;
      verbs.push(sql.slice(i, j).toUpperCase());
      wantVerb = false;
      i = j;
      continue;
    }
    // Digits, operators, '(' etc.: no leading verb for this statement.
    wantVerb = false;
    i++;
  }
  return verbs;
}

/**
 * @param {string} sql
 * @returns {{ blocked: boolean, reason?: string, verb?: string }}
 */
export function assessSqlStatement(sql) {
  if (typeof sql !== "string" || sql.trim() === "") return { blocked: false };
  for (const verb of statementVerbs(sql)) {
    if (DESTRUCTIVE_VERBS.has(verb)) {
      return { blocked: true, reason: `${verb} 不可恢复或会停库`, verb };
    }
  }
  return { blocked: false };
}
