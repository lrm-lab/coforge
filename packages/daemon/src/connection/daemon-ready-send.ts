import type { CentrifugeWorkspaceClient } from "./centrifuge-workspace-client";
import { rpcData } from "./rpc-data";
import {
  DAEMON_RUNTIME_READY_METHOD,
  decodeDaemonRuntimeReadyResponse,
  encodeDaemonRuntimeReadyRequest,
  type DaemonRuntimeReadyRequest,
  DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD,
  encodeDaemonRuntimeCodeAgentsUpdateRequest,
  type DaemonRuntimeCodeAgentsUpdateRequest,
  RUNTIME_AUTH_LOGIN_REPORT_METHOD,
  encodeRuntimeAuthLoginReport,
  type RuntimeAuthLoginReport,
  RUNTIME_AUTH_LOGOUT_REPORT_METHOD,
  encodeRuntimeAuthLogoutReport,
  type RuntimeAuthLogoutReport,
  RUNTIME_AUTH_STATUS_REPORT_METHOD,
  encodeRuntimeAuthStatusReport,
  type RuntimeAuthStatusReport,
} from "@lrm/coforge-sdk/internal";

/** The ready RPC: sends the request and reports the release feed's newest Computer version the
 * reply named (nothing when the server is older or the feed read failed). */
export async function sendDaemonReady(
  client: CentrifugeWorkspaceClient,
  request: DaemonRuntimeReadyRequest,
  onLatestComputerVersion?: (version: string) => void,
): Promise<void> {
  const reply = await client.rpc(
    DAEMON_RUNTIME_READY_METHOD,
    encodeDaemonRuntimeReadyRequest(request),
  );
  try {
    const version = decodeDaemonRuntimeReadyResponse(rpcData(reply)).latestComputerVersion;
    if (version) onLatestComputerVersion?.(version);
  } catch {
    // Best effort: an older server answers a shape this build does not know, and the version
    // hint is not worth failing an accepted ready for.
  }
}

export async function sendCodeAgentsUpdate(
  rpc: (method: string, data: Uint8Array) => Promise<unknown>,
  value: DaemonRuntimeCodeAgentsUpdateRequest,
): Promise<void> {
  await rpc(
    DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD,
    encodeDaemonRuntimeCodeAgentsUpdateRequest(value),
  );
}

export async function sendRuntimeAuthLogin(
  rpc: (method: string, data: Uint8Array) => Promise<unknown>,
  value: RuntimeAuthLoginReport,
): Promise<void> {
  await rpc(RUNTIME_AUTH_LOGIN_REPORT_METHOD, encodeRuntimeAuthLoginReport(value));
}

export async function sendRuntimeAuthLogout(
  rpc: (method: string, data: Uint8Array) => Promise<unknown>,
  value: RuntimeAuthLogoutReport,
): Promise<void> {
  await rpc(RUNTIME_AUTH_LOGOUT_REPORT_METHOD, encodeRuntimeAuthLogoutReport(value));
}

export async function sendRuntimeAuthStatus(
  rpc: (method: string, data: Uint8Array) => Promise<unknown>,
  value: RuntimeAuthStatusReport,
): Promise<void> {
  await rpc(RUNTIME_AUTH_STATUS_REPORT_METHOD, encodeRuntimeAuthStatusReport(value));
}
