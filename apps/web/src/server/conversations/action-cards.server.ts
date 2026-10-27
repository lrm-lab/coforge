import { VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import {
  actionCardActionSchema,
  APP_GRANT_AGENT_CARD_KIND,
  validateActionCardAction,
  type ActionCardAction,
  type ResolvedActionCardPayload,
} from "@lrm/coforge-sdk/agent";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { humanLabel } from "#src/lib/human-label";
import { ActionCardError } from "./action-card-error.server";
import { ActionCardHandles } from "./action-card-handles.server";
import { actionCardSummary } from "./action-card-summary.server";
import {
  appRecoverOwnerView,
  resolveAppRecoverOwnerPayload,
} from "./app-recover-owner-action-cards.server";
import { appRegisterView, resolveAppRegisterPayload } from "./app-register-action-cards.server";
import { PublicChannels } from "./public-channels.server";
import { ConversationHistory } from "./conversation-history.server";
import { loadPendingActionCard } from "./pending-action-card.server";
import { pageFillActionCardView, resolvePageFillPayload } from "./action-card-page-fill.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import {
  createActionCardMessage,
  publishActionCardMessage,
  publishActionCardUpdate,
} from "./action-card-message.server";
import {
  resolveActionCardTarget,
  type ActionCardTargetRepository,
} from "./action-card-target.server";
import type {
  ActionCardPrepareResult,
  ActionCardRef,
  ActionCardState,
  ActionCardView,
  ActionCardViewBase,
} from "./action-card-view.server";
import { canManageAgentAppAccess } from "#src/server/app-agent-access/access-rules.server";
import { roleCan } from "#src/features/workspaces/workspace-roles";
import { isAdminLike } from "#src/server/workspaces/member-role.server";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";

export type * from "./action-card-view.server";
export type { ActionCardTargetRepository } from "./action-card-target.server";

async function safeWorkspaceRole(db: PrismaClient, workspaceId: string, userId: string) {
  try {
    return await workspaceMemberRole(db, workspaceId, userId);
  } catch {
    return undefined;
  }
}

/**
 * An action card's own validity, which needs nothing but the action: its schema, its cross-field
 * rules, and the kinds not supported yet. Throws `ActionCardError("INVALID_ACTION")`.
 */
export function parseActionCardAction(value: unknown) {
  const parsed = actionCardActionSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new ActionCardError(422, "INVALID_ACTION", "Action failed validation", { issues });
  }
  const action = parsed.data;
  const crossFieldError = validateActionCardAction(action);
  if (crossFieldError) throw new ActionCardError(422, "INVALID_ACTION", crossFieldError);
  if (action.type === "channel:create" && action.visibility === "private")
    throw new ActionCardError(422, "INVALID_ACTION", "private channels are not supported yet");
  return action;
}

/**
 * Resolves an Agent-prepared action card (`coforge action prepare`) into a posted Message plus an
 * `ActionCard` record (see `packages/coforge-sdk/src/agent/action-cards.ts`).
 * A person commits or cancels it under their own identity; it renders as an ordinary Agent
 * message with a readable summary.
 */
export class ActionCards {
  constructor(
    private readonly db: PrismaClient,
    /** Only required by `prepare`; `viewsFor`/`commit*`/`cancel` do not need a target repository. */
    private readonly conversations?: ActionCardTargetRepository,
    private readonly realtime?: ConversationRealtime,
  ) {
    this.handles = new ActionCardHandles(db);
  }

  private readonly handles: ActionCardHandles;

  async prepare(
    principal: { workspaceId: string; agentId: string },
    input: { target: string; action: unknown },
  ): Promise<ActionCardPrepareResult> {
    const action = parseActionCardAction(input.action);
    if (!this.conversations)
      throw new Error("ActionCards.prepare requires a conversations repository");
    const target = await resolveActionCardTarget(
      this.db,
      this.conversations,
      principal.workspaceId,
      principal.agentId,
      input.target,
    );
    const payload = await this.resolvePayload(principal.workspaceId, principal.agentId, action);
    const body = action.draftHint
      ? `${actionCardSummary(action)}\n${action.draftHint}`
      : actionCardSummary(action);

    const created = await this.db.$transaction((tx) =>
      createActionCardMessage(tx, principal, target, {
        kind: action.type,
        payload,
        body,
        draftHint: action.draftHint,
      }),
    );
    await publishActionCardMessage(this.db, this.realtime, principal.workspaceId, target, created);
    return { messageId: created.id, metadata: { kind: "action-card" } };
  }

