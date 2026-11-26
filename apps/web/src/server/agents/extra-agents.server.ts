import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { agentMascot } from "#src/features/agents/agent-mascot";
import { APP_BOT_LOGO_SELECT, agentFaceUrl } from "#src/server/apps/app-logo.server";
import { AGENT_VISIBILITY, normalizeAgentVisibility } from "#src/features/agents/agent-visibility";
import { HELD_AGENT_IDS_LIMIT, type ExtraAgent } from "#src/features/agents/extra-agent";
import { ACTIVE_AGENT_WHERE, ROSTER_AGENT_WHERE } from "./active-agent.server";
import { agentDisplayScope } from "./external-agent-presence.server";
import type { AgentDisplay } from "./agent-display.server";
import {
  viewerCreatorId,
  visibleAgentWhere,
  type AgentVisibilityViewer,
} from "./agent-visibility.server";

export const FULL_EXTRA_DISPLAY_LIMIT = 200;

export type ExtraAgentProjectionRow = {
  id: string;
  name: string;
  displayName: string;
  avatarMascot: string | null;
  visibility: string;
  computerId: string | null;
  hosting?: string;
  appBot?: Parameters<typeof agentFaceUrl>[0]["appBot"];
};

export function selectExtraAgentDisplayScopes<T extends ExtraAgentProjectionRow>(
  workspaceId: string,
  rows: readonly T[],
  busy: readonly { agentId: string }[],
  heldAgentIds: readonly string[],
  fullDisplays: boolean,
) {
  const held = [...new Set(heldAgentIds)].slice(0, HELD_AGENT_IDS_LIMIT);
  const wanted = new Set([...busy.map((scope) => scope.agentId), ...held]);
  if (fullDisplays) {
    let added = 0;
    for (const row of rows) {
      if (added >= FULL_EXTRA_DISPLAY_LIMIT) break;
      if (
        !wanted.has(row.id) &&
        row.computerId &&
        normalizeAgentVisibility(row.visibility) === AGENT_VISIBILITY.PUBLIC
      ) {
        wanted.add(row.id);
        added += 1;
      }
    }
  }
  return rows.flatMap((row) => {
    if (row.hosting !== "external" && !wanted.has(row.id)) return [];
    const scope = agentDisplayScope(workspaceId, row);
    return scope ? [{ row, scope }] : [];
  });
}

export function projectExtraAgentRow(
  row: ExtraAgentProjectionRow,
  display: AgentDisplaySnapshot | undefined,
): ExtraAgent {
  const mascot = agentMascot(row.id, row.avatarMascot);
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    avatarUrl: agentFaceUrl({ id: row.id, avatarMascot: row.avatarMascot, appBot: row.appBot }),
    mascot,
    visibility: normalizeAgentVisibility(row.visibility),
    ...(display ? { display } : {}),
  };
}

export async function listExtraAgents(
  db: Pick<PrismaClient, "agent">,
  displays: Pick<AgentDisplay, "snapshotMany" | "busyScopes">,
  workspaceId: string,
  viewer: AgentVisibilityViewer,
  heldAgentIds: readonly string[] = [],
  fullDisplays = false,
  now = Date.now(),
): Promise<ExtraAgent[]> {
  const [rows, busy] = await Promise.all([
    db.agent.findMany({
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
        hosting: true,
        appBot: APP_BOT_LOGO_SELECT,
      },
      orderBy: { id: "asc" },
    }),
    displays.busyScopes(workspaceId, now).catch(() => []),
  ]);
  const scoped = selectExtraAgentDisplayScopes(workspaceId, rows, busy, heldAgentIds, fullDisplays);
  const snapshots =
    scoped.length === 0
      ? []
      : await displays.snapshotMany(scoped.map(({ scope }) => scope)).catch(() => []);
  const displayById = new Map(scoped.map(({ row }, index) => [row.id, snapshots[index]] as const));
  return rows.map((row) => projectExtraAgentRow(row, displayById.get(row.id)));
}
