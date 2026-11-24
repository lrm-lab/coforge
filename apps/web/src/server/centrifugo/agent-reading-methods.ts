import {
  AGENT_CONTEXT_USAGE_METHOD,
  AGENT_SERVICE_TIER_METHOD,
  AGENT_TOKEN_USAGE_METHOD,
} from "@lrm/coforge-sdk/internal";
import type { AgentControlStore } from "#src/server/agents/agent-control.server";
import type { AgentDisplay } from "#src/server/agents/agent-display.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaAgentTokenUsageRepository } from "#src/server/db/repositories/agent-token-usage.repositories.server";
import { createAgentContextUsageMethod } from "./agent-context-usage-receiver.server";
import { createAgentServiceTierMethod } from "./agent-service-tier-receiver.server";
import { createAgentTokenUsageMethod } from "./agent-token-usage-receiver.server";
import type { CentrifugoServerApi } from "./server-api.server";

export type AgentVisibilityLookup = (
  workspaceId: string,
  agentId: string,
) => Promise<string | undefined>;

export function agentReadingMethods(options: {
  agents: Pick<AgentControlStore, "get">;
  display: Pick<AgentDisplay, "putContextUsage" | "putServiceTier">;
  events: Pick<CentrifugoServerApi, "publishJson">;
  db: PrismaClient;
}) {
  const { agents, display, events, db } = options;
  const agentVisibility: AgentVisibilityLookup = async (workspaceId, agentId) => {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { workspaceId: true, visibility: true },
    });
    return agent?.workspaceId === workspaceId ? agent.visibility : undefined;
  };
  const tokenUsageAgentLookup = {
    get: async (agentId: string) => {
      const agent = await db.agent.findUnique({
        where: { id: agentId },
        select: { workspaceId: true, computerId: true },
      });
      return agent ?? undefined;
    },
  };
  return {
    [AGENT_CONTEXT_USAGE_METHOD]: createAgentContextUsageMethod(
      agents,
      display,
      events,
      agentVisibility,
    ),
    [AGENT_TOKEN_USAGE_METHOD]: createAgentTokenUsageMethod(
      tokenUsageAgentLookup,
      new PrismaAgentTokenUsageRepository(db),
    ),
    [AGENT_SERVICE_TIER_METHOD]: createAgentServiceTierMethod(
      agents,
      display,
      events,
      agentVisibility,
    ),
  };
}
