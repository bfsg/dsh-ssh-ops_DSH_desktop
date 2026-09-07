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
console.log("reconnect.mjs OK");
