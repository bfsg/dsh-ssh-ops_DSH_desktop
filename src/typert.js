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
          { kind: "method", name: "profileList", signature: "async profileList(request: SshProfileListRequest): Promise<SshProfileListResult>" },
          { kind: "method", name: "profileSave", signature: "async profileSave(request: SshProfileSaveRequest): Promise<SshProfileSaveResult>" },
          { kind: "method", name: "profileDelete", signature: "async profileDelete(request: SshProfileDeleteRequest): Promise<SshProfileDeleteResult>" },
          { kind: "method", name: "profileConnect", signature: "async profileConnect(request: SshProfileConnectRequest): Promise<SshProfileConnectResult>" },
          { kind: "method", name: "groupList", signature: "async groupList(request: SshGroupListRequest): Promise<SshGroupListResult>" },
          { kind: "method", name: "groupSave", signature: "async groupSave(request: SshGroupSaveRequest): Promise<SshGroupSaveResult>" },
          { kind: "method", name: "groupDelete", signature: "async groupDelete(request: SshGroupDeleteRequest): Promise<SshGroupDeleteResult>" },
          { kind: "method", name: "openSession", signature: "async openSession(request: SshOpenSessionRequest): Promise<SshOpenSessionResult>" },
          { kind: "method", name: "write", signature: "async write(request: SshWriteRequest): Promise<SshWriteResult>" },
          { kind: "method", name: "read", signature: "async read(request: SshReadRequest): Promise<SshReadResult>" },
          { kind: "method", name: "resize", signature: "async resize(request: SshResizeRequest): Promise<SshResizeResult>" },
          { kind: "method", name: "closeSession", signature: "async closeSession(request: SshCloseSessionRequest): Promise<SshCloseSessionResult>" },
          { kind: "method", name: "disconnect", signature: "async disconnect(request: SshDisconnectRequest): Promise<SshDisconnectResult>" },
          { kind: "method", name: "sftpList", signature: "async sftpList(request: SftpListRequest): Promise<SftpListResult>" },
          { kind: "method", name: "sftpStat", signature: "async sftpStat(request: SftpStatRequest): Promise<SftpStatResult>" },
          { kind: "method", name: "sftpReadFile", signature: "async sftpReadFile(request: SftpReadRequest): Promise<SftpReadResult>" },
          { kind: "method", name: "sftpWriteFile", signature: "async sftpWriteFile(request: SftpWriteRequest): Promise<SftpWriteResult>" },
          { kind: "method", name: "sftpMkdir", signature: "async sftpMkdir(request: SftpMkdirRequest): Promise<SftpMkdirResult>" },
          { kind: "method", name: "sftpDelete", signature: "async sftpDelete(request: SftpDeleteRequest): Promise<SftpDeleteResult>" },
          { kind: "method", name: "sftpRename", signature: "async sftpRename(request: SftpRenameRequest): Promise<SftpRenameResult>" },
          { kind: "method", name: "tunnelStartLocal", signature: "async tunnelStartLocal(request: TunnelStartLocalRequest): Promise<TunnelStartLocalResult>" },
          { kind: "method", name: "tunnelStartRemote", signature: "async tunnelStartRemote(request: TunnelStartRemoteRequest): Promise<TunnelStartRemoteResult>" },
          { kind: "method", name: "tunnelStop", signature: "async tunnelStop(request: TunnelStopRequest): Promise<TunnelStopResult>" },
          { kind: "method", name: "tunnelList", signature: "async tunnelList(request: TunnelListRequest): Promise<TunnelListResult>" }
        ],
        types: [
          { name: "SshListRequest", declaration: "export interface SshListRequest {}" },
          { name: "SshListResult", declaration: "export type SshListResult = SshResult<{ connections: SshConnectionInfo[]; activeConnectionId: string | null }>;" },
          { name: "SshConnectRequest", declaration: "export interface SshConnectRequest { readonly host: string; readonly port?: number; readonly username: string; readonly auth: SshAuth; readonly readyTimeout?: number; readonly name?: string; }" },
          { name: "SshConnectResult", declaration: "export type SshConnectResult = SshResult<{ connectionId: string; name?: string; host: string; port: number; username: string }>;" },
          { name: "SshProfileListRequest", declaration: "export interface SshProfileListRequest {}" },
          { name: "SshProfileListResult", declaration: "export type SshProfileListResult = SshResult<{ profiles: SshProfileInfo[] }>;" },
          { name: "SshProfileSaveRequest", declaration: "export interface SshProfileSaveRequest { readonly profileId?: string; readonly name: string; readonly host: string; readonly port?: number; readonly username: string; readonly authKind: 'password' | 'key'; readonly groupId?: string | null; }" },
          { name: "SshProfileSaveResult", declaration: "export type SshProfileSaveResult = SshResult<{ profile: SshProfileInfo; credentialRefs: SshCredentialRefs }>;" },
          { name: "SshProfileDeleteRequest", declaration: "export interface SshProfileDeleteRequest { readonly profileId: string; }" },
          { name: "SshProfileDeleteResult", declaration: "export type SshProfileDeleteResult = SshResult<{ deleted: boolean }>;" },
          { name: "SshProfileConnectRequest", declaration: "export interface SshProfileConnectRequest { readonly profileId: string; }" },
          { name: "SshProfileConnectResult", declaration: "export type SshProfileConnectResult = SshConnectResult;" },
          { name: "SshGroupListRequest", declaration: "export interface SshGroupListRequest {}" },
          { name: "SshGroupListResult", declaration: "export type SshGroupListResult = SshResult<{ groups: SshGroupInfo[] }>;" },
          { name: "SshGroupSaveRequest", declaration: "export interface SshGroupSaveRequest { readonly groupId?: string; readonly name: string; }" },
          { name: "SshGroupSaveResult", declaration: "export type SshGroupSaveResult = SshResult<{ group: SshGroupInfo }>;" },
          { name: "SshGroupDeleteRequest", declaration: "export interface SshGroupDeleteRequest { readonly groupId: string; }" },
          { name: "SshGroupDeleteResult", declaration: "export type SshGroupDeleteResult = SshResult<{ deleted: boolean; movedProfiles: number }>;" },
          { name: "SshProfileInfo", declaration: "export interface SshProfileInfo { readonly profileId: string; readonly groupId: string | null; readonly groupName: string | null; readonly name: string; readonly host: string; readonly port: number; readonly username: string; readonly authKind: 'password' | 'key'; readonly credentialConfigured: boolean; readonly passphraseConfigured: boolean; readonly connected: boolean; }" },
          { name: "SshCredentialRefs", declaration: "export interface SshCredentialRefs { readonly password: string; readonly privateKey: string; readonly passphrase: string; }" },
          { name: "SshGroupInfo", declaration: "export interface SshGroupInfo { readonly groupId: string; readonly name: string; readonly profileCount: number; }" },
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
          { name: "SshDisconnectResult", declaration: "export type SshDisconnectResult = SshResult<{ disconnected: boolean }>;" },
          { name: "SftpListRequest", declaration: "export interface SftpListRequest { readonly connectionId?: string; readonly path?: string; }" },
          { name: "SftpListResult", declaration: "export type SftpListResult = SshResult<{ path: string; entries: SftpEntry[] }>;" },
          { name: "SftpStatRequest", declaration: "export interface SftpStatRequest { readonly connectionId?: string; readonly path: string; }" },
          { name: "SftpStatResult", declaration: "export type SftpStatResult = SshResult<SftpEntry & { path: string }>;" },
          { name: "SftpReadRequest", declaration: "export interface SftpReadRequest { readonly connectionId?: string; readonly path: string; readonly maxBytes?: number; }" },
          { name: "SftpReadResult", declaration: "export type SftpReadResult = SshResult<{ path: string; data: string; truncated: boolean; bytes: number }>;" },
          { name: "SftpWriteRequest", declaration: "export interface SftpWriteRequest { readonly connectionId?: string; readonly path: string; readonly data: string; }" },
          { name: "SftpWriteResult", declaration: "export type SftpWriteResult = SshResult<{ path: string; bytes: number }>;" },
          { name: "SftpMkdirRequest", declaration: "export interface SftpMkdirRequest { readonly connectionId?: string; readonly path: string; }" },
          { name: "SftpMkdirResult", declaration: "export type SftpMkdirResult = SshResult<{ path: string }>;" },
          { name: "SftpDeleteRequest", declaration: "export interface SftpDeleteRequest { readonly connectionId?: string; readonly path: string; }" },
          { name: "SftpDeleteResult", declaration: "export type SftpDeleteResult = SshResult<{ path: string; isDirectory: boolean }>;" },
          { name: "SftpRenameRequest", declaration: "export interface SftpRenameRequest { readonly connectionId?: string; readonly from: string; readonly to: string; }" },
          { name: "SftpRenameResult", declaration: "export type SftpRenameResult = SshResult<{ from: string; to: string }>;" },
          { name: "SftpEntry", declaration: "export interface SftpEntry { readonly name: string; readonly isDirectory: boolean; readonly size: number; readonly mtime: number; readonly mode: number; }" },
          { name: "TunnelStartLocalRequest", declaration: "export interface TunnelStartLocalRequest { readonly connectionId?: string; readonly bindAddr?: string; readonly bindPort?: number; readonly remoteHost: string; readonly remotePort: number; }" },
          { name: "TunnelStartLocalResult", declaration: "export type TunnelStartLocalResult = SshResult<{ tunnelId: string; kind: 'local'; bindAddr: string; bindPort: number; remoteHost: string; remotePort: number }>;" },
          { name: "TunnelStartRemoteRequest", declaration: "export interface TunnelStartRemoteRequest { readonly connectionId?: string; readonly bindAddr?: string; readonly bindPort?: number; readonly remoteHost: string; readonly remotePort: number; readonly targetHost: string; readonly targetPort: number; }" },
          { name: "TunnelStartRemoteResult", declaration: "export type TunnelStartRemoteResult = SshResult<{ tunnelId: string; kind: 'remote'; bindAddr: string; bindPort: number; remoteHost: string; remotePort: number; targetHost: string; targetPort: number }>;" },
          { name: "TunnelStopRequest", declaration: "export interface TunnelStopRequest { readonly connectionId?: string; readonly tunnelId: string; }" },
          { name: "TunnelStopResult", declaration: "export type TunnelStopResult = SshResult<{ tunnelId: string; stopped: boolean }>;" },
          { name: "TunnelListRequest", declaration: "export interface TunnelListRequest { readonly connectionId?: string; }" },
          { name: "TunnelListResult", declaration: "export type TunnelListResult = SshResult<{ tunnels: TunnelInfo[] }>;" },
          { name: "TunnelInfo", declaration: "export interface TunnelInfo { readonly tunnelId: string; readonly kind: string; readonly bindAddr: string; readonly bindPort: number; readonly remoteHost?: string; readonly remotePort?: number; readonly targetHost?: string; readonly targetPort?: number; readonly active: boolean; }" }
        ]
      }
    ]
  }
};

export default TYPERT;
