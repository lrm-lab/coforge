import type { PrismaClient } from "#src/generated/prisma/client";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import {
  agentStatusChannelFor,
  publishAgentDisplay,
} from "#src/features/agents/agent-status-channel";
import { AGENT_VISIBILITY, normalizeAgentVisibility } from "#src/features/agents/agent-visibility";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { readExternalPresence } from "#src/server/db/repositories/external-agent-credential.repositories.server";
import { errorType } from "#src/server/errors/error-type.server";
import { getAgentDisplay, type AgentDisplay } from "./agent-display.server";
import { EXTERNAL_ONLINE_WINDOW_MS, externalDisplayScope } from "./external-agent-presence.server";

export type ExternalDisplayPorts = {
  display: Pick<AgentDisplay, "observeExternalPresence" | "observeExternalStatus">;
  publishJson(channel: string, data: unknown): Promise<void>;
  visibility(workspaceId: string, agentId: string): Promise<string | undefined>;
};

export type ExternalAgentRef = { workspaceId: string; agentId: string };

export async function publishExternalDisplay(
  ports: Pick<ExternalDisplayPorts, "publishJson" | "visibility">,
  snapshot: AgentDisplaySnapshot,
): Promise<void> {
  const visibility = await ports.visibility(snapshot.workspaceId, snapshot.agentId);
  if (visibility === undefined) return;
  await publishAgentDisplay(
    ports.publishJson,
    agentStatusChannelFor(snapshot.workspaceId, snapshot.agentId, visibility),
    snapshot,
    visibility !== AGENT_VISIBILITY.PUBLIC,
  );
}

export async function noteExternalSeen(
  ports: ExternalDisplayPorts,
  agent: ExternalAgentRef,
  seenAtMs: number,
): Promise<void> {
  const snapshot = await ports.display.observeExternalPresence(
    externalDisplayScope(agent.workspaceId, agent.agentId),
    { seenAtMs, windowMs: EXTERNAL_ONLINE_WINDOW_MS },
  );
  if (snapshot) await publishExternalDisplay(ports, snapshot);
}

export async function syncExternalPresence(
  ports: ExternalDisplayPorts,
  presence: (agentIds: readonly string[]) => Promise<{ liveLastUsedAt: Date | null }[]>,
  agent: ExternalAgentRef,
): Promise<void> {
  const [row] = await presence([agent.agentId]);
  await noteExternalSeen(ports, agent, row?.liveLastUsedAt?.getTime() ?? 0);
}

export function productionExternalDisplayPorts(
  db: Pick<PrismaClient, "agent">,
): ExternalDisplayPorts {
  const centrifugo = createCentrifugoServerApi();
  return {
    display: getAgentDisplay(),
    publishJson: (channel, data) => centrifugo.publishJson(channel, data),
    visibility: async (workspaceId, agentId) => {
      const agent = await db.agent.findFirst({
        where: { id: agentId, workspaceId },
        select: { visibility: true },
      });
      return agent ? normalizeAgentVisibility(agent.visibility) : undefined;
    },
  };
}

function logFailure(event: string, agent: ExternalAgentRef, cause: unknown): void {
  console.warn(
    JSON.stringify({
      event,
      workspace_id: agent.workspaceId,
      agent_id: agent.agentId,
      error_type: errorType(cause),
    }),
  );
}

export function externalSeenNoter(
  db: Pick<PrismaClient, "agent">,
): (agent: ExternalAgentRef, seenAtMs: number) => Promise<void> {
  return async (agent, seenAtMs) => {
    try {
      await noteExternalSeen(productionExternalDisplayPorts(db), agent, seenAtMs);
    } catch (cause) {
      logFailure("external_agent.presence_seen_failed", agent, cause);
    }
  };
}

export async function syncExternalPresenceBestEffort(
  db: Pick<PrismaClient, "agent" | "$queryRaw">,
  agent: ExternalAgentRef,
): Promise<void> {
  try {
    await syncExternalPresence(
      productionExternalDisplayPorts(db),
      (agentIds) => readExternalPresence(db, agentIds),
      agent,
    );
  } catch (cause) {
    logFailure("external_agent.presence_sync_failed", agent, cause);
  }
}
