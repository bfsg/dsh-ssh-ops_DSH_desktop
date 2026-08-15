/**
 * Host typert artifact: discovered automatically by @deepseek-ai/dsh-typert-loader
 * through the package's "./typert" export and registered into ctx.typert, which
 * the typert gateway consults for strict dispatch codecs.
 */
import { DESCRIPTORS } from "./descriptors.js";
import { sshErrorSchema } from "./schemas.js";

export const TYPERT = {
  package: "dsh-ssh-ops",
  face: "host",
  schemas: [
    { name: "sshError", schema: sshErrorSchema }
  ],
  invocations: DESCRIPTORS,
  model: {
    events: [],
    objects: [],
    services: [
      {
        description: "SSH ops sessions for the Web UI: connect to remote hosts, open PTY shells, stream input and output, resize, and disconnect. Backed by ssh2 in the host process.",
        summary: "SSH remote sessions backed by ssh2.",
        tags: [],
        jsDoc: "/**\n * SSH remote terminal sessions for the Web UI.\n */",
        key: "sshOps",
        exportName: "SshOpsService",
        members: [
          { kind: "method", name: "list", signature: "async list(request: SshListRequest): Promise<SshListResult>" },
          { kind: "method", name: "connect", signature: "async connect(request: SshConnectRequest): Promise<SshConnectResult>" },
          { kind: "method", name: "openSession", signature: "async openSession(request: SshOpenSessionRequest): Promise<SshOpenSessionResult>" },
          { kind: "method", name: "write", signature: "async write(request: SshWriteRequest): Promise<SshWriteResult>" },
          { kind: "method", name: "read", signature: "async read(request: SshReadRequest): Promise<SshReadResult>" },
          { kind: "method", name: "resize", signature: "async resize(request: SshResizeRequest): Promise<SshResizeResult>" },
          { kind: "method", name: "closeSession", signature: "async closeSession(request: SshCloseSessionRequest): Promise<SshCloseSessionResult>" },
          { kind: "method", name: "disconnect", signature: "async disconnect(request: SshDisconnectRequest): Promise<SshDisconnectResult>" }
        ],
        types: [
          { name: "SshListRequest", declaration: "export interface SshListRequest {}" },
          { name: "SshListResult", declaration: "export type SshListResult = SshResult<{ connections: SshConnectionInfo[] }>;" },
          { name: "SshConnectRequest", declaration: "export interface SshConnectRequest { readonly host: string; readonly port?: number; readonly username: string; readonly auth: SshAuth; readonly readyTimeout?: number; readonly name?: string; }" },
          { name: "SshConnectResult", declaration: "export type SshConnectResult = SshResult<{ connectionId: string; name?: string; host: string; port: number; username: string }>;" },
          { name: "SshOpenSessionRequest", declaration: "export interface SshOpenSessionRequest { readonly connectionId: string; readonly cols?: number; readonly rows?: number; }" },
          { name: "SshOpenSessionResult", declaration: "export type SshOpenSessionResult = SshResult<SshSessionInfo>;" },
          { name: "SshWriteRequest", declaration: "export interface SshWriteRequest { readonly sessionId: string; readonly data: string; }" },
          { name: "SshWriteResult", declaration: "export type SshWriteResult = SshResult<{ written: number }>;" },
          { name: "SshReadRequest", declaration: "export interface SshReadRequest { readonly sessionId: string; readonly timeoutMs?: number; }" },
          { name: "SshReadResult", declaration: "export type SshReadResult = SshResult<{ data: string; exit: SshExit | null }>;" },
          { name: "SshResizeRequest", declaration: "export interface SshResizeRequest { readonly sessionId: string; readonly cols: number; readonly rows: number; }" },
          { name: "SshResizeResult", declaration: "export type SshResizeResult = SshResult<{ cols: number; rows: number }>;" },
          { name: "SshCloseSessionRequest", declaration: "export interface SshCloseSessionRequest { readonly sessionId: string; }" },
          { name: "SshCloseSessionResult", declaration: "export type SshCloseSessionResult = SshResult<{ closed: boolean }>;" },
          { name: "SshDisconnectRequest", declaration: "export interface SshDisconnectRequest { readonly connectionId: string; }" },
          { name: "SshDisconnectResult", declaration: "export type SshDisconnectResult = SshResult<{ disconnected: boolean }>;" }
        ]
      }
    ]
  }
};

export default TYPERT;
