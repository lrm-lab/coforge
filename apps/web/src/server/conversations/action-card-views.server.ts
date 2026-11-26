import {
  APP_GRANT_AGENT_CARD_KIND,
  CHOICE_ANYONE_TARGET,
  type ResolvedActionCardPayload,
} from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import { humanLabel } from "#src/lib/human-label";
import { APP_BOT_LOGO_SELECT, agentFaceUrl } from "#src/server/apps/app-logo.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { canManageAgentAppAccess } from "#src/server/app-agent-access/access-rules.server";
import { roleCan } from "#src/features/workspaces/workspace-roles";
import { isAdminLike } from "#src/server/workspaces/member-role.server";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";
import { ACTIVE_MEMBER_WHERE, VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import { canReadChannel, readableConversationWhere } from "./channel-read-access.server";
import { pageFillActionCardView } from "./action-card-page-fill.server";
import { desktopTakeoverActionCardView } from "./action-card-desktop-takeover.server";
import { choiceActionCardView } from "./action-card-choice.server";
import { questionsActionCardView } from "./action-card-questions.server";
import {
  effectiveActionCardState,
  type ActionCardPersonRef,
  type ActionCardRef,
  type ActionCardView,
  type ActionCardViewBase,
} from "./action-card-view.server";
import { appRecoverOwnerView } from "./app-recover-owner-action-cards.server";
import { appRegisterView } from "./app-register-action-cards.server";
import { previewCardOf } from "./action-card-preview.server";

export async function safeWorkspaceRole(db: PrismaClient, workspaceId: string, userId: string) {
  try {
    return await workspaceMemberRole(db, workspaceId, userId);
  } catch {
    return undefined;
  }
}

export type ActionCardViewsOptions = {
  authorizedConversationId?: string;
};

export async function actionCardViews(
  db: PrismaClient,
  workspaceId: string,
  viewerUserId: string,
  messageIds: string[],
  options?: ActionCardViewsOptions,
): Promise<Map<string, ActionCardView>> {
  const ids = [...new Set(messageIds)];
  if (!ids.length) return new Map();
  const cards = await db.actionCard.findMany({
    where: options?.authorizedConversationId
      ? {
          workspaceId,
          conversationId: options.authorizedConversationId,
          messageId: { in: ids },
        }
      : {
          workspaceId,
          messageId: { in: ids },
          conversation: {
            ...readableConversationWhere(workspaceId, { userId: viewerUserId }),
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
      expiresAt: true,
      committedByUserId: true,
      committedAt: true,
      result: true,
      preparedByAgentId: true,
    },
  });
  if (!cards.length) return new Map();

  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  const channelIds = new Set<string>();
  const computerIds = new Set<string>();
  const preparedByAgentIds = new Set<string>();
  for (const card of cards) {
    preparedByAgentIds.add(card.preparedByAgentId);
    const payload = card.payload as ResolvedActionCardPayload;
    if (payload.type === "channel:create") {
      const created = card.result as { channelId?: string } | null;
      if (created?.channelId) channelIds.add(created.channelId);
      for (const id of payload.initialHumanIds ?? []) userIds.add(id);
      for (const id of payload.initialAgentIds ?? []) agentIds.add(id);
    } else if (payload.type === "agent:create") {
      if (payload.suggestedComputerId) computerIds.add(payload.suggestedComputerId);
      if (payload.requiredComputerId) computerIds.add(payload.requiredComputerId);
    } else if (payload.type === "channel:add_member") {
      channelIds.add(payload.channelId);
      for (const id of payload.humanIds ?? []) userIds.add(id);
      for (const id of payload.agentIds ?? []) agentIds.add(id);
    } else if (
      (payload.type === "choice" || payload.type === "questions") &&
      payload.to &&
      payload.to !== CHOICE_ANYONE_TARGET
    ) {
      userIds.add(payload.to);
    }
    if (card.committedByUserId) userIds.add(card.committedByUserId);
  }

  const [users, agents, preparedAgents, channels, computers, viewerRole, viewerChannelMemberships] =
    await Promise.all([
      userIds.size
        ? db.user.findMany({
            where: { id: { in: [...userIds] } },
            select: { id: true, username: true, displayName: true, avatarObjectKey: true },
          })
        : Promise.resolve([]),
      agentIds.size
        ? db.agent.findMany({
            where: { id: { in: [...agentIds] } },
            select: {
              id: true,
              name: true,
              displayName: true,
              avatarMascot: true,
              appBot: APP_BOT_LOGO_SELECT,
            },
          })
        : Promise.resolve([]),
      preparedByAgentIds.size
        ? db.agent.findMany({
            where: { id: { in: [...preparedByAgentIds] } },
            select: { id: true, ownerId: true },
          })
        : Promise.resolve([]),
      channelIds.size
        ? db.conversation.findMany({
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
  const preparedOwnerByAgentId = new Map(preparedAgents.map((a) => [a.id, a.ownerId]));
  const userAvatar = new Map(
    users.map((u) => [u.id, workspaceUserAvatarUrl(workspaceId, u.id, u.avatarObjectKey)]),
  );
  const agentAvatar = new Map(agents.map((a) => [a.id, agentFaceUrl(a)]));
  const viewerInChannel = new Set(
    viewerChannelMemberships.flatMap((m) => (m.leftAt === null ? [m.conversationId] : [])),
  );
  const channelName = new Map(
    channels
      .filter((c) => canReadChannel(c, viewerInChannel.has(c.id)))
      .map((c) => [c.id, c.channelName ?? "unknown"]),
  );
  const readableResult = <Result extends { channelId: string }>(result: unknown) =>
    result && channelName.has((result as Result).channelId) ? (result as Result) : undefined;
  const computerName = new Map(
    computers.map((c) => [c.id, c.displayName?.trim() || c.name || "unknown"]),
  );
  const isAdminViewer = viewerRole ? isAdminLike(viewerRole) : false;
  const ref = (id: string, names: Map<string, string>): ActionCardRef => ({
    id,
    displayName: names.get(id) ?? "unknown",
  });
  const human = (id: string): ActionCardPersonRef => ({
    ...ref(id, userName),
    avatarUrl: userAvatar.get(id) ?? null,
  });
  const agent = (id: string): ActionCardPersonRef => ({
    ...ref(id, agentName),
    avatarUrl: agentAvatar.get(id) ?? null,
  });

  const userPerson = (id: string): ActionCardPersonRef | undefined =>
    userName.has(id) ? human(id) : undefined;

  const views = new Map<string, ActionCardView>();
  for (const card of cards) {
    const payload = card.payload as ResolvedActionCardPayload;
    const state = effectiveActionCardState(card.state, card.expiresAt);
    const pending = state === "pending";
    const preparedByOwnerId = preparedOwnerByAgentId.get(card.preparedByAgentId) ?? "";
    const askedViewer =
      (payload.type === "choice" || payload.type === "questions") &&
      (payload.to === viewerUserId || payload.to === CHOICE_ANYONE_TARGET);
    const base: ActionCardViewBase = {
      messageId: card.messageId,
      state,
      draftHint: card.draftHint ?? undefined,
      preview: previewCardOf(card),
      committedBy: card.committedByUserId
        ? { ...human(card.committedByUserId), isViewer: card.committedByUserId === viewerUserId }
        : undefined,
      committedAt: card.committedAt?.toISOString(),
      expiresAt: card.expiresAt?.toISOString(),
      canCommit: false,
      canCancel: pending && (preparedByOwnerId === viewerUserId || isAdminViewer || askedViewer),
    };
    if (payload.type === "channel:create") {
      views.set(card.messageId, {
        ...base,
        kind: "channel:create",
        name: payload.name,
        visibility: payload.visibility,
        description: payload.description,
        initialHumans: (payload.initialHumanIds ?? []).map(human),
        initialAgents: (payload.initialAgentIds ?? []).map(agent),
        canCommit: pending,
        result: readableResult<{ channelId: string }>(card.result),
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
      const canManage =
        pending &&
        canManageAgentAppAccess(
          { userId: viewerUserId, role: viewerRole },
          { ownerId: preparedByOwnerId },
        );
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
        result: card.result as
          | { clientKey: string; noOwnerAgent?: boolean; secretUndelivered?: boolean }
          | undefined,
      });
    } else if (payload.type === "page:fill") {
      views.set(
        card.messageId,
        pageFillActionCardView(
          base,
          { ...card, preparedByAgent: { ownerId: preparedByOwnerId } },
          payload,
          viewerUserId,
          pending,
        ),
      );
    } else if (payload.type === "desktop:takeover") {
      views.set(
        card.messageId,
        desktopTakeoverActionCardView(
          base,
          { ...card, preparedByAgent: { ownerId: preparedByOwnerId } },
          payload,
          viewerUserId,
          pending,
        ),
      );
    } else if (payload.type === "choice") {
      views.set(
        card.messageId,
        choiceActionCardView(base, card, payload, viewerUserId, pending, userPerson),
      );
    } else if (payload.type === "questions") {
      views.set(
        card.messageId,
        questionsActionCardView(base, card, payload, viewerUserId, pending, userPerson),
      );
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
        channel: channelName.has(payload.channelId)
          ? { id: payload.channelId, displayName: channelName.get(payload.channelId)! }
          : { id: null, displayName: null },
        humans: (payload.humanIds ?? []).map(human),
        agents: (payload.agentIds ?? []).map(agent),
        // Only an active member of a channel they read adds to it: not someone who left it.
        canCommit:
          pending && channelName.has(payload.channelId) && viewerInChannel.has(payload.channelId),
        result: readableResult<{ channelId: string; userIds: string[]; agentIds: string[] }>(
          card.result,
        ),
      });
    }
  }
  return views;
}
