import assert from "node:assert/strict";
import { assessShellCommand } from "../src/safety.js";
import { redactForModel } from "../src/redact.js";
import SshOpsService, { normalizeTerminalEol } from "../src/index.js";

const safeCommands = [
  "free -h",
  "df -h /",
  "ps aux | grep nginx",
  "systemctl status nginx",
  "mysql -e 'SHOW DATABASES'",
  "psql -c 'SELECT now()'",
  "certbot --nginx -d example.com",
  "systemctl reload nginx",
  "apt-get install -y certbot",
  "printf 'server {}' > /etc/nginx/conf.d/example.conf",
  "curl -fsSL https://example.com/install.sh | bash",
  "unknown-tool --do-a-write"
];

const blockedCommands = [
  "rm -rf /",
  "DROP DATABASE production",
  "mysql -e 'DROP DATABASE production'",
  "DELETE FROM users",
  "truncate -s 0 /var/log/app.log",
  "find /tmp -delete",
  "mkfs.ext4 /dev/sdb",
  "docker system prune -af",
  "kubectl delete namespace production",
  "terraform destroy",
  "git reset --hard"
];

for (const command of safeCommands) {
  assert.equal(assessShellCommand(command).ok, true, `expected safe: ${command}`);
}

for (const command of blockedCommands) {
  assert.equal(assessShellCommand(command).ok, false, `expected blocked: ${command}`);
}

assert.equal(
  normalizeTerminalEol("$ command\nfirst row\r\nsecond row\rthird row"),
  "$ command\r\nfirst row\r\nsecond row\r\nthird row",
  "agent terminal output must use CRLF so xterm restarts at column zero"
);

const service = Object.create(SshOpsService.prototype);
service.config = { maxBufferBytes: 1024, maxCaptureBytes: 512, maxCommandOutputBytes: 128 };
service.wakeWaiters = () => {};

const safeSession = { inputLine: "", inputKnown: true, buffer: "" };
const safeInput = service.prepareTerminalInput(safeSession, "free -h\r");
assert.equal(safeInput.forwarded, "free -h\r");
assert.equal(safeInput.blockedReason, null);

const blockedSession = { inputLine: "", inputKnown: true, buffer: "" };
const blockedInput = service.prepareTerminalInput(blockedSession, "rm -rf /\r");
assert.equal(blockedInput.forwarded, "rm -rf /\x15");
assert.match(blockedInput.blockedReason, /安全策略已阻止/);
assert.match(blockedSession.buffer, /DSH SSH 安全策略/);

const captureSession = { buffer: "", captureBuffer: "", lastPrompt: null };
service.appendSessionOutput(captureSession, "root@iZ2vc27mmzgpr2oszj1kplZ:~# ");
assert.equal(captureSession.lastPrompt, "root@iZ2vc27mmzgpr2oszj1kplZ:~# ");
const displayConn = { host: "192.0.2.10", username: "root", sessions: new Set(["capture"]) };
service.connections = new Map([["capture", displayConn]]);
service.sessions = new Map([["capture", { ...captureSession, exited: null }]]);
service.appendSessionOutput(service.sessions.get("capture"), "$ echo old\r\nold output\r\n");
const rememberedPrompt = service.sessions.get("capture").lastPrompt;
service.appendSessionOutput(service.sessions.get("capture"), "root@iZ2vc27mmzgpr2oszj1kplZ:~# ");
assert.equal(rememberedPrompt, "root@iZ2vc27mmzgpr2oszj1kplZ:~# ");
assert.match(service.sessions.get("capture").captureBuffer, /old output/);

const redacted = redactForModel("PASSWORD=top-secret\nAuthorization: Bearer abc.def\n");
assert.equal(redacted.redacted, true);
assert.doesNotMatch(redacted.text, /top-secret|abc\.def/);

// 裸 sk- 开头的 API key（无 KEY= / authorization 前缀）也必须脱敏
const redactedSk = redactForModel("export OPENAI_API_KEY=\"sk-1234567890abcdefghijklmnop\"\ncurl -H 'Authorization: Bearer sk-abcdef1234567890XYZABC' https://api.example.com\nsk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefgh");
assert.equal(redactedSk.redacted, true);
assert.doesNotMatch(redactedSk.text, /sk-[A-Za-z0-9]{12,}/);

// 短 token（sk- 后不足 12 字符）不应被误伤
const shortSk = redactForModel("a short sk-abc word");
assert.doesNotMatch(shortSk.text, /sk-\*\*\*/);

let manualInput;
service.sessions = new Map([["manual", {
  exited: null,
  stream: { write(value) { manualInput = value; } }
}]]);
const manualWrite = await service.write({
  sessionId: "manual",
  data: Buffer.from("rm -rf /\r", "utf8").toString("base64")
});
assert.equal(manualWrite.ok, true);
assert.equal(manualInput, "rm -rf /\r", "manual terminal input must not be treated as an agent command");

service.connections = new Map();
const rejectedExec = await service.execOnConnection("missing", "DROP DATABASE production");
assert.equal(rejectedExec.ok, false);
assert.equal(rejectedExec.error.code, "unsafe-command");

const allowedButMissing = await service.execOnConnection("missing", "free -h");
assert.equal(allowedButMissing.ok, false);
assert.equal(allowedButMissing.error.code, "no-connection");

