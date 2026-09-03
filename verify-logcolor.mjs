// Unit test for colorizeLogKeywords using the REAL function extracted from
// src/client/SshPanel.jsx (kept in sync — the function is self-contained).
import fs from "node:fs";

const src = fs.readFileSync(new URL("./src/client/SshPanel.jsx", import.meta.url), "utf8");
const start = src.indexOf("const LOG_LEVEL_RE");
const fnStart = src.indexOf("function colorizeLogKeywords(");
let i = src.indexOf("{", fnStart);
let depth = 0;
let end = -1;
for (; i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") {
    depth--;
    if (depth === 0) { end = i + 1; break; }
  }
}
if (start < 0 || end < 0) { console.error("could not extract colorizeLogKeywords"); process.exit(2); }
const block = src.slice(start, end);
// ESM strict eval does not leak declarations; build a closure and return the fn.
const colorizeLogKeywords = new Function(`${block}\nreturn colorizeLogKeywords;`)();

const show = (s) => (typeof s === "string" ? s.replace(/\x1b\[/g, "<ESC[") : String(s));
let pass = 0;
let fail = 0;
function check(name, got, expect) {
  if (got === expect) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n    got      : ${show(got)}\n    expected : ${show(expect)}`); }
}

check("info cyan", colorizeLogKeywords("INFO: server started"), "\x1b[36mINFO\x1b[0m: server started");
check("error red", colorizeLogKeywords("2026-09-01 ERROR conn refused"), "2026-09-01 \x1b[31mERROR\x1b[0m conn refused");
check("warning yellow", colorizeLogKeywords("WARNING disk 90%"), "\x1b[33mWARNING\x1b[0m disk 90%");
check("fatal lowercase bold", colorizeLogKeywords("fatal: boom"), "\x1b[1;31mfatal\x1b[0m: boom");
check("warn abbreviation", colorizeLogKeywords("[WARN] x"), "[\x1b[33mWARN\x1b[0m] x");
check("debug gray", colorizeLogKeywords("DEBUG foo"), "\x1b[90mDEBUG\x1b[0m foo");
check("trace gray", colorizeLogKeywords("TRACE bar"), "\x1b[90mTRACE\x1b[0m bar");
check("no keyword passthrough", colorizeLogKeywords("plain output ls -la"), "plain output ls -la");
check("multiple keywords", colorizeLogKeywords("INFO a ERROR b"), "\x1b[36mINFO\x1b[0m a \x1b[31mERROR\x1b[0m b");
check("no match inside ERROR_CODE", colorizeLogKeywords("code=ERROR_CODE"), "code=ERROR_CODE");
check("no match inside word", colorizeLogKeywords("incorrect"), "incorrect");
check("only the keyword word is colored", colorizeLogKeywords("status=ERROR so check logs"), "status=\x1b[31mERROR\x1b[0m so check logs");

console.log(`\ncolorizeLogKeywords: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
