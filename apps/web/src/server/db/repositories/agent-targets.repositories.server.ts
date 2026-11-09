import { findAgentScopedMessage } from "./agent-message-lookup.repositories.server";
import {
  isAttachmentMessageTarget,
  type AgentMessageValidationMessage,
} from "@lrm/coforge-sdk/internal";
import { appEventConversation } from "#src/server/app-agent-events/app-event-target.server";
import { workspaceAssistantUser } from "#src/server/agents/workspace-assistant-authority.server";
import { WorkspaceAssistantCommands } from "#src/server/agents/workspace-assistant-commands.server";
import {
  deliveryTarget,
  messageDeliveryTarget,
  toAgentMessage,
} from "./direct-conversation-agent-message.server";
import { assertMessageAnchor, onlyAnchorMatch } from "./direct-conversation-anchor.server";
import {
  directTargets,
  getOrCreateAgentPeerConversation,
  findAgentPeerConversation,
} from "./agent-peer-direct.repositories.server";
import { type PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import {
  AgentMessageValidationError,
  MESSAGE_NOT_VISIBLE,
} from "#src/server/conversations/agent-message-validation-error.server";
import { messageAnchorWhere } from "#src/server/db/message-anchor.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { visibleChannelWhere } from "#src/server/conversations/channel-read-access.server";
import { readChannelCoordination } from "#src/server/conversations/channel-coordination.server";
import { writeReaction, type ReactionPort } from "#src/server/conversations/reaction-write.server";
import { NOTIFIED_AGENT_WHERE } from "#src/server/db/repositories/agent-attention.repositories.server";
import type { ResolvedAgentTarget } from "./resolved-agent-target.server";
import { resolveAgentConversationTarget } from "./agent-target-resolution.server";
import { type ConversationReadRealtimePort } from "./agent-read-groups.repositories.server";

/** What the Agent-facing direct-conversation operations need from the repository that hands them
 * out: the database, the realtime publisher, and its channel lookup, which is the instance's own
 * so a one-request instance keeps sharing it. */
export type DirectConversationPorts = {
  db: PrismaClient;
  realtime?: ReactionPort & ConversationReadRealtimePort;
  getAgentChannel: (
    workspaceId: string,
    agentId: string,
    target: string,
  ) => Promise<{ id: string }>;
  /** The send path's channel: the Agent's channel, or one it can still join on the way to
   * posting (`needsJoin` — the send's own transaction writes the membership). */
  getAgentSendChannel?: (
    workspaceId: string,
    agentId: string,
    target: string,
  ) => Promise<{ id: string; channelName?: string | null; needsJoin: boolean }>;
  findUserAgentConversation(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): Promise<{ id: string } | null>;
  getOrCreateUserAgent(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): Promise<{ id: string }>;
  resolveAgentTarget(
    workspaceId: string,
    agentId: string,
    target: string,
  ): Promise<ResolvedAgentTarget>;
};

/** The scope a thread-root anchor resolves in: the conversation's top level. */
export const THREAD_ROOT_SCOPE = {
  threadRootId: null,
  outsideScopeError: "thread root must be a top-level message",
} as const;

/** Resolves a message anchor inside one thread scope: `threadRootId` names the thread a page
 * anchor must land in, `null` the top level a thread root must be. UUIDv7 ids minted in the same
 * ~65-second window share a short prefix, so a root and its replies can collide on a short
 * anchor — the scoped lookup settles it before the conversation-wide one classifies a miss. */
export async function resolveMessage(
  ports: DirectConversationPorts,
  conversationId: string,
  anchor: string,
  scope: { threadRootId: string | null; outsideScopeError?: AgentMessageValidationMessage },
) {
  assertMessageAnchor(anchor);
  const select = { id: true, sequence: true, threadRootId: true, senderMemberId: true };
  const id = messageAnchorWhere(anchor);
  const scoped = await ports.db.message.findMany({
    where: { conversationId, threadRootId: scope.threadRootId, id },
    take: 2,
    select,
  });
  if (scoped.length > 1)
    throw new AgentMessageValidationError(
      "ambiguous message prefix; use the full UUID",
      scoped.map((row) => row.id),
    );
  if (scoped[0]) return scoped[0];
  const rows = await ports.db.message.findMany({
    where: { conversationId, id },
    take: 2,
    select,
  });
  onlyAnchorMatch(rows, "message anchor not found in this conversation");
  throw new AgentMessageValidationError(
    scope.outsideScopeError ?? "message anchor is outside this target",
  );
}

async function targetRoot(ports: DirectConversationPorts, conversationId: string, target: string) {
  const root = target.split(":")[1];
  return root ? (await resolveMessage(ports, conversationId, root, THREAD_ROOT_SCOPE)).id : null;
}

/** Resolves an Agent target to its conversation, optional thread root and canonical spelling.
 * Public so Agent HTTP routes share the same target grammar. */
export async function resolveAgentTarget(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  target: string,
): Promise<ResolvedAgentTarget> {
  return resolveAgentTargetUsing(
    ports,
    workspaceId,
    agentId,
    target,
    (userId) => agentDirectConversation(ports, workspaceId, userId, agentId),
    (peerId) => getOrCreateAgentPeerConversation(ports.db, workspaceId, agentId, peerId),
  );
}

/**
 * The target an Agent drains (`message check --target`): one it belongs to, or a channel it is
 * not in but was notified of a message in and has not read yet. The latter only reaches those
 * notified messages (the drain's non-member branch); the channel itself stays closed to it.
 */
export async function drainScope(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  target: string,
) {
  // An attachment's comment target scopes the check to its discussion (or one comment thread):
  // the Agent must still be an active member of the file's source conversation, the recheck a
  // comment read applies. Before comment migration the discussion is its own conversation;
  // after it, the comments are ordinary messages in the source conversation itself.
  if (isAttachmentMessageTarget(target)) {
    const parsed = /^attachment:([0-9a-f-]{36})(?::([0-9a-f-]{6,36}))?$/i.exec(target);
    const attachment =
      parsed &&
      (await ports.db.attachment.findFirst({
        where: {
          id: parsed[1],
          workspaceId,
          conversation: {
            hiddenFromWorkspaceAt: null,
            members: { some: { agentId, leftAt: null } },
          },
        },
        select: {
          conversationId: true,
          message: { select: { id: true, threadRootId: true } },
          commentThread: { select: { conversationId: true } },
        },
      }));
    if (!attachment) throw new AppError("NOT_FOUND");
    // The comment discussion lives in its own conversation before migration and in the
    // attachment's source conversation after it. There it threads under the source message, so
    // the bare target scopes to that root.
    const conversationId = attachment.commentThread?.conversationId ?? attachment.conversationId;
    const threadRootId =
      conversationId === attachment.conversationId
        ? (attachment.message?.threadRootId ?? attachment.message?.id ?? null)
        : null;
    if (!parsed![2]) return { conversationId, threadRootId };
    // A root may be the full comment id or its short anchor, exactly as the read resolves it;
    // `attachmentId` sits on the comment row itself, so the thread table is never needed.
    const roots = await ports.db.attachmentComment.findMany({
      where: {
        attachmentId: parsed![1],
        workspaceId,
        conversationId,
        message: { id: messageAnchorWhere(parsed![2]) },
      },
      select: { message: { select: { id: true, threadRootId: true } } },
    });
    if (!roots.length) throw new AppError("NOT_FOUND");
    // A comment's thread root is its threadRootId, or the comment itself when it is a root
    // comment (the `?? id` rule rootOf/replyTarget use). Several comments can share one root,
    // so ambiguity is judged on the resolved scope, not the row count — and there is no row
    // cap, because a capped read could hide the second distinct scope.
    const scopes = new Map<string, { threadRootId: string; candidateId: string }>();
    for (const row of roots) {
      const threadRootId = row.message.threadRootId ?? row.message.id;
      if (!scopes.has(threadRootId))
        scopes.set(threadRootId, { threadRootId, candidateId: row.message.id });
    }
    if (scopes.size > 1)
      throw new AgentMessageValidationError(
        "ambiguous message prefix; use the full UUID",
        [...scopes.values()].map((scope) => scope.candidateId),
      );
    return { conversationId, threadRootId: [...scopes.values()][0]!.threadRootId };
  }
  try {
    return await ports.resolveAgentTarget(workspaceId, agentId, target);
  } catch (error) {
    const [parent, anchor] = target.split(":");
    if (!parent?.startsWith("#") || !isAppError(error) || error.code !== "ACCESS_DENIED")
      throw error;
    if (anchor) assertMessageAnchor(anchor);
    const notified = await ports.db.pendingMentionAction.findMany({
      where: {
        workspaceId,
        ...NOTIFIED_AGENT_WHERE(agentId),
        targetReadAt: null,
        message: {
          // Only a channel it could read: a private one it is not in stays closed to it.
          conversation: {
            ...visibleChannelWhere(workspaceId, { agentId }),
            channelName: parent.slice(1),
          },
          threadRootId: anchor ? messageAnchorWhere(anchor) : null,
        },
      },
      select: { conversationId: true, message: { select: { threadRootId: true } } },
    });
    // pendingMentionAction has one row per notified message, and several messages can share
    // one thread, so ambiguity is judged on the distinct resolved scopes, not the row count.
    const scopes = new Map<string, { conversationId: string; threadRootId: string | null }>();
    for (const row of notified) {
      const threadRootId = row.message.threadRootId;
      const key = `${row.conversationId}:${threadRootId ?? ""}`;
      if (!scopes.has(key)) scopes.set(key, { conversationId: row.conversationId, threadRootId });
    }
    if (scopes.size > 1)
      throw new AgentMessageValidationError(
        "ambiguous message prefix; use the full UUID",
        [...scopes.values()].map((scope) => scope.threadRootId!).filter(Boolean),
      );
    const match = [...scopes.values()][0];
    if (!match) throw error;
    return match;
  }
}

/**
 * `resolveAgentTarget` for something the Agent is about to post (a message or an attachment):
 * a direct message to someone who is not a Workspace member is refused with
 * `DM_PEER_NOT_IN_WORKSPACE` before anything is written.
 */
export function resolveAgentSendTarget(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  target: string,
) {
  return resolveAgentPostTarget(
    ports,
    workspaceId,
    agentId,
    target,
    (userId) => ports.getOrCreateUserAgent(workspaceId, userId, agentId),
    (peerId) => getOrCreateAgentPeerConversation(ports.db, workspaceId, agentId, peerId),
  );
}

/**
 * Where a send to `target` would post, for the "about to post" signal: the send path's checks
 * without its writes. A direct message is only looked up, never started, and `peerUserId` names
 * the person on its other side. A Workspace assistant's direct message is not resolved: its
 * lookup opens one.
 */
export async function resolveAgentReplyTarget(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  target: string,
) {
  let peerUserId: string | undefined;
  const resolved = await resolveAgentPostTarget(
    ports,
    workspaceId,
    agentId,
    target,
    async (userId) => {
      const direct = await ports.findUserAgentConversation(workspaceId, userId, agentId);
      if (!direct) throw new AppError("NOT_FOUND");
      const member = await ports.db.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        select: { userId: true },
      });
      if (!member) throw new AppError("DM_PEER_NOT_IN_WORKSPACE");
      peerUserId = userId;
      return direct;
    },
    async (peerId) => {
      const direct = await findAgentPeerConversation(ports.db, workspaceId, agentId, peerId);
      if (!direct) throw new AppError("NOT_FOUND");
      return direct;
    },
    true,
  );
  return { ...resolved, peerUserId };
}

