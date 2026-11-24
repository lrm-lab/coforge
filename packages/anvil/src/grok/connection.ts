import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk/unstable";
import { asRecord, nonEmptyString } from "#src/json-record";
import { acpProcess, type AcpConnection } from "#src/acp/connection";
import type { AcpRuntimeProfile } from "#src/acp/profile";
import type { GrokConnectionHost } from "./host";

const GROK_NOTIFICATIONS = ["_x.ai/queue/changed", "_x.ai/session_notification"] as const;
const SEEN_LIMIT = 256;

export function grokNotificationEventId(
  method: string,
  params: Readonly<Record<string, unknown>>,
): string | undefined {
  if (method === "_x.ai/queue/changed") return undefined;
  const update = asRecord(params.update);
  const paramsMeta = asRecord(params._meta);
  const updateMeta = asRecord(update?._meta);
  return (
    nonEmptyString(paramsMeta?.eventId) ??
    nonEmptyString(paramsMeta?.event_id) ??
    nonEmptyString(updateMeta?.eventId) ??
    nonEmptyString(updateMeta?.event_id) ??
    nonEmptyString(params.eventId) ??
    nonEmptyString(params.event_id) ??
    nonEmptyString(update?.eventId) ??
    nonEmptyString(update?.event_id)
  );
}

export class GrokEventDedup {
  readonly #seen = new Set<string>();

  accept(method: string, params: Readonly<Record<string, unknown>>): boolean {
    const eventId = grokNotificationEventId(method, params);
    if (!eventId) return true;
    if (this.#seen.has(eventId)) return false;
    this.#seen.add(eventId);
    if (this.#seen.size > SEEN_LIMIT) this.#seen.delete(this.#seen.values().next().value!);
    return true;
  }
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
  const dedup = new GrokEventDedup();
  return acpProcess(GROK_PROFILE, {
    command,
    cwd,
    environment,
    clientInfo: host.sessionClientInfo,
    processTreeSpawner: host.processTreeSpawner,
    onUpdate: (method, params) => {
      const parsed = asRecord(params);
      if (!parsed) throw new Error("Invalid Grok ACP notification");
      if (!dedup.accept(method, parsed)) return;
      onUpdate(method, parsed);
    },
    onPermission,
    onPromptWrite,
  });
}
