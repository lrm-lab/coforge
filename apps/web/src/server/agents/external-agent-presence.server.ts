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

export function externalDisplayScope(workspaceId: string, agentId: string) {
  return { workspaceId, computerId: "", agentId };
}

export function agentDisplayScope(
  workspaceId: string,
  agent: { id: string; computerId?: string | null; hosting?: string },
) {
  if (agent.hosting === "external") return externalDisplayScope(workspaceId, agent.id);
  return agent.computerId
    ? { workspaceId, computerId: agent.computerId, agentId: agent.id }
    : undefined;
}
