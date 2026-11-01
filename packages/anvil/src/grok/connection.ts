import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { acpProcess, type AcpConnection } from "#src/acp/connection";
import type { AcpRuntimeProfile } from "#src/acp/profile";
import type { GrokConnectionHost } from "./host";

/** The native notifications Grok publishes beside `session/update`. */
const GROK_NOTIFICATIONS = ["_x.ai/queue/changed", "_x.ai/session_notification"] as const;

export const GROK_PROFILE: AcpRuntimeProfile = {
  args: [],
  notifications: GROK_NOTIFICATIONS,
  messages: {
    unsupportedProtocol: "Unsupported Grok ACP protocol version",
    closedBeforeConfig: "Grok ACP process closed before configuration",
    timedOut: "Grok ACP operation timed out",
  },
};

export type GrokConnection = AcpConnection;

export function grokConnection(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  host: GrokConnectionHost,
  onUpdate: (method: string, params: Readonly<Record<string, unknown>>) => void,
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse,
): AcpConnection {
  return acpProcess(GROK_PROFILE, {
    command,
    cwd,
    environment,
    clientInfo: host.sessionClientInfo,
    processTreeSpawner: host.processTreeSpawner,
    onUpdate,
    onPermission,
  });
}
