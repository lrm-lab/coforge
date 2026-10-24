import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";
import { WORKSPACE_ADMIN_ROLES } from "#src/features/workspaces/workspace-roles";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import {
  effectiveAgentServerRole,
  resolveActorServerRole,
} from "#src/server/conversations/channel-authority.server";
import { isElevatedServerRole } from "#src/server/workspaces/member-role.server";

/**
 * Who is asking whether they may see a given Agent: a human Workspace member, or
 * another Agent acting through the Agent CLI/API. Carries what `canSeeAgent` and
 * `visibleAgentWhere` need (plus the acting Agent's own id) — never a full `User`/`Agent` row — so a caller that already
 * authenticated an actor never has to re-fetch one to answer a visibility question.
 *
 * `role` is the viewer's own server role (a human's `WorkspaceMembership.role`, or an Agent's
 * own `Agent.role`) exactly as `resolveActorServerRole` returns it: `undefined` when
 * the actor has no membership/Agent row, and never assumed to be a recognized
 * `WorkspaceMemberRole` — `isElevatedServerRole` fails closed on anything else.
 */
export type AgentVisibilityViewer =
  | { kind: "user"; userId: string; role: string | undefined }
  | { kind: "agent"; agentId: string; ownerId: string; role: string | undefined };

/** The Workspace-member id a private Agent must be owned by for `viewer` to count as its
 * creator: the human's own id, or the acting Agent's own `ownerId` ("same creator"
 * includes the Agent seeing itself). */
export function viewerCreatorId(viewer: AgentVisibilityViewer): string {
  return viewer.kind === "user" ? viewer.userId : viewer.ownerId;
}

/**
 * Build the viewer for a human Workspace member, reusing the same server-role lookup
 * `resolveChannelAuthority` already performs (`resolveActorServerRole`) instead of adding a
 * second `WorkspaceMembership` query.
 */
export async function agentVisibilityViewerForUser(
  db: Pick<PrismaClient, "workspaceMembership" | "agent">,
  workspaceId: string,
  userId: string,
): Promise<AgentVisibilityViewer> {
  const role = await resolveActorServerRole(db, workspaceId, { userId });
  return { kind: "user", userId, role };
}

/**
 * Build the viewer for an Agent principal a caller already resolved — its own id, its
 * `ownerId`, and its server role — never a second `Agent` row query of its own.
 */
export function agentVisibilityViewerForAgent(agent: {
  id: string;
  ownerId: string;
  role: string | undefined;
}): AgentVisibilityViewer {
  return { kind: "agent", agentId: agent.id, ownerId: agent.ownerId, role: agent.role };
}

/**
 * Builds the viewer for a `ChannelActor`-shaped caller (`{ userId }` or `{ agentId }`) — the same
 * actor shape `resolveActorServerRole`/`PublicChannels`/`AgentChannelManagement` already accept.
 * For a human this is exactly `agentVisibilityViewerForUser`'s one membership lookup; for an
 * Agent it is the one row (`ownerId`, `role`) that `resolveActorServerRole` would otherwise fetch
 * anyway (there selecting only `role`), so replacing a `resolveActorServerRole` call with this one
 * never adds a query. An Agent actor that cannot be resolved (deleted, wrong Workspace, or a
 * caller that has not yet been authenticated some other way) fails closed to a viewer that can
 * never match any real `ownerId` and carries no elevated role, the same shape
 * `isElevatedServerRole` already treats as "sees only public Agents".
 */
