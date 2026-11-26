import type { ChannelActor } from "#src/server/conversations/channel-actor.server";
import { visibleChannelWhere } from "#src/server/conversations/channel-read-access.server";
import { agentChannelReader } from "./workspace-assistant-authority.server";
import type {
  AgentUserInfo,
  AgentUserInfoMembership,
  AgentUserInfoResponse,
  AgentUserStatus,
} from "@lrm/coforge-sdk/agent";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { humanLabel } from "#src/lib/human-label";
import {
  accountTimeZoneSelection,
  resolveAccountTimeZone,
} from "#src/server/db/repositories/user-preferences.repositories.server";
import { agentDisplay } from "#src/features/agents/agent-status-display";
import { getAgentDisplay } from "./agent-display.server";
import { externalSetups, type ExternalSetup } from "./external-agent-presence.server";
import { readExternalPresence } from "#src/server/db/repositories/external-agent-credential.repositories.server";
import {
  agentVisibilityViewerForActor,
  canSeeAgent,
  type AgentVisibilityViewer,
} from "./agent-visibility.server";

export type AgentUserInfoErrorBody =
  | { ok: false; errorCode: "user_not_found"; error: string }
  | { ok: false; errorCode: "agent_not_visible"; error: string };

export type AgentUserInfoOutcome =
  | { status: 200; body: AgentUserInfoResponse }
  | { status: 404; body: AgentUserInfoErrorBody };

export const AGENT_NOT_VISIBLE = "agent-not-visible" as const;

export async function resolveAgentStatus(
  workspaceId: string,
  agent: ExternalAwareAgent,
  external?: ExternalPresenceReader,
): Promise<{ status: AgentUserStatus; availability?: string }> {
  const [only] = await resolveAgentStatuses(workspaceId, [agent], external);
  return only;
}

export async function resolveAgentStatuses(
  workspaceId: string,
  agents: ReadonlyArray<ExternalAwareAgent>,
  external?: ExternalPresenceReader,
): Promise<Array<{ status: AgentUserStatus; availability?: string }>> {
  const externalIds = external
    ? agents.filter((agent) => agent.hosting === "external").map((agent) => agent.id)
    : [];
  const [setups, displayed] = await Promise.all([
    external
      ? externalSetups(external, externalIds).catch(() => new Map<string, ExternalSetup>())
      : new Map<string, ExternalSetup>(),
    resolveDisplayedStatuses(workspaceId, agents),
  ]);
  return agents.map((agent, index) => {
    const setup = setups.get(agent.id);
    if (setup)
      return { status: setup.state === "online" ? ("online" as const) : ("offline" as const) };
    return displayed[index]!;
  });
}

type ExternalAwareAgent = {
  id: string;
  computerId: string | null;
  stoppedAt: Date | null;
  hosting?: string;
};

export function externalPresenceOf(db: Pick<PrismaClient, "$queryRaw">): ExternalPresenceReader {
  return { presence: (agentIds) => readExternalPresence(db, agentIds) };
}

type ExternalPresenceReader = Parameters<typeof externalSetups>[0];

async function resolveDisplayedStatuses(
  workspaceId: string,
  agents: ReadonlyArray<ExternalAwareAgent>,
): Promise<Array<{ status: AgentUserStatus; availability?: string }>> {
  const scoped = agents.filter((agent) => agent.computerId);
  if (scoped.length === 0) return agents.map(() => ({ status: "unknown" as const }));
  type Snapshot = Awaited<ReturnType<ReturnType<typeof getAgentDisplay>["snapshot"]>>;
  const scopeOf = (agent: { computerId: string | null; id: string }) => ({
    workspaceId,
    computerId: agent.computerId as string,
    agentId: agent.id,
  });
  let snapshotByAgentId = new Map<string, Snapshot | undefined>();
  try {
    const snapshots = await getAgentDisplay().snapshotMany(scoped.map(scopeOf));
    snapshotByAgentId = new Map(
      scoped.map((agent, index) => [agent.id, snapshots[index]] as const),
    );
  } catch {
    snapshotByAgentId = new Map(
      await Promise.all(
        scoped.map(async (agent) => {
          try {
            return [agent.id, await getAgentDisplay().snapshot(scopeOf(agent))] as const;
          } catch {
            return [agent.id, undefined] as const;
          }
        }),
      ),
    );
  }
  return agents.map((agent) =>
    statusFromDisplay(snapshotByAgentId.get(agent.id), Boolean(agent.stoppedAt)),
  );
}

function statusFromDisplay(
  snapshot: Awaited<ReturnType<ReturnType<typeof getAgentDisplay>["snapshot"]>> | undefined,
  stopped: boolean,
): { status: AgentUserStatus; availability?: string } {
  const display = agentDisplay(snapshot, { stopped });
  const status: AgentUserStatus =
    display.kind === "unknown" ? "unknown" : display.isOnline ? "online" : "offline";
  return { status, ...(display.statusDetail ? { availability: display.statusDetail } : {}) };
}

export type ResolvedWorkspaceUser =
  | {
      kind: "human";
      timeZone?: string;
      id: string;
      name: string;
      displayName: string;
      description: string;
      role: string | null;
    }
  | {
      kind: "agent";
      id: string;
      name: string;
      displayName: string;
      description: string;
      role: string | null;
      computerId: string | null;
      hosting: string;
      computerName?: string;
      stoppedAt: Date | null;
      ownerId: string;
    };

