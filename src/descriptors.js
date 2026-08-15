/**
 * Invocation descriptors for the `sshOps` Remote — one source of truth
 * consumed by both the host TYPERT manifest (typert.js) and the client
 * contribution (remote.js), mirroring the shape the repo's typert generator
 * emits.
 */
import * as S from "./schemas.js";

const PACKAGE = "dsh-ssh-ops";
const NS = "sshOps";

function def(method, requestSchema, requestType, resultSchema, resultType) {
  return {
    id: `${PACKAGE}#${NS}/${method}`,
    service: NS,
    namespace: NS,
    method,
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "request",
        wire: "request",
        source: "json",
        codec: { mode: "strict", typeSymbol: `${PACKAGE}/types#${requestType}`, schema: requestSchema }
      }
    ],
    result: {
      mode: "strict",
      typeSymbol: `${PACKAGE}/types#${resultType}`,
      schema: resultSchema
    },
    sourceLocation: { file: "src/index.js", line: 1, column: 1 }
  };
}

export const DESCRIPTORS = [
  def("list", S.listRequestSchema, "SshListRequest", S.listResultSchema, "SshListResult"),
  def("connect", S.connectRequestSchema, "SshConnectRequest", S.connectResultSchema, "SshConnectResult"),
  def("openSession", S.openSessionRequestSchema, "SshOpenSessionRequest", S.openSessionResultSchema, "SshOpenSessionResult"),
  def("write", S.writeRequestSchema, "SshWriteRequest", S.writeResultSchema, "SshWriteResult"),
  def("read", S.readRequestSchema, "SshReadRequest", S.readResultSchema, "SshReadResult"),
  def("resize", S.resizeRequestSchema, "SshResizeRequest", S.resizeResultSchema, "SshResizeResult"),
  def("closeSession", S.closeSessionRequestSchema, "SshCloseSessionRequest", S.closeSessionResultSchema, "SshCloseSessionResult"),
  def("disconnect", S.disconnectRequestSchema, "SshDisconnectRequest", S.disconnectResultSchema, "SshDisconnectResult")
];