export async function agentVisibilityViewerForActor(
  db: Pick<PrismaClient, "workspaceMembership" | "agent">,
  workspaceId: string,
  actor: { userId: string } | { agentId: string },
): Promise<AgentVisibilityViewer> {
  if ("userId" in actor) return agentVisibilityViewerForUser(db, workspaceId, actor.userId);
  const agent = await db.agent.findFirst({
    where: { id: actor.agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
    select: { ownerId: true, role: true, systemKind: true },
  });
  return {
    kind: "agent",
    agentId: actor.agentId,
    ownerId: agent?.ownerId ?? "",
    role: agent ? await effectiveAgentServerRole(db, workspaceId, agent) : undefined,
  };
}

/**
 * Pure in-memory check: can `viewer` see `agent`? A public Agent is visible to everyone in the
 * Workspace; anything else — `"private"`, or an unrecognized value, since the column is a plain
 * `String` rather than a database enum — is visible only to its own creator, another Agent
 * sharing that same creator, or a viewer whose own server role is owner/admin.
 * Fails closed the same way `visibleAgentWhere` does, so the two never disagree on a row.
 */
export function canSeeAgent(
  viewer: AgentVisibilityViewer,
  agent: { visibility: string; ownerId: string; systemKind?: string | null },
): boolean {
  if (agent.systemKind === WORKSPACE_ASSISTANT_KIND)
    return viewerCreatorId(viewer) === agent.ownerId;
  if (agent.visibility === AGENT_VISIBILITY.PUBLIC) return true;
  if (isElevatedServerRole(viewer.role)) return true;
  return viewerCreatorId(viewer) === agent.ownerId;
}

/**
 * Whether `userId` may open or send a direct message with `agent` (the "Manage stays
 * independent of see-and-DM" rule). Stricter than `canSeeAgent`: an owner/admin viewer can see
 * and manage another member's private Agent, but a private Agent's direct conversation stays
 * scoped to its own creator, so the elevated-role escape hatch `canSeeAgent` grants does not apply
 * here. Fails closed on an unrecognized visibility value, the same as `canSeeAgent`.
 */
export function canDirectMessageAgent(
  userId: string,
  agent: { visibility: string; ownerId: string },
): boolean {
  return agent.visibility === AGENT_VISIBILITY.PUBLIC || agent.ownerId === userId;
}

/** `canDirectMessageAgent` as a `Prisma.AgentWhereInput` fragment. */
export function directMessageAgentWhere(userId: string): Prisma.AgentWhereInput {
  return { OR: [{ visibility: AGENT_VISIBILITY.PUBLIC }, { ownerId: userId }] };
}

/** Agents whose Workspace files and Reminders `viewer` reads: their own while a member, or, for a
 * Workspace owner/admin, any but another member's platform assistant (`canSeeAgent`). */
export function managedAgentWhere(viewer: {
  userId: string;
  workspaceId: string;
}): Prisma.AgentWhereInput {
  return {
    workspaceId: viewer.workspaceId,
    OR: [
      { ownerId: viewer.userId, workspace: { members: { some: { userId: viewer.userId } } } },
      {
        workspace: {
          members: { some: { userId: viewer.userId, role: { in: [...WORKSPACE_ADMIN_ROLES] } } },
        },
        // A bare `not` would also drop the `null` kind of every ordinary Agent.
        OR: [{ systemKind: null }, { systemKind: { not: WORKSPACE_ASSISTANT_KIND } }],
      },
    ],
  };
}

/**
 * The `Prisma.AgentWhereInput` fragment meant to be composed with `ACTIVE_AGENT_WHERE` (and any
 * other scope) on every Agent list/query: `{}` for an owner/admin-like viewer, since there is
 * nothing to hide from them; otherwise "public, or mine", so a private Agent never appears in a
 * list to anyone else. Must agree with `canSeeAgent` row for row — the unit tests assert exactly
 * that agreement, not just each function in isolation.
 */
export function visibleAgentWhere(viewer: AgentVisibilityViewer): Prisma.AgentWhereInput {
  const assistantScope = {
    OR: [
      { systemKind: null },
      { systemKind: { not: WORKSPACE_ASSISTANT_KIND } },
      { ownerId: viewerCreatorId(viewer) },
    ],
  };
  if (isElevatedServerRole(viewer.role)) return assistantScope;
  return {
    AND: [assistantScope],
    OR: [{ visibility: AGENT_VISIBILITY.PUBLIC }, { ownerId: viewerCreatorId(viewer) }],
  };
}

/**
 * Refuse a lookup aimed at an Agent `viewer` is not allowed to see. Callers that
 * resolve an Agent by id/name/handle call this right after loading the row. The answer names
 * only the fact that the viewer cannot see it (the profile panel says so); it carries none of
 * the Agent's details.
 */
export function assertAgentVisible(
  viewer: AgentVisibilityViewer,
  agent: { visibility: string; ownerId: string; systemKind?: string | null },
): void {
  if (!canSeeAgent(viewer, agent)) throw new AppError("AGENT_NOT_VISIBLE");
}
