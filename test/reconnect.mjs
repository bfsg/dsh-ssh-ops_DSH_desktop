import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";

const service = Object.create(SshOpsService.prototype);
service.connections = new Map();

// Unknown connection id → no-connection, and no transport work happens.
{
  const result = await service.reconnect({ connectionId: "nope" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "no-connection");
}

// A closing record is refused without touching its client (no ssh attempt).
{
  const client = { endCalls: 0, end() { this.endCalls += 1; } };
  service.connections.set("c1", { id: "c1", closing: true, client });
  const result = await service.reconnect({ connectionId: "c1" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "connect-cancelled");
  assert.equal(client.endCalls, 0, "closing record must not be torn down");
}

// ── Fix-round coverage (retriable scheduling, in-flight guard, waiters) ─────

function makeRecord(id) {
  return {
    id,
    closing: false,
    reconnectTimer: null,
    reconnectBusy: undefined,
    dead: true,
    sftp: null,
    sessions: new Map(),
    tunnels: new Map(),
    hops: [],
    client: null,
    reconnectWaiters: [],
    connectConfig: {},
    host: `host-${id}`,
    port: 22,
    username: `user-${id}`
  };
}

function makeService() {
  const svc = Object.create(SshOpsService.prototype);
  svc.connections = new Map();
  svc.sessions = new Map();
  svc.scheduleCalls = 0;
  svc.scheduleReconnect = () => { svc.scheduleCalls += 1; };
  svc.attachTransportHandlers = () => {};
  return svc;
}

// Non-retriable failure (permission denied) → no auto-reconnect scheduling.
{
  const svc = makeService();
  const record = makeRecord("c2");
  svc.connections.set(record.id, record);
  svc.connectClient = async () => ({ ok: false, error: { code: "connect-failed", message: "Permission denied (publickey)." } });
  const result = await svc.reconnect({ connectionId: record.id });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "connect-failed");
  assert.equal(svc.scheduleCalls, 0, "non-retriable failure must not schedule auto-reconnect");
  assert.equal(record.reconnectTimer, null, "no timer may be armed for non-retriable failure");
  assert.equal(record.reconnectBusy, false, "busy marker must clear after a non-retriable failure");
}

// Retriable failure (socket timed out) → auto-reconnect scheduled exactly once.
{
  const svc = makeService();
  const record = makeRecord("c3");
  svc.connections.set(record.id, record);
  svc.connectClient = async () => ({ ok: false, error: { code: "connect-failed", message: "socket timed out" } });
  const result = await svc.reconnect({ connectionId: record.id });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "connect-failed");
  assert.equal(svc.scheduleCalls, 1, "retriable failure must schedule auto-reconnect exactly once");
  assert.equal(record.reconnectBusy, false, "busy marker must clear after a retriable failure");
}

// In-flight guard: a second manual reconnect while one is pending is refused.
{
  const svc = makeService();
  const record = makeRecord("c4");
  svc.connections.set(record.id, record);
  let release;
  svc.connectClient = () => new Promise((resolve) => { release = resolve; });
  const first = svc.reconnect({ connectionId: record.id });
  const second = await svc.reconnect({ connectionId: record.id });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, "reconnect-in-progress");
  assert.equal(record.reconnectBusy, true, "the first reconnect must still own the record");
  release({ ok: true });
  const firstResult = await first;
  assert.equal(firstResult.ok, true, "the first reconnect must complete after the stub resolves");
  assert.equal(record.reconnectBusy, false, "busy marker must clear once the first reconnect finishes");
}

// Success path resolves registered reconnect waiters (ensureAlive handoff).
{
  const svc = makeService();
  const record = makeRecord("c5");
  svc.connections.set(record.id, record);
  let waiterCalls = 0;
  record.reconnectWaiters.push(() => { waiterCalls += 1; });
  svc.connectClient = async (rec) => {
    rec.client = {};
    rec.dead = false;
    return { ok: true };
  };
  const result = await svc.reconnect({ connectionId: record.id });
  assert.equal(result.ok, true);
  assert.equal(result.value.connectionId, record.id);
  assert.equal(waiterCalls, 1, "successful reconnect must resolve registered waiters");
  assert.equal(record.reconnectWaiters.length, 0, "waiters list must be drained after success");
  assert.equal(record.reconnectBusy, false);
}

// Closing flipped while reconnecting → connect-cancelled, no handlers attached.
{
  const svc = makeService();
  const record = makeRecord("c6");
  svc.connections.set(record.id, record);
  let release;
  svc.connectClient = () => new Promise((resolve) => { release = resolve; });
  const pending = svc.reconnect({ connectionId: record.id });
  record.closing = true;
  release({ ok: true });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "connect-cancelled");
  assert.equal(record.reconnectBusy, false, "busy marker must clear when the reconnect is cancelled");
}

console.log("reconnect.mjs OK");