async function resolveAgentPostTarget(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  target: string,
  directConversation: (userId: string) => Promise<{ id: string }>,
  peerConversation: (peerAgentId: string) => Promise<{ id: string }>,
  readOnly = false,
): Promise<ResolvedAgentTarget> {
  await appEventConversation(ports.db, workspaceId, agentId, target.split(":")[0]!, {
    send: true,
  });
  const delegate = await workspaceAssistantUser(ports.db, workspaceId, agentId);
  if (delegate && target.split(":")[0] !== `@${delegate.username}`) {
    if (readOnly && !target.startsWith("#")) throw new AppError("ACCESS_DENIED");
    const scope = await new WorkspaceAssistantCommands(ports.db).target(
      { workspaceId, agentId },
      target,
    );
    return {
      conversationId: scope.conversationId,
      threadRootId: scope.threadRootId ?? null,
      canonicalTarget: deliveryTarget(target.split(":")[0]!, scope.threadRootId ?? null),
      isChannel: scope.isChannel,
    };
  }
  return resolveAgentTargetUsing(
    ports,
    workspaceId,
    agentId,
    target,
    directConversation,
    peerConversation,
    true,
  );
}

async function resolveAgentTargetUsing(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  target: string,
  directConversation: (userId: string) => Promise<{ id: string }>,
  peerConversation: (peerAgentId: string) => Promise<{ id: string }>,
  /** A send (or a send's reads) resolves a channel the Agent may still join; other reads keep
   * the member-only lookup. */
  sendTarget = false,
): Promise<ResolvedAgentTarget> {
  const resolved = await resolveAgentConversationTarget({
    db: ports.db,
    workspaceId,
    agentId,
    target,
    getChannel: (parentTarget) =>
      sendTarget
        ? (ports.getAgentSendChannel ?? ports.getAgentChannel)(workspaceId, agentId, parentTarget)
        : ports.getAgentChannel(workspaceId, agentId, parentTarget),
    directConversation,
    peerConversation,
    taskDiscussion: !sendTarget,
  });
  const { conversation, isChannel } = resolved;
  const parentTarget = target.split(":")[0]!;
  // A `#channel:<task-discussion id>` resolves its task_thread conversation itself — the `<id>`
  // names the conversation, not a thread root inside it.
  const threadRootId = (conversation as { isTaskDiscussionTarget?: boolean }).isTaskDiscussionTarget
    ? null
    : await targetRoot(ports, conversation.id, target);
  return {
    conversationId: conversation.id,
    threadRootId,
    canonicalTarget: (conversation as { isTaskDiscussionTarget?: boolean }).isTaskDiscussionTarget
      ? `#${(conversation as unknown as { channelName: string }).channelName}:${conversation.id}`
      : deliveryTarget(parentTarget, threadRootId),
    isChannel,
    isUserAgentDirectConversation: resolved.isUserAgentDirectConversation,
    ...(threadRootId === null &&
    (conversation as { isTaskDiscussionTarget?: boolean }).isTaskDiscussionTarget
      ? { seatOptional: true as const }
      : {}),
  };
}