  /**
   * Browser-facing views for a page of messages, one batched lookup per page (never per message):
   * every referenced user/Agent/channel/computer, plus the viewer's Workspace role and channel
   * memberships, in one `Promise.all`. Messages without a card are absent from the returned map.
   * Names that no longer resolve (a deleted user, Agent, channel, or computer) render as "unknown".
   */
  async viewsFor(
    workspaceId: string,
    viewerUserId: string,
    messageIds: string[],
  ): Promise<Map<string, ActionCardView>> {
    const ids = [...new Set(messageIds)];
    if (!ids.length) return new Map();
    const cards = await this.db.actionCard.findMany({
      where: { workspaceId, messageId: { in: ids } },
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
          ? this.db.user.findMany({
              where: { id: { in: [...userIds] } },
              select: { id: true, username: true, displayName: true },
            })
          : Promise.resolve([]),
        agentIds.size
          ? this.db.agent.findMany({
              where: { id: { in: [...agentIds] } },
              select: { id: true, name: true, displayName: true },
            })
          : Promise.resolve([]),
        channelIds.size
          ? this.db.conversation.findMany({
              // A channel hidden from the Workspace is named on no card.
              where: { id: { in: [...channelIds] }, ...VISIBLE_CONVERSATION_WHERE },
              select: { id: true, channelName: true },
            })
          : Promise.resolve([]),
        computerIds.size
          ? this.db.computer.findMany({
              where: { id: { in: [...computerIds] } },
              select: { id: true, name: true, displayName: true },
            })
          : Promise.resolve([]),
        safeWorkspaceRole(this.db, workspaceId, viewerUserId),
        channelIds.size
          ? this.db.conversationMember.findMany({
              where: { conversationId: { in: [...channelIds] }, userId: viewerUserId },
              select: { conversationId: true },
            })
          : Promise.resolve([]),
      ]);

    const userName = new Map(users.map((u) => [u.id, humanLabel(u)]));
    const agentName = new Map(agents.map((a) => [a.id, a.displayName?.trim() || a.name]));
    const channelName = new Map(channels.map((c) => [c.id, c.channelName ?? "unknown"]));
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
        views.set(
          card.messageId,
          pageFillActionCardView(base, card, payload, viewerUserId, pending),
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

  /**
   * Marks a card `executed` under the committing human's identity. Ordering: the caller always
   * executes the real operation (`PublicChannels.create`/`addMembers`, or `ManageAgents.create` in
   * `agents.functions.ts`) first, then calls this. The conditional `updateMany` is the final,
   * race-safe guard: a concurrent second commit fails on the operation's own uniqueness rule
   * (channel/Agent name) or is a harmless no-op (`addMembers`'s `skipDuplicates`), then finds
   * `count === 0` here and reports `CONFLICT` even though its own operation "succeeded".
   */
  private async markExecuted(
    messageId: string,
    conversationId: string,
    actorUserId: string,
    result: Record<string, unknown>,
  ) {
    const updated = await this.db.actionCard.updateMany({
      where: { messageId, state: "pending" },
      data: {
        state: "executed",
        committedByUserId: actorUserId,
        committedAt: new Date(),
        result: result as unknown as Prisma.InputJsonValue,
      },
    });
    if (updated.count === 0) throw new AppError("CONFLICT");
    await publishActionCardUpdate(this.db, this.realtime, conversationId, messageId);
  }

  /** `channel:create` commit: `PublicChannels.create` (any Workspace member), then
   * `PublicChannels.addMembers` for the human-selected initial humans/Agents (the creator is
   * already a member, so they may add). */
  async commitChannelCreate(
    principal: { workspaceId: string; actorUserId: string },
    input: {
      messageId: string;
      name: string;
      projectId?: string;
      memberUserIds: string[];
      memberAgentIds: string[];
    },
  ): Promise<{ channelId: string }> {
    const card = await loadPendingActionCard(
      this.db,
      principal.workspaceId,
      principal.actorUserId,
      input.messageId,
      "channel:create",
    );
    const channels = new PublicChannels(this.db, undefined, undefined, undefined, this.realtime);
    // The Agent-proposed description (`Conversation.description`) rides along from the
    // card's own resolved payload, not a new browser-supplied input: it is the Agent's context,
    // not something the committing human retypes.
    const payload = card.payload as ResolvedActionCardPayload & { type: "channel:create" };
    const created = await channels.create(
      principal.workspaceId,
      principal.actorUserId,
      input.name,
      input.projectId,
      payload.description,
    );
    if (input.memberUserIds.length || input.memberAgentIds.length) {
      await channels.addMembers(
        principal.workspaceId,
        { userId: principal.actorUserId },
        created.id,
        {
          userIds: input.memberUserIds,
          agentIds: input.memberAgentIds,
        },
      );
    }
    const result = { channelId: created.id };
    await this.markExecuted(input.messageId, card.conversationId, principal.actorUserId, result);
    return result;
  }

  /** `channel:add_member` commit: `PublicChannels.addMembers`, which already requires the actor
   * to be a member of the target channel (`ACCESS_DENIED` otherwise). */
  async commitChannelAddMember(
    principal: { workspaceId: string; actorUserId: string },
    input: { messageId: string; channelId: string; userIds: string[]; agentIds: string[] },
  ): Promise<{ channelId: string; userIds: string[]; agentIds: string[] }> {
    const card = await loadPendingActionCard(
      this.db,
      principal.workspaceId,
      principal.actorUserId,
      input.messageId,
      "channel:add_member",
    );
    const channels = new PublicChannels(this.db, undefined, undefined, undefined, this.realtime);
    await channels.addMembers(
      principal.workspaceId,
      { userId: principal.actorUserId },
      input.channelId,
      {
        userIds: input.userIds,
        agentIds: input.agentIds,
      },
    );
    const result = { channelId: input.channelId, userIds: input.userIds, agentIds: input.agentIds };
    await this.markExecuted(input.messageId, card.conversationId, principal.actorUserId, result);
    return result;
  }

  /**
   * `agent:create` commit runs through the existing `createAgent` seam in `agents.functions.ts`,
   * which submits the human's full runtime form and enforces `assertCanCreateAgents` itself (a
   * plain member is denied there and the card stays `pending`). This only performs the shared
   * pre-check; call `completeAgentCreate` after `ManageAgents.create` succeeds.
   */
  async assertAgentCreateCommittable(
    workspaceId: string,
    actorUserId: string,
    messageId: string,
    computerId: string,
  ): Promise<void> {
    const card = await loadPendingActionCard(
      this.db,
      workspaceId,
      actorUserId,
      messageId,
      "agent:create",
    );
    // `requiredComputer` is a placement contract, not a UI hint: never fall back to another Computer.
    const required = (card.payload as { requiredComputerId?: string }).requiredComputerId;
    if (required && required !== computerId) throw new AppError("INVALID_INPUT");
  }

  async completeAgentCreate(
    workspaceId: string,
    actorUserId: string,
    messageId: string,
    agentId: string,
  ): Promise<void> {
    const card = await this.db.actionCard.findUnique({
      where: { messageId },
      select: { conversationId: true, workspaceId: true },
    });
    if (!card || card.workspaceId !== workspaceId) throw new AppError("NOT_FOUND");
    await this.markExecuted(messageId, card.conversationId, actorUserId, { agentId });
  }

  /** Cancel: by the preparing Agent's owner (`Agent.ownerId`) or a Workspace owner/admin; an
   * `app:grant_agent` card only by denying it (`AppGrantActionCards.deny`). */
  async cancel(
    principal: { workspaceId: string; actorUserId: string },
    messageId: string,
  ): Promise<void> {
    const card = await this.db.actionCard.findUnique({
      where: { messageId },
      select: {
        conversationId: true,
        workspaceId: true,
        kind: true,
        state: true,
        preparedByAgent: { select: { ownerId: true } },
      },
    });
    if (!card || card.workspaceId !== principal.workspaceId) throw new AppError("NOT_FOUND");
    await new ConversationHistory(this.db).authorize(
      principal.workspaceId,
      principal.actorUserId,
      card.conversationId,
    );
    if (card.state !== "pending") throw new AppError("CONFLICT");
    const role = await safeWorkspaceRole(this.db, principal.workspaceId, principal.actorUserId);
    const canCancel =
      card.preparedByAgent.ownerId === principal.actorUserId || (role ? isAdminLike(role) : false);
    if (!canCancel) throw new AppError("ACCESS_DENIED");
    if (card.kind === APP_GRANT_AGENT_CARD_KIND) throw new AppError("INVALID_INPUT");
    await this.markCancelled(card.conversationId, messageId);
  }

  private async markCancelled(conversationId: string, messageId: string) {
    const updated = await this.db.actionCard.updateMany({
      where: { messageId, state: "pending" },
      data: { state: "cancelled" },
    });
    if (updated.count === 0) throw new AppError("CONFLICT");
    await publishActionCardUpdate(this.db, this.realtime, conversationId, messageId);
  }

  private async resolvePayload(
    workspaceId: string,
    agentId: string,
    action: ActionCardAction,
  ): Promise<ResolvedActionCardPayload> {
    if (action.type === "page:fill")
      return resolvePageFillPayload(this.db, workspaceId, agentId, action);
    if (action.type === "app:register") return resolveAppRegisterPayload(this.db, action);
    if (action.type === "app:recover_owner")
      return resolveAppRecoverOwnerPayload(this.db, { workspaceId, agentId }, action);
    if (action.type === "channel:create") {
      if (action.name === "general" || (await this.handles.channelExists(workspaceId, action.name)))
        throw new ActionCardError(409, "CHANNEL_EXISTS", `channel #${action.name} already exists`);
      const [initialHumanIds, initialAgentIds] = await Promise.all([
        this.handles.resolveHumans(workspaceId, action.initialHumans, "action.initialHumans"),
        this.handles.resolveAgents(
          workspaceId,
          agentId,
          action.initialAgents,
          "action.initialAgents",
        ),
      ]);
      return {
        type: "channel:create",
        name: action.name,
        visibility: action.visibility,
        description: action.description,
        ...(initialHumanIds ? { initialHumanIds } : {}),
        ...(initialAgentIds ? { initialAgentIds } : {}),
      };
    }
    if (action.type === "agent:create") {
      // A deleted Agent's name is free: creating the Agent renames the deleted holder.
      const existing = await this.db.agent.findFirst({
        where: { workspaceId, name: action.name, ...ACTIVE_AGENT_WHERE },
        select: { id: true },
      });
      if (existing)
        throw new ActionCardError(409, "AGENT_EXISTS", `agent ${action.name} already exists`);
      const [suggestedComputerId, requiredComputerId] = await Promise.all([
        action.suggestedComputer
          ? this.handles.resolveComputer(
              workspaceId,
              action.suggestedComputer,
              "action.suggestedComputer",
            )
          : Promise.resolve(undefined),
        action.requiredComputer
          ? this.handles.resolveComputer(
              workspaceId,
              action.requiredComputer,
              "action.requiredComputer",
            )
          : Promise.resolve(undefined),
      ]);
      return {
        type: "agent:create",
        name: action.name,
        description: action.description,
        ...(suggestedComputerId ? { suggestedComputerId } : {}),
        ...(requiredComputerId ? { requiredComputerId } : {}),
      };
    }
    const channelId = await this.handles.resolveChannel(
      workspaceId,
      action.channel,
      "action.channel",
    );
    const [humanIds, agentIds] = await Promise.all([
      this.handles.resolveHumans(workspaceId, action.humans, "action.humans"),
      this.handles.resolveAgents(workspaceId, agentId, action.agents, "action.agents"),
    ]);
    return {
      type: "channel:add_member",
      channelId,
      ...(humanIds ? { humanIds } : {}),
      ...(agentIds ? { agentIds } : {}),
    };
  }
}

export { ActionCardError } from "./action-card-error.server";
export { attachActionCardViews } from "./action-card-attach.server";