export async function findWorkspaceUser(
  db: PrismaClient,
  workspaceId: string,
  name: string,
  viewer: AgentVisibilityViewer,
  options?: { includeTimeZone: boolean },
): Promise<ResolvedWorkspaceUser | typeof AGENT_NOT_VISIBLE | undefined> {
  const agent = await db.agent.findFirst({
    where: { workspaceId, name, ...ACTIVE_AGENT_WHERE },
    select: {
      id: true,
      name: true,
      displayName: true,
      description: true,
      role: true,
      computerId: true,
      hosting: true,
      stoppedAt: true,
      ownerId: true,
      visibility: true,
      systemKind: true,
      computer: { select: { name: true, displayName: true } },
    },
  });
  if (agent) {
    if (!canSeeAgent(viewer, agent)) return AGENT_NOT_VISIBLE;
    const computerName = agent.computer?.displayName.trim() || agent.computer?.name.trim();
    return {
      kind: "agent",
      id: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      role: agent.role,
      computerId: agent.computerId,
      hosting: agent.hosting,
      stoppedAt: agent.stoppedAt,
      ownerId: agent.ownerId,
      ...(computerName ? { computerName } : {}),
    };
  }
  const membership = await db.workspaceMembership.findFirst({
    where: { workspaceId, user: { username: name } },
    select: {
      role: true,
      user: {
        select: {
          id: true,
          username: true,
          displayName: true,
          description: true,
          preferences: options?.includeTimeZone ? accountTimeZoneSelection : false,
        },
      },
    },
  });
  if (!membership) return undefined;
  return {
    kind: "human",
    id: membership.user.id,
    name: membership.user.username,
    displayName: humanLabel(membership.user),
    description: membership.user.description,
    role: membership.role,
    timeZone: resolveAccountTimeZone(membership.user.preferences),
  };
}

async function targetChannelMemberships(
  db: PrismaClient,
  workspaceId: string,
  reader: ChannelActor,
  target: { kind: "human" | "agent"; id: string },
): Promise<AgentUserInfoMembership[]> {
  const conversations = await db.conversation.findMany({
    where: {
      ...visibleChannelWhere(workspaceId, reader),
      archivedAt: null,
      members: {
        some:
          target.kind === "agent"
            ? { agentId: target.id, leftAt: null }
            : { userId: target.id, leftAt: null },
      },
    },
    orderBy: { channelName: "asc" },
    select: {
      channelName: true,
      members: {
        where:
          target.kind === "agent"
            ? { agentId: target.id, leftAt: null }
            : { userId: target.id, leftAt: null },
        select: { channelRole: true },
      },
    },
  });
  const memberships: AgentUserInfoMembership[] = [];
  for (const conversation of conversations) {
    const membership = conversation.members[0];
    if (!membership || !conversation.channelName) continue;
    memberships.push({ channel: `#${conversation.channelName}`, role: membership.channelRole });
  }
  return memberships;
}

export async function resolveAgentUserInfo(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
  name: string,
): Promise<AgentUserInfoOutcome> {
  const [viewer, reader] = await Promise.all([
    agentVisibilityViewerForActor(db, principal.workspaceId, { agentId: principal.agentId }),
    agentChannelReader(db, principal.workspaceId, principal.agentId),
  ]);
  const target = await findWorkspaceUser(db, principal.workspaceId, name, viewer, {
    includeTimeZone: true,
  });
  if (target === AGENT_NOT_VISIBLE)
    return {
      status: 404,
      body: {
        ok: false,
        errorCode: "agent_not_visible",
        error: `@${name} is not visible to you.`,
      },
    };
  if (!target)
    return {
      status: 404,
      body: {
        ok: false,
        errorCode: "user_not_found",
        error: `User not found or not visible: @${name}`,
      },
    };
  const membershipsRead = targetChannelMemberships(db, principal.workspaceId, reader, {
    kind: target.kind,
    id: target.id,
  });
  if (target.kind === "human") {
    const memberships = await membershipsRead;
    const user: AgentUserInfo = {
      kind: "human",
      id: target.id,
      name: target.name,
      displayName: target.displayName,
      description: target.description,
      role: target.role,
      isSelf: false,
      timeZone: target.timeZone,
    };
    return { status: 200, body: { ok: true, user, memberships } };
  }
  const [memberships, { status, availability }] = await Promise.all([
    membershipsRead,
    resolveAgentStatus(
      principal.workspaceId,
      {
        id: target.id,
        computerId: target.computerId,
        stoppedAt: target.stoppedAt,
        hosting: target.hosting,
      },
      externalPresenceOf(db),
    ),
  ]);
  const user: AgentUserInfo = {
    kind: "agent",
    id: target.id,
    name: target.name,
    displayName: target.displayName,
    description: target.description,
    role: target.role,
    isSelf: target.id === principal.agentId,
    ...(target.computerName ? { computerName: target.computerName } : {}),
    status,
    ...(availability ? { availability } : {}),
  };
  return { status: 200, body: { ok: true, user, memberships } };
}
