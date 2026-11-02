import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { asRecord, nonEmptyString } from "#src/json-record";
import { acpProcess, type AcpConnection } from "#src/acp/connection";
import type { AcpRuntimeProfile } from "#src/acp/profile";
import type { GrokConnectionHost } from "./host";

/** The native notifications Grok publishes beside `session/update`. */
const GROK_NOTIFICATIONS = ["_x.ai/queue/changed", "_x.ai/session_notification"] as const;
const SEEN_LIMIT = 256;

/** Adds `value`, evicting the oldest entry once the set exceeds its bound. */
function remember(seen: Set<string>, value: string) {
  seen.add(value);
  if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
}

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
  onPromptWrite: () => void = () => {},
): AcpConnection {
  const seenEvents = new Set<string>();
  return acpProcess(GROK_PROFILE, {
    command,
    cwd,
    environment,
    clientInfo: host.sessionClientInfo,
    processTreeSpawner: host.processTreeSpawner,
    // A notification Grok publishes with malformed params is a protocol failure, not a frame to
    // drop silently. A replayed event keeps its native id, so it is projected once.
    onUpdate: (method, params) => {
      const parsed = asRecord(params);
      if (!parsed) throw new Error("Invalid Grok ACP notification");
      const eventId =
        method === "_x.ai/queue/changed"
          ? undefined
          : nonEmptyString(asRecord(parsed._meta)?.eventId);
      if (eventId) {
        if (seenEvents.has(eventId)) return;
        remember(seenEvents, eventId);
      }
      onUpdate(method, parsed);
    },
    onPermission,
    onPromptWrite,
  });
}
