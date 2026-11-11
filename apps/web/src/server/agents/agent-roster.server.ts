import type { PrismaClient } from "#src/generated/prisma/client";
import { agentMascot } from "#src/features/agents/agent-mascot";
import { agentFaceUrl } from "#src/server/apps/app-logo.server";
import { getAgentDisplay } from "#src/server/agents/agent-display.server";
import { getAgentStatusCache } from "#src/server/agents/agent-status.server";
import { manageAgents } from "#src/server/agents/manage-agents-production.server";
import { ACTIVE_AGENT_WHERE, ROSTER_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  visibleAgentWhere,
  type AgentVisibilityViewer,
} from "#src/server/agents/agent-visibility.server";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";

/** The viewer's Agent roster as `listAgents` sends it: each Agent with its mascot, avatar, display
 * and the status its lease holds ("inactive" when nothing has been heard). */
export async function readAgentRoster(db: PrismaClient, userId: string, workspaceId: string) {
  const agents = await manageAgents(db).list({ userId, workspaceId });
  const statuses = getAgentStatusCache();
  // The bots' installation apps, one indexed read for the roster: an app bot's face is its app's
  // logo, which the avatar rows alone cannot resolve.
  const botRows = await db.appInstallationBot
    .findMany({
      where: { agentId: { in: agents.map((agent) => agent.id) } },
      select: {
        agentId: true,
        installation: {
          select: { app: { select: { key: true, ownerWorkspaceId: true, logoObjectKey: true } } },
        },
      },
    })
    .catch(() => []);
  // One round trip for every Agent's status lease, not one per Agent: the list is the page's
  // whole point and every row asks for the same kind of thing. Agents without a Computer have no
  // lease to read, so they are not asked for and stay `undefined` exactly as before.
  const scoped = agents.filter((agent) => agent.computerId);
  const scopes = scoped.map((agent) => ({
    workspaceId,
    computerId: agent.computerId as string,
    agentId: agent.id,
  }));
  // The display read model is script-backed and reads or projects each Agent's own state, so it
  // gets the same treatment: one round trip for the page. A display failure still never hides an
  // Agent profile — it leaves the rows without their display block, all of them together rather
  // than one at a time. The two reads touch different keys, so they go out together.
  const [statusSnapshots, displaySnapshots] = await Promise.all([
    statuses.snapshotMany(scopes),
    getAgentDisplay()
      .snapshotMany(scopes)
      .catch(() => []),
  ]);
  const statusByAgentId = new Map(
    scoped.map((agent, index) => [agent.id, statusSnapshots[index]] as const),
  );
  const botByAgentId = new Map(botRows.map((bot) => [bot.agentId, bot]));
  const displayByAgentId = new Map(
    scoped.map((agent, index) => [agent.id, displaySnapshots[index]] as const),
  );
  return agents.map((agent) => {
    const status = statusByAgentId.get(agent.id);
    const displaySnapshot = displayByAgentId.get(agent.id);
    const mascot = agentMascot(agent.id, agent.avatarMascot);
    return {
      ...agent,
      mascot,
      avatarUrl: agentFaceUrl({
        id: agent.id,
        avatarMascot: agent.avatarMascot,
        appBot: botByAgentId.get(agent.id),
      }),
      stopped: Boolean(agent.stoppedAt),
      ...(displaySnapshot ? { display: displaySnapshot } : {}),
      status: {
        value: status?.status ?? ("inactive" as const),
        expiresAt: status?.expiresAt ?? null,
        ordering: status
          ? {
              daemonInstanceId: status.daemonInstanceId,
              clientSeq: status.clientSeq,
              observedAtMs: status.observedAtMs,
            }
          : null,
      },
    };
  });
}

/** Every live roster Agent's id and Computer in the Workspace, whatever the viewer may see —
 * ids only, so the page knows which Agents may report a status on the shared status channel
 * without learning anything else about them (task #587). */
export async function statusAgentScopes(db: Pick<PrismaClient, "agent">, workspaceId: string) {
  return db.agent.findMany({
    where: { workspaceId, ...ACTIVE_AGENT_WHERE, ...ROSTER_AGENT_WHERE },
    select: { id: true, computerId: true },
  });
}

/** The private Agents `viewer` can see in the Workspace, whose status each has its own channel
 * (`agentStatusChannelForAgent`): only their ids, so the page can learn where those channels stood
 * before it reads them. */
export async function visiblePrivateAgentIds(
  db: Pick<PrismaClient, "agent">,
  workspaceId: string,
  viewer: AgentVisibilityViewer,
) {
  const rows = await db.agent.findMany({
    where: {
      AND: [
        { workspaceId, ...ACTIVE_AGENT_WHERE, visibility: AGENT_VISIBILITY.PRIVATE },
        visibleAgentWhere(viewer),
        ROSTER_AGENT_WHERE,
      ],
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
