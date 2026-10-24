import type { PrismaClient } from "#src/generated/prisma/client";
import { agentAvatarUrl, agentMascot } from "#src/features/agents/agent-mascot";
import { normalizeAgentVisibility } from "#src/features/agents/agent-visibility";
import { HELD_AGENT_IDS_LIMIT, type ExtraAgent } from "#src/features/agents/extra-agent";
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
 * roster from the same status publications. Only the Agents that are busy now bring a display, and
 * so do the `heldAgentIds` the browser still shows busy (or lapsed), which comes back as their real,
 * idle snapshot and so clears; both are read in one batch and always intersected with the visible
 * rows, so the cost follows the busy Agents and the ids can never read what the viewer may not see.
 * A failed read leaves the rows without a display rather than failing the list, as `listAgents`
 * does, and the browser's next refresh asks again.
 */
export async function listExtraAgents(
  db: Pick<PrismaClient, "agent">,
  displays: Pick<AgentDisplay, "snapshotMany" | "busyScopes">,
  workspaceId: string,
  viewer: AgentVisibilityViewer,
  heldAgentIds: readonly string[] = [],
  now = Date.now(),
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
  const busy = await displays.busyScopes(workspaceId, now).catch(() => []);
  const held = [...new Set(heldAgentIds)].slice(0, HELD_AGENT_IDS_LIMIT);
  const wanted = new Set([...busy.map((scope) => scope.agentId), ...held]);
  const scoped = rows.flatMap((row) =>
    row.computerId && wanted.has(row.id) ? [{ row, computerId: row.computerId }] : [],
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
