/**
 * Browser-side client for the `sshOps` Remote namespace. The namespace service
 * is mounted by apply() through ctx.remote.$mount(TYPERT_REMOTE); this class
 * unwraps the { ok, value | error } envelope into values or thrown errors and
 * converts base64 wire payloads to/from UTF-8 strings.
 */
export class SshApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SshApiError";
    this.code = code;
  }
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function decodeBase64(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export class SshApi {
  /** @param {() => object|undefined} getNamespace live namespace getter */
  constructor(getNamespace) {
    this.getNamespace = getNamespace;
  }

  async call(method, args) {
    const namespace = this.getNamespace();
    const fn = namespace?.[method];
    if (typeof fn !== "function") {
      throw new SshApiError("not-mounted", `sshOps Remote method "${method}" is not mounted`);
    }
    const rpc = await fn(args);
    if (!rpc.ok) {
      throw new SshApiError("rpc-failed", rpc.error?.message ?? "remote call failed");
    }
    const business = rpc.value;
    if (business.ok) return business.value;
    throw new SshApiError(business.error.code, business.error.message);
  }

  list() {
    return this.call("list", {});
  }

  connect(input) {
    return this.call("connect", input);
  }

  openSession(connectionId, cols, rows) {
    return this.call("openSession", { connectionId, cols, rows });
  }

  async write(sessionId, text) {
    await this.call("write", { sessionId, data: encodeBase64(text) });
  }

  async read(sessionId, timeoutMs = 300) {
    const value = await this.call("read", { sessionId, timeoutMs });
    return { data: decodeBase64(value.data), exit: value.exit };
  }

  resize(sessionId, cols, rows) {
    return this.call("resize", { sessionId, cols, rows });
  }

  closeSession(sessionId) {
    return this.call("closeSession", { sessionId });
  }

  disconnect(connectionId) {
    return this.call("disconnect", { connectionId });
  }
}

/**
 * Build the SshApi bound to the gateway's live `sshOps` namespace service.
 * Mirrors the dsh-terminal reach-around: the gateway's ClientRemoteService
 * keeps live namespace services in its public `namespaces` map.
 */
export function createSshApi(ctx) {
  return new SshApi(() => {
    const remote = ctx.remote;
    return remote?.namespaces?.get("sshOps")?.service;
  });
}