export async function resolveAgentMessage(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  anchor: string,
) {
  const row = await findAgentScopedMessage(ports.db, workspaceId, agentId, anchor);
  const coordination = await readChannelCoordination(
    ports.db,
    workspaceId,
    agentId,
    row.conversation.channelName !== null ? [row.conversationId] : [],
  );
  const targetOf = await directTargets(ports.db, workspaceId, agentId, [row.conversation]);
  return toAgentMessage(
    row,
    messageDeliveryTarget(row, targetOf),
    agentId,
    coordination.get(row.conversationId),
  );
}

export async function setAgentMessageReaction(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  anchor: string,
  emoji: string,
  active: boolean,
) {
  const row = await findAgentScopedMessage(ports.db, workspaceId, agentId, anchor);
  const member = await ports.db.conversationMember.findFirst({
    where: { conversationId: row.conversationId, workspaceId, agentId, ...ACTIVE_MEMBER_WHERE },
    select: { id: true },
  });
  if (!member) throw new AgentMessageValidationError(MESSAGE_NOT_VISIBLE);
  const written = await writeReaction(ports.db, ports.realtime, {
    workspaceId,
    conversationId: row.conversationId,
    messageId: row.id,
    threadRootId: row.threadRootId,
    memberId: member.id,
    emoji,
    active,
  });
  if (!written) throw new AgentMessageValidationError(MESSAGE_NOT_VISIBLE);
  return { messageId: row.id };
}