const activeConnection = { host: "192.0.2.10", port: 22, username: "root", sessions: new Set() };
service.connections = new Map([["active", activeConnection]]);
service.activeConnectionId = "active";
let commandInvocation;
service.execOnConnection = async (connectionId, command) => {
  commandInvocation = { connectionId, command };
  return {
    ok: true,
    value: {
      exitCode: 0,
      stdout: "Mem: 1.0G 0.5G\n",
      stderr: "",
      commandId: "cmd-1",
      startedAt: "2026-08-15T00:00:00.000Z",
      finishedAt: "2026-08-15T00:00:01.000Z",
      durationMs: 1000,
      truncated: false,
      timedOut: false
    }
  };
};
const execution = await service.executeCommand({ command: "free -h" });
assert.deepEqual(commandInvocation, { connectionId: "active", command: "free -h" });
assert.equal(execution.ok, true);
assert.equal(execution.value.host, "192.0.2.10");
assert.deepEqual(Object.keys(execution.value).sort(), ["commandId", "connectionId", "durationMs", "exitCode", "finishedAt", "host", "redacted", "startedAt", "stderr", "stdout", "timedOut", "truncated"]);

const registeredTools = [];
service.registerTools({ tools: { register(tool) { registeredTools.push(tool); } } });
assert.ok(registeredTools.some((tool) => tool.name === "ssh_exec"));
assert.ok(!registeredTools.some((tool) => tool.name === "ssh_check_memory"));
assert.ok(registeredTools.some((tool) => tool.name === "ssh_list"));

const renderFixtures = {
  ssh_list: [{}, { activeConnectionId: "active", connections: [{ connectionId: "active", name: "demo", host: "192.0.2.10", port: 22, username: "root", connected: true, sessions: [] }] }],
  ssh_connect: [{ username: "root", host: "192.0.2.10" }, { connectionId: "active" }],
  ssh_exec: [{}, { connectionId: "active", host: "192.0.2.10", exitCode: 0, stdout: "ok\n", stderr: "", commandId: "cmd-1", startedAt: "2026-08-15T00:00:00.000Z", finishedAt: "2026-08-15T00:00:01.000Z", durationMs: 1000, truncated: false, timedOut: false, redacted: false }],
  ssh_read: [{}, { connectionId: "active", host: "192.0.2.10", data: "prompt", hasSession: true, truncated: false, redacted: false }],
  ssh_write: [{}, { written: 5 }],
  ssh_disconnect: [{}, { disconnected: true }]
};
for (const [name, [args, value]] of Object.entries(renderFixtures)) {
  const tool = registeredTools.find((candidate) => candidate.name === name);
  const content = tool.output.render(args, value);
  assert.equal(content.length, 1, `${name} should render one content block`);
  assert.equal(content[0].type, "text", `${name} should render a text block`);
  assert.equal(typeof content[0].text, "string", `${name} text should not be split into characters`);
}

// Durable SSH resources deliberately split public metadata from secret values.
function memoryTable() {
  const records = new Map();
  return {
    get: (key) => records.get(key),
    entries: () => records.entries(),
    async put(key, value) { records.set(key, value); },
    async delete(key) { return records.delete(key); }
  };
}

const secrets = new Map();
const profileService = Object.create(SshOpsService.prototype);
profileService.profileTable = memoryTable();
profileService.groupTable = memoryTable();
profileService.connections = new Map();
profileService.ctx = {
  credentials: {
    async describe(ref) { return { configured: secrets.has(ref), writable: true }; },
    async resolve(ref) { return secrets.has(ref) ? { value: secrets.get(ref), source: "file" } : undefined; },
    async unset(ref) { secrets.delete(ref); }
  }
};
const newGroup = await profileService.groupSave({ name: "生产环境" });
assert.equal(newGroup.ok, true);
const savedProfile = await profileService.profileSave({
  name: "web-01", host: "192.0.2.10", port: 22, username: "root", authKind: "key", groupId: newGroup.value.group.groupId
});
assert.equal(savedProfile.ok, true);
assert.match(savedProfile.value.credentialRefs.privateKey, /^DSH_SSH_OPS_[A-F0-9]+_PRIVATE_KEY$/);
secrets.set(savedProfile.value.credentialRefs.privateKey, "PRIVATE KEY MUST NOT LEAK");
const listedProfiles = await profileService.profileList();
assert.equal(listedProfiles.ok, true);
assert.equal(listedProfiles.value.profiles[0].credentialConfigured, true);
assert.equal("credentialRefs" in listedProfiles.value.profiles[0], false);
assert.equal(JSON.stringify(listedProfiles.value), JSON.stringify(listedProfiles.value).replace("PRIVATE KEY MUST NOT LEAK", ""));
const deletedGroup = await profileService.groupDelete({ groupId: newGroup.value.group.groupId });
assert.deepEqual(deletedGroup.value, { deleted: true, movedProfiles: 1 });
const ungroupedProfiles = await profileService.profileList();
assert.equal(ungroupedProfiles.value.profiles[0].groupId, null);
const deletedProfile = await profileService.profileDelete({ profileId: savedProfile.value.profile.profileId });
assert.equal(deletedProfile.value.deleted, true);
assert.equal(secrets.size, 0);

console.log(`safety policy: ${safeCommands.length} safe and ${blockedCommands.length} blocked cases passed`);
