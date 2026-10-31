import { APP_GRANT_AGENT_CARD_KIND, type ResolvedActionCardPayload } from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import { humanLabel } from "#src/lib/human-label";
import { canManageAgentAppAccess } from "#src/server/app-agent-access/access-rules.server";
import { roleCan } from "#src/features/workspaces/workspace-roles";
import { isAdminLike } from "#src/server/workspaces/member-role.server";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";
import { ACTIVE_MEMBER_WHERE, VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import { canReadChannel, readableConversationWhere } from "./channel-read-access.server";
import { pageFillActionCardView } from "./action-card-page-fill.server";
import type {
  ActionCardRef,
  ActionCardState,
  ActionCardView,
  ActionCardViewBase,
} from "./action-card-view.server";
import { appRecoverOwnerView } from "./app-recover-owner-action-cards.server";
import { appRegisterView } from "./app-register-action-cards.server";

/** The person's Workspace role, or `undefined` when they are no longer a member. */
export async function safeWorkspaceRole(db: PrismaClient, workspaceId: string, userId: string) {
  try {
    return await workspaceMemberRole(db, workspaceId, userId);
  } catch {
    return undefined;
  }
}

/**
 * Browser-facing views for a page of messages, one batched lookup per page (never per message):
 * every referenced user/Agent/channel/computer, plus the viewer's Workspace role and channel
 * memberships, in one `Promise.all`. Messages without a card are absent from the returned map,
 * and so is a card in a conversation the viewer cannot read (a private channel they are not in, a
 * direct conversation not theirs): the ids come from the browser. Names that no longer resolve (a
 * deleted user, Agent, channel, or computer) render as "unknown".
 */
export async function actionCardViews(
  db: PrismaClient,
  workspaceId: string,
  viewerUserId: string,
  messageIds: string[],
): Promise<Map<string, ActionCardView>> {
  const ids = [...new Set(messageIds)];
  if (!ids.length) return new Map();
  const cards = await db.actionCard.findMany({
    where: {
      workspaceId,
      messageId: { in: ids },
      conversation: {
        ...readableConversationWhere(workspaceId, { userId: viewerUserId }),
        // A direct conversation only its members read; `readableConversationWhere` leaves that here.
        OR: [
          { directKey: null },
          { members: { some: { userId: viewerUserId, ...ACTIVE_MEMBER_WHERE } } },
        ],
      },
    },
    select: {
      messageId: true,
      kind: true,
      payload: true,
      draftHint: true,
      state: true,
      committedByUserId: true,
      committedAt: true,
      result: true,
      preparedByAgent: { select: { ownerId: true } },
    },
  });
  if (!cards.length) return new Map();

  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  const channelIds = new Set<string>();
  const computerIds = new Set<string>();
  for (const card of cards) {
    const payload = card.payload as ResolvedActionCardPayload;
    if (payload.type === "channel:create") {
      for (const id of payload.initialHumanIds ?? []) userIds.add(id);
      for (const id of payload.initialAgentIds ?? []) agentIds.add(id);
    } else if (payload.type === "agent:create") {
      if (payload.suggestedComputerId) computerIds.add(payload.suggestedComputerId);
      if (payload.requiredComputerId) computerIds.add(payload.requiredComputerId);
    } else if (payload.type === "channel:add_member") {
      channelIds.add(payload.channelId);
      for (const id of payload.humanIds ?? []) userIds.add(id);
      for (const id of payload.agentIds ?? []) agentIds.add(id);
    }
    if (card.committedByUserId) userIds.add(card.committedByUserId);
  }

  const [users, agents, channels, computers, viewerRole, viewerChannelMemberships] =
    await Promise.all([
      userIds.size
        ? db.user.findMany({
            where: { id: { in: [...userIds] } },
            select: { id: true, username: true, displayName: true },
          })
        : Promise.resolve([]),
      agentIds.size
        ? db.agent.findMany({
            where: { id: { in: [...agentIds] } },
            select: { id: true, name: true, displayName: true },
          })
        : Promise.resolve([]),
      channelIds.size
        ? db.conversation.findMany({
            // A channel hidden from the Workspace is named on no card.
            where: { id: { in: [...channelIds] }, ...VISIBLE_CONVERSATION_WHERE },
            select: { id: true, channelName: true, visibility: true },
          })
        : Promise.resolve([]),
      computerIds.size
        ? db.computer.findMany({
            where: { id: { in: [...computerIds] } },
            select: { id: true, name: true, displayName: true },
          })
        : Promise.resolve([]),
      safeWorkspaceRole(db, workspaceId, viewerUserId),
      channelIds.size
        ? db.conversationMember.findMany({
            where: { conversationId: { in: [...channelIds] }, userId: viewerUserId },
            select: { conversationId: true, leftAt: true },
          })
        : Promise.resolve([]),
    ]);

  const userName = new Map(users.map((u) => [u.id, humanLabel(u)]));
  const agentName = new Map(agents.map((a) => [a.id, a.displayName?.trim() || a.name]));
  const viewerInChannel = new Set(
    viewerChannelMemberships.flatMap((m) => (m.leftAt === null ? [m.conversationId] : [])),
  );
  // A private channel is named only to those in it; to anyone else it is unknown, as a missing
  // one is (task #302).
  const channelName = new Map(
    channels.flatMap((c) =>
      canReadChannel(c, viewerInChannel.has(c.id)) ? [[c.id, c.channelName ?? "unknown"]] : [],
    ),
  );
  const computerName = new Map(
    computers.map((c) => [c.id, c.displayName?.trim() || c.name || "unknown"]),
  );
  const viewerChannelIds = new Set(viewerChannelMemberships.map((m) => m.conversationId));
  const isAdminViewer = viewerRole ? isAdminLike(viewerRole) : false;
  const ref = (id: string, names: Map<string, string>): ActionCardRef => ({
    id,
    displayName: names.get(id) ?? "unknown",
  });

  const views = new Map<string, ActionCardView>();
  for (const card of cards) {
    const payload = card.payload as ResolvedActionCardPayload;
    const state = card.state as ActionCardState;
    const pending = state === "pending";
    const base: ActionCardViewBase = {
      messageId: card.messageId,
      state,
      draftHint: card.draftHint ?? undefined,
      committedBy: card.committedByUserId
        ? { displayName: userName.get(card.committedByUserId) ?? "unknown" }
        : undefined,
      committedAt: card.committedAt?.toISOString(),
      canCommit: false,
      canCancel: pending && (card.preparedByAgent.ownerId === viewerUserId || isAdminViewer),
    };
    if (payload.type === "channel:create") {
      views.set(card.messageId, {
        ...base,
        kind: "channel:create",
        name: payload.name,
        visibility: payload.visibility,
        description: payload.description,
        initialHumans: (payload.initialHumanIds ?? []).map((id) => ref(id, userName)),
        initialAgents: (payload.initialAgentIds ?? []).map((id) => ref(id, agentName)),
        canCommit: pending,
        result: card.result as { channelId: string } | undefined,
      });
    } else if (payload.type === "agent:create") {
      views.set(card.messageId, {
        ...base,
        kind: "agent:create",
        name: payload.name,
        description: payload.description,
        suggestedComputer: payload.suggestedComputerId
          ? ref(payload.suggestedComputerId, computerName)
          : undefined,
        requiredComputer: payload.requiredComputerId
          ? ref(payload.requiredComputerId, computerName)
          : undefined,
        canCommit: pending && isAdminViewer,
        result: card.result as { agentId: string } | undefined,
      });
    } else if (payload.type === APP_GRANT_AGENT_CARD_KIND) {
      // Managing the Agent's app access, by the server's rule.
      const canManage =
        pending &&
        canManageAgentAppAccess({ userId: viewerUserId, role: viewerRole }, card.preparedByAgent);
      views.set(card.messageId, {
        ...base,
        kind: APP_GRANT_AGENT_CARD_KIND,
        app: { key: payload.appKey, name: payload.appName },
        scopes: payload.scopes,
        canCommit: canManage,
        canCancel: canManage,
        result: card.result as { requestId: string } | undefined,
      });
    } else if (payload.type === "app:register") {
      views.set(card.messageId, {
        ...base,
        kind: "app:register",
        app: appRegisterView(payload),
        // The registry's rule: a Workspace owner or admin registers apps.
        canCommit: pending && roleCan(viewerRole, "manageApps"),
        result: card.result as { clientKey: string; noOwnerAgent?: boolean } | undefined,
      });
    } else if (payload.type === "page:fill") {
      views.set(card.messageId, pageFillActionCardView(base, card, payload, viewerUserId, pending));
    } else if (payload.type === "app:recover_owner") {
      views.set(card.messageId, {
        ...base,
        kind: "app:recover_owner",
        ...appRecoverOwnerView(payload),
        // The same role as registering an app.
        canCommit: pending && roleCan(viewerRole, "manageApps"),
        result: card.result as { clientKey: string; ownerAgent: string } | undefined,
      });
    } else {
      views.set(card.messageId, {
        ...base,
        kind: "channel:add_member",
        channel: ref(payload.channelId, channelName),
        humans: (payload.humanIds ?? []).map((id) => ref(id, userName)),
        agents: (payload.agentIds ?? []).map((id) => ref(id, agentName)),
        canCommit: pending && viewerChannelIds.has(payload.channelId),
        result: card.result as
          | { channelId: string; userIds: string[]; agentIds: string[] }
          | undefined,
      });
    }
  }
  return views;
}
