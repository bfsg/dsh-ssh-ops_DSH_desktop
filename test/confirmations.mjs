import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import SshOpsService from "../src/index.js";

// Build a minimal service with no cordis/storage dependencies.
function makeService() {
  const service = Object.create(SshOpsService.prototype);
  service.config = { maxBufferBytes: 4096, maxCaptureBytes: 4096, maxCommandOutputBytes: 4096 };
  service.wakeWaiters = () => {};
  service.pendingConfirmations = new Map();
  service.confirmationHistory = [];
  service.connections = new Map();
  service.sessions = new Map();
  service.activeConnectionId = null;
  return service;
}

function mockExecChannel(exitCode, { stdout = "", stderr = "" } = {}) {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.close = () => stream.emit("close", exitCode);
  // Emit on a macrotask so execRawOnClient has already attached its listeners
  // (the channel is created synchronously before the await continuation runs).
  setTimeout(() => {
    if (stdout) stream.emit("data", Buffer.from(stdout, "utf8"));
    if (stderr) stream.stderr.emit("data", Buffer.from(stderr, "utf8"));
    stream.emit("close", exitCode);
  }, 0);
  return stream;
}

function mockConnection(client = null) {
  return {
    id: "conn-1",
    host: "192.0.2.10",
    port: 22,
    username: "root",
    name: "web-1",
    dead: false,
    closing: false,
    sessions: new Set(),
    client
  };
}

// ── A blocked ssh_exec without any open terminal still queues a card ────────
{
  const service = makeService();
  service.connections.set("conn-1", mockConnection(null));
  const result = await service.execOnConnection("conn-1", "rm -rf /tmp/x");
  assert.equal(result.blocked, true);
  assert.equal(result.value.queued, true, "blocked command must be queued even with no terminal");
  assert.equal(result.value.mode, "exec", "no terminal → exec mode");
  assert.equal(result.value.prefilled, false);
  assert.equal(service.pendingConfirmations.size, 1);

  const list = service.pendingConfirmationList().value.confirmations;
  assert.equal(list.length, 1);
  assert.equal(list[0].sessionId, "", "wire view uses empty sessionId when no terminal is attached");
  assert.equal(list[0].command, "rm -rf /tmp/x");
}

// ── A non-prefillable (control-char) command is still queued in exec mode ───
{
  const service = makeService();
  const conn = mockConnection(null);
  conn.sessions = new Set(["s1"]);
  service.connections.set("conn-1", conn);
  service.sessions.set("s1", {
    id: "s1",
    exited: null,
    stream: { write() { throw new Error("must not write control chars to PTY"); } },
    inputLine: "",
    inputKnown: true,
    buffer: "",
    captureBuffer: "",
    lastPrompt: null
  });
  const result = await service.execOnConnection("conn-1", "rm -rf\t/tmp/y");
  assert.equal(result.blocked, true);
  assert.equal(result.value.queued, true, "control-char command must still queue a confirmation");
  assert.equal(result.value.mode, "exec", "control chars cannot be typed into a PTY");
  assert.equal(service.pendingConfirmationList().value.confirmations.length, 1);
}

// ── Exec-mode approval runs the command and records its outcome ─────────────
{
  const service = makeService();
  const execCalls = [];
  const client = {
    exec(command, options, cb) {
      execCalls.push({ command, options });
      cb(null, mockExecChannel(0, { stdout: "deleted 3 files\n" }));
    }
  };
  service.connections.set("conn-1", mockConnection(client));
  await service.execOnConnection("conn-1", "rm -rf /tmp/x");
  const pending = service.pendingConfirmationList().value.confirmations[0];

  const approved = await service.pendingConfirmationApprove({ confirmationId: pending.confirmationId });
  assert.equal(approved.ok, true);
  assert.equal(approved.value.executed, true);
  assert.equal(approved.value.exitCode, 0);
  assert.match(approved.value.stdout, /deleted 3 files/);
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].command, "rm -rf /tmp/x");

  assert.equal(service.pendingConfirmations.size, 0);
  const status = service.confirmationStatus();
  assert.equal(status.pending.length, 0);
  assert.equal(status.resolved.length, 1);
  assert.equal(status.resolved[0].status, "executed");
  assert.equal(status.resolved[0].exitCode, 0);
  assert.match(status.resolved[0].stdout, /deleted 3 files/);
}

// ── Exec-mode failure is recorded, not silently lost ────────────────────────
{
  const service = makeService();
  const client = {
    exec(command, options, cb) {
      cb(new Error("exec channel refused"));
    }
  };
  service.connections.set("conn-1", mockConnection(client));
  await service.execOnConnection("conn-1", "rm -rf /tmp/x");
  const pending = service.pendingConfirmationList().value.confirmations[0];
  const approved = await service.pendingConfirmationApprove({ confirmationId: pending.confirmationId });
  assert.equal(approved.ok, false);
  const status = service.confirmationStatus();
  assert.equal(status.resolved[0].status, "failed");
  assert.match(status.resolved[0].error, /exec channel refused/);
}

// ── Cancel records a cancelled outcome ──────────────────────────────────────
{
  const service = makeService();
  const conn = mockConnection(null);
  conn.sessions = new Set(["s1"]);
  service.connections.set("conn-1", conn);
  const writes = [];
  service.sessions.set("s1", {
    id: "s1",
    exited: null,
    stream: { write(v) { writes.push(v); } },
    inputLine: "",
    inputKnown: true,
    buffer: "",
    captureBuffer: "",
    lastPrompt: null
  });
  await service.execOnConnection("conn-1", "rm -rf /tmp/cancel");
  const pending = service.pendingConfirmationList().value.confirmations[0];
  assert.equal((await service.pendingConfirmationCancel({ confirmationId: pending.confirmationId })).value.cancelled, true);
  const status = service.confirmationStatus();
  assert.equal(status.pending.length, 0);
  assert.equal(status.resolved[0].status, "cancelled");
}

// ── ssh_write blocked line queues a confirmation id in the error message ────
{
  const service = makeService();
  const conn = mockConnection(null);
  conn.sessions = new Set(["s1"]);
  service.connections.set("conn-1", conn);
  const writes = [];
  service.sessions.set("s1", {
    id: "s1",
    exited: null,
    stream: { write(v) { writes.push(v); } },
    inputLine: "",
    inputKnown: true,
    buffer: "",
    captureBuffer: "",
    lastPrompt: null
  });
  const result = service.writeToConnection("conn-1", "rm -rf /tmp/w\r");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unsafe-command");
  assert.match(result.error.message, /确认卡片 .*已在右侧 SSH 面板弹出/);
  const list = service.pendingConfirmationList().value.confirmations;
  assert.equal(list.length, 1);
  assert.equal(list[0].command, "rm -rf /tmp/w");
  assert.equal(list[0].sessionId, "s1");
}

console.log("confirmation flow: all cases passed");
