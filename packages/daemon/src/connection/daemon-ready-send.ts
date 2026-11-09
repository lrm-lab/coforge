import type { CentrifugeWorkspaceClient } from "./centrifuge-workspace-client";
import { rpcData } from "./rpc-data";
import { utf8Decoder } from "@lrm/coforge-sdk/internal";
import {
  DAEMON_RUNTIME_READY_METHOD,
  decodeDaemonRuntimeReadyResponse,
  encodeDaemonRuntimeReadyRequest,
  type DaemonRuntimeReadyRequest,
  type DaemonRuntimeReadyResponse,
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
 * reply named (nothing when the server is older or the feed read failed), plus whether the
 * server takes the `accepted` Agent control phase — `false` on an older server's empty or
 * undecodable reply, so a daemon never sends a phase that server would reject. */
export async function sendDaemonReady(
  client: CentrifugeWorkspaceClient,
  request: DaemonRuntimeReadyRequest,
  onLatestComputerVersion?: (version: string) => void,
  onAgentControlAccepted?: (accepted: boolean) => void,
): Promise<void> {
  const reply = await client.rpc(
    DAEMON_RUNTIME_READY_METHOD,
    encodeDaemonRuntimeReadyRequest(request),
  );
  let response: DaemonRuntimeReadyResponse;
  try {
    response = decodeDaemonRuntimeReadyResponse(rpcData(reply));
  } catch {
    // Best effort: an older server answers a shape this build does not know, and neither hint
    // is worth failing an accepted ready for.
    onAgentControlAccepted?.(false);
    return;
  }
  if (response.latestComputerVersion) onLatestComputerVersion?.(response.latestComputerVersion);
  onAgentControlAccepted?.(response.agentControlAccepted === true);
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

/** The connection-status heartbeat's reply, read best-effort like the ready reply's: the JSON
 * body's `latestComputerVersion`, or nothing when an older server answers a different shape. */
export function readStatusLatestVersion(reply: unknown): string | undefined {
  try {
    const { latestComputerVersion } = JSON.parse(utf8Decoder.decode(rpcData(reply))) as {
      latestComputerVersion?: string;
    };
    return latestComputerVersion;
  } catch {
    return undefined;
  }
}
