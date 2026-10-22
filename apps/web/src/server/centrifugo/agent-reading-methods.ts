import { AGENT_CONTEXT_USAGE_METHOD, AGENT_SERVICE_TIER_METHOD } from "@lrm/coforge-sdk/internal";
import type { AgentControlStore } from "#src/server/agents/agent-control.server";
import type { AgentDisplay } from "#src/server/agents/agent-display.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { createAgentContextUsageMethod } from "./agent-context-usage-receiver.server";
import { createAgentServiceTierMethod } from "./agent-service-tier-receiver.server";
import type { CentrifugoServerApi } from "./server-api.server";

/** The Agent's current visibility, read fresh (no cache); `undefined` fails the push closed. */
export type AgentVisibilityLookup = (
  workspaceId: string,
  agentId: string,
) => Promise<string | undefined>;

/**
 * The two per-launch observation receivers, wired once: both are fire-and-forget display facts
 * gated by the same daemon principal, launch fence and visibility lookup, so they differ only in
 * the method name and the display field they write.
 */
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
  return {
    [AGENT_CONTEXT_USAGE_METHOD]: createAgentContextUsageMethod(
      agents,
      display,
      events,
      agentVisibility,
    ),
    [AGENT_SERVICE_TIER_METHOD]: createAgentServiceTierMethod(
      agents,
      display,
      events,
      agentVisibility,
    ),
  };
}
