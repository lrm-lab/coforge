import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { AcpConnection } from "#src/acp/connection";
import type { GrokConnectionHost } from "./host";

/** The native notifications Grok publishes beside `session/update`. */
const GROK_NOTIFICATIONS = ["_x.ai/queue/changed", "_x.ai/session_notification"] as const;

export type GrokConnection = AcpConnection;

export function grokConnection(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  host: GrokConnectionHost,
  onUpdate: (method: string, params: Readonly<Record<string, unknown>>) => void,
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse,
): AcpConnection {
  return new AcpConnection({
    command,
    cwd,
    environment,
    host: {
      clientInfo: host.sessionClientInfo,
      processTreeSpawner: host.processTreeSpawner,
    },
    messages: {
      unsupportedProtocol: "Unsupported Grok ACP protocol version",
      closedBeforeConfig: "Grok ACP process closed before configuration",
      timedOut: "Grok ACP operation timed out",
    },
    notifications: GROK_NOTIFICATIONS,
    onUpdate,
    onPermission,
  });
}
