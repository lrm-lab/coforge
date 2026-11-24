import type { WorkspaceUserContext } from "#src/features/auth/function-auth";
import {
  aggregateAgentTokenUsageSlices,
  queryWindowStart,
  type AgentTokenUsageRange,
  type AgentTokenUsageReport,
} from "#src/features/agents/agent-token-usage-model";
import { AppError } from "#src/lib/app-error";
import { resolveTimeZone } from "#src/lib/dates";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { getAgentDisplay } from "#src/server/agents/agent-display.server";
import { managedAgentWhere } from "#src/server/agents/agent-visibility.server";
import { PrismaAgentTokenUsageRepository } from "#src/server/db/repositories/agent-token-usage.repositories.server";

export async function loadAgentTokenUsage(
  context: WorkspaceUserContext,
  input: {
    agentId: string;
    range: AgentTokenUsageRange;
    timeZone?: string | null;
  },
): Promise<AgentTokenUsageReport> {
  const { user, db, workspaceId } = context;
  const agent = await db.agent.findFirst({
    where: {
      id: input.agentId,
      ...ACTIVE_AGENT_WHERE,
      hosting: { not: "external" },
      AND: [
        managedAgentWhere({ userId: user.id, workspaceId }),
        { OR: [{ systemKind: null }, { systemKind: { not: "app-bot" } }] },
      ],
    },
    select: {
      id: true,
      computerId: true,
    },
  });
  if (!agent) throw new AppError("NOT_FOUND");

  const now = new Date();
  const timeZone = resolveTimeZone(input.timeZone);
  const since = queryWindowStart(input.range, timeZone, now);
  const repo = new PrismaAgentTokenUsageRepository(db);
  const [slices, trackingStartedAt, display] = await Promise.all([
    repo.aggregateTurnsInRange({
      workspaceId,
      agentId: agent.id,
      since,
      timeZone,
      byHour: input.range === 1,
    }),
    repo.findEarliestRecordedAt({ workspaceId, agentId: agent.id }),
    agent.computerId
      ? getAgentDisplay()
          .snapshot({ workspaceId, computerId: agent.computerId, agentId: agent.id })
          .catch(() => undefined)
      : Promise.resolve(undefined),
  ]);

  return aggregateAgentTokenUsageSlices({
    slices,
    range: input.range,
    timeZone,
    now,
    trackingStartedAt,
    liveContextUsage: display?.contextUsage ?? null,
  });
}
