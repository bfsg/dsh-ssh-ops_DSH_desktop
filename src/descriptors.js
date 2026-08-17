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
  def("profileList", S.profileListRequestSchema, "SshProfileListRequest", S.profileListResultSchema, "SshProfileListResult"),
  def("profileSave", S.profileSaveRequestSchema, "SshProfileSaveRequest", S.profileSaveResultSchema, "SshProfileSaveResult"),
  def("profileDelete", S.profileDeleteRequestSchema, "SshProfileDeleteRequest", S.profileDeleteResultSchema, "SshProfileDeleteResult"),
  def("profileConnect", S.profileConnectRequestSchema, "SshProfileConnectRequest", S.profileConnectResultSchema, "SshProfileConnectResult"),
  def("groupList", S.groupListRequestSchema, "SshGroupListRequest", S.groupListResultSchema, "SshGroupListResult"),
  def("groupSave", S.groupSaveRequestSchema, "SshGroupSaveRequest", S.groupSaveResultSchema, "SshGroupSaveResult"),
  def("groupDelete", S.groupDeleteRequestSchema, "SshGroupDeleteRequest", S.groupDeleteResultSchema, "SshGroupDeleteResult"),
  def("openSession", S.openSessionRequestSchema, "SshOpenSessionRequest", S.openSessionResultSchema, "SshOpenSessionResult"),
  def("write", S.writeRequestSchema, "SshWriteRequest", S.writeResultSchema, "SshWriteResult"),
  def("read", S.readRequestSchema, "SshReadRequest", S.readResultSchema, "SshReadResult"),
  def("resize", S.resizeRequestSchema, "SshResizeRequest", S.resizeResultSchema, "SshResizeResult"),
  def("closeSession", S.closeSessionRequestSchema, "SshCloseSessionRequest", S.closeSessionResultSchema, "SshCloseSessionResult"),
  def("disconnect", S.disconnectRequestSchema, "SshDisconnectRequest", S.disconnectResultSchema, "SshDisconnectResult"),
  def("sftpList", S.sftpListRequestSchema, "SftpListRequest", S.sftpListResultSchema, "SftpListResult"),
  def("sftpStat", S.sftpStatRequestSchema, "SftpStatRequest", S.sftpStatResultSchema, "SftpStatResult"),
  def("sftpReadFile", S.sftpReadRequestSchema, "SftpReadRequest", S.sftpReadResultSchema, "SftpReadResult"),
  def("sftpWriteFile", S.sftpWriteRequestSchema, "SftpWriteRequest", S.sftpWriteResultSchema, "SftpWriteResult"),
  def("sftpMkdir", S.sftpMkdirRequestSchema, "SftpMkdirRequest", S.sftpMkdirResultSchema, "SftpMkdirResult"),
  def("sftpDelete", S.sftpDeleteRequestSchema, "SftpDeleteRequest", S.sftpDeleteResultSchema, "SftpDeleteResult"),
  def("sftpRename", S.sftpRenameRequestSchema, "SftpRenameRequest", S.sftpRenameResultSchema, "SftpRenameResult"),
  def("tunnelStartLocal", S.tunnelStartLocalRequestSchema, "TunnelStartLocalRequest", S.tunnelStartLocalResultSchema, "TunnelStartLocalResult"),
  def("tunnelStartRemote", S.tunnelStartRemoteRequestSchema, "TunnelStartRemoteRequest", S.tunnelStartRemoteResultSchema, "TunnelStartRemoteResult"),
  def("tunnelStop", S.tunnelStopRequestSchema, "TunnelStopRequest", S.tunnelStopResultSchema, "TunnelStopResult"),
  def("tunnelList", S.tunnelListRequestSchema, "TunnelListRequest", S.tunnelListResultSchema, "TunnelListResult"),
  def("sshConfigImport", S.sshConfigImportRequestSchema, "SshConfigImportRequest", S.sshConfigImportResultSchema, "SshConfigImportResult"),
  def("dbConnect", S.dbConnectRequestSchema, "DbConnectRequest", S.dbConnectResultSchema, "DbConnectResult"),
  def("dbListConnections", S.dbListConnectionsRequestSchema, "DbListConnectionsRequest", S.dbListConnectionsResultSchema, "DbListConnectionsResult"),
  def("dbQuery", S.dbQueryRequestSchema, "DbQueryRequest", S.dbQueryResultSchema, "DbQueryResult"),
  def("dbExecute", S.dbExecuteRequestSchema, "DbExecuteRequest", S.dbExecuteResultSchema, "DbExecuteResult"),
  def("dbListTables", S.dbListTablesRequestSchema, "DbListTablesRequest", S.dbListTablesResultSchema, "DbListTablesResult"),
  def("dbDescribeTable", S.dbDescribeTableRequestSchema, "DbDescribeTableRequest", S.dbDescribeTableResultSchema, "DbDescribeTableResult"),
  def("dbRun", S.dbRunRequestSchema, "DbRunRequest", S.dbRunResultSchema, "DbRunResult"),
  def("dbDisconnect", S.dbDisconnectRequestSchema, "DbDisconnectRequest", S.dbDisconnectResultSchema, "DbDisconnectResult"),
  def("dbProfileList", S.dbProfileListRequestSchema, "DbProfileListRequest", S.dbProfileListResultSchema, "DbProfileListResult"),
  def("dbProfileSave", S.dbProfileSaveRequestSchema, "DbProfileSaveRequest", S.dbProfileSaveResultSchema, "DbProfileSaveResult"),
  def("dbProfileDelete", S.dbProfileDeleteRequestSchema, "DbProfileDeleteRequest", S.dbProfileDeleteResultSchema, "DbProfileDeleteResult"),
  def("dbProfileConnect", S.dbProfileConnectRequestSchema, "DbProfileConnectRequest", S.dbProfileConnectResultSchema, "DbProfileConnectResult")
];
