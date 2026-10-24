import type { PrismaClient } from "#src/generated/prisma/client";
import { agentAvatarUrl, agentMascot } from "#src/features/agents/agent-mascot";
import { normalizeAgentVisibility } from "#src/features/agents/agent-visibility";
import type { ExtraAgent } from "#src/features/agents/extra-agent";
import { ACTIVE_AGENT_WHERE, ROSTER_AGENT_WHERE } from "./active-agent.server";
import type { AgentDisplay } from "./agent-display.server";
import {
  viewerCreatorId,
  visibleAgentWhere,
  type AgentVisibilityViewer,
} from "./agent-visibility.server";

/**
 * Every Agent `viewer` may see beyond their own roster (`ManageAgents.list`): the Members
 * directory's rule (live roster Agents under `visibleAgentWhere`, an app's bot left out) minus the
 * Agents the viewer owns, so the two never disagree. The app shell keeps these live beside the
 * roster from the same status publications. Each Agent with a Computer brings its display, read
 * for all of them in one batch; a failed read leaves the rows without one rather than failing the
 * list, as `listAgents` does, and the browser's next refresh asks again.
 */
export async function listExtraAgents(
  db: Pick<PrismaClient, "agent">,
  displays: Pick<AgentDisplay, "snapshotMany">,
  workspaceId: string,
  viewer: AgentVisibilityViewer,
): Promise<ExtraAgent[]> {
  const rows = await db.agent.findMany({
    where: {
      AND: [
        {
          workspaceId,
          ...ACTIVE_AGENT_WHERE,
          ownerId: { not: viewerCreatorId(viewer) },
          ...visibleAgentWhere(viewer),
        },
        ROSTER_AGENT_WHERE,
      ],
    },
    select: {
      id: true,
      name: true,
      displayName: true,
      avatarMascot: true,
      visibility: true,
      computerId: true,
    },
    orderBy: { id: "asc" },
  });
  const scoped = rows.flatMap((row) =>
    row.computerId ? [{ row, computerId: row.computerId }] : [],
  );
  const snapshots =
    scoped.length === 0
      ? []
      : await displays
          .snapshotMany(
            scoped.map(({ row, computerId }) => ({ workspaceId, computerId, agentId: row.id })),
          )
          .catch(() => []);
  const displayById = new Map(scoped.map(({ row }, index) => [row.id, snapshots[index]] as const));
  return rows.map((row) => {
    const mascot = agentMascot(row.id, row.avatarMascot);
    const display = displayById.get(row.id);
    return {
      id: row.id,
      name: row.name,
      displayName: row.displayName,
      avatarUrl: agentAvatarUrl(row.id, mascot),
      mascot,
      visibility: normalizeAgentVisibility(row.visibility),
      ...(display ? { display } : {}),
    };
  });
}