/**
 * The Agent's DM with a person to read: the one they already have, which stays as history after
 * they left the Workspace, or else one started while they are a member.
 */
async function agentDirectConversation(
  ports: DirectConversationPorts,
  workspaceId: string,
  userId: string,
  agentId: string,
) {
  return (
    (await ports.findUserAgentConversation(workspaceId, userId, agentId)) ??
    ports.getOrCreateUserAgent(workspaceId, userId, agentId)
  );
}

export async function setAgentChannelMuted(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  target: string,
  muted: boolean,
) {
  const user = await workspaceAssistantUser(ports.db, workspaceId, agentId);
  if (user) {
    const scope = await new WorkspaceAssistantCommands(ports.db).target(
      { workspaceId, agentId },
      target,
    );
    if (!scope.isChannel) throw new AppError("INVALID_INPUT");
    return new PublicChannels(ports.db).setUserMuted(
      workspaceId,
      user.userId,
      scope.conversationId,
      muted,
    );
  }
  return new PublicChannels(ports.db).setAgentMuted(workspaceId, agentId, target, muted);
}

export async function setAgentThreadFollowed(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  target: string,
  followed: boolean,
  reason?: string,
) {
  const user = await workspaceAssistantUser(ports.db, workspaceId, agentId);
  if (user) {
    const scope = await new WorkspaceAssistantCommands(ports.db).target(
      { workspaceId, agentId },
      target,
    );
    if (!scope.isChannel || !scope.threadRootId) throw new AppError("INVALID_INPUT");
    return new PublicChannels(ports.db).setUserThreadFollowed(
      workspaceId,
      user.userId,
      scope.conversationId,
      scope.threadRootId,
      followed,
    );
  }
  return new PublicChannels(ports.db).setAgentThreadFollowed(
    workspaceId,
    agentId,
    target,
    followed,
    reason,
  );
}
