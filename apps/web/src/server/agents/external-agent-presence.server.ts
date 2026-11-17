import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import type {
  ExternalAgentCredentialRepository,
  ExternalPresenceRow,
} from "./external-agent-credentials.server";

export const EXTERNAL_ONLINE_WINDOW_MS = 2 * 60 * 1000;

export type ExternalSetupState = "waiting" | "online" | "offline" | "disconnected";

export type ExternalSetup = { state: ExternalSetupState; lastSeenAt: Date | null };

export function externalSetupFrom(
  row: Omit<ExternalPresenceRow, "agentId"> | undefined,
  now: number,
): ExternalSetup {
  if (row?.liveLastUsedAt) {
    const online = now - row.liveLastUsedAt.getTime() < EXTERNAL_ONLINE_WINDOW_MS;
    return { state: online ? "online" : "offline", lastSeenAt: row.liveLastUsedAt };
  }
  if (row && row.liveCount === 0 && row.lastUsedAt)
    return { state: "disconnected", lastSeenAt: row.lastUsedAt };
  return { state: "waiting", lastSeenAt: null };
}

export async function externalSetups(
  repository: Pick<ExternalAgentCredentialRepository, "presence">,
  agentIds: readonly string[],
  now: number = Date.now(),
): Promise<Map<string, ExternalSetup>> {
  if (agentIds.length === 0) return new Map();
  const rows = new Map((await repository.presence(agentIds)).map((row) => [row.agentId, row]));
  return new Map(agentIds.map((id) => [id, externalSetupFrom(rows.get(id), now)]));
}

export function externalPresenceDisplay(
  scope: { workspaceId: string; agentId: string },
  setup: ExternalSetup,
): AgentDisplaySnapshot {
  const online = setup.state === "online";
  return {
    protocolMajor: 1,
    workspaceId: scope.workspaceId,
    computerId: "",
    agentId: scope.agentId,
    revision: setup.lastSeenAt?.getTime() ?? 0,
    activityKind: online ? "online" : "offline",
    detailKind: "",
    detail: "",
    entries: [],
    expiresAt:
      online && setup.lastSeenAt ? setup.lastSeenAt.getTime() + EXTERNAL_ONLINE_WINDOW_MS : null,
  };
}
