import { agentDirectKey, peopleDirectPeerId } from "#src/features/conversations/direct-key";
import {
  ACTIVE_MEMBER_WHERE,
  DIRECT_CONVERSATION_WHERE,
  VISIBLE_CONVERSATION_WHERE,
} from "#src/server/conversations/active-member.server";
import { searchMessages } from "#src/server/conversations/message-search.server";
import { visibleAgentWhere, agentVisibilityViewerForUser } from "./agent-visibility.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { AgentHistoryResponse, AgentMessage } from "@lrm/coforge-sdk/agent";
import { AppError } from "#src/lib/app-error";
import { workspaceAssistantUser } from "./workspace-assistant-authority.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import { visibleChannelWhere } from "#src/server/conversations/channel-read-access.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import {
  agentMessageSender,
  MESSAGE_SENDER_SELECT,
} from "#src/server/conversations/sender-display.server";
import { agentMessageView } from "#src/server/conversations/agent-message-view.server";
import { AGENT_FORWARD_SELECT } from "#src/server/db/repositories/direct-conversation-agent-message.server";
import { MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";
import { attachmentView } from "#src/server/attachments/attachment-view.server";
import { messageAnchorWhere } from "#src/server/db/message-anchor.server";
import { clampPageLimit } from "#src/server/db/page-limit.server";

export type WorkspaceAssistantPrincipal = { workspaceId: string; agentId: string };
export type AssistantReadWindow = {
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  fromSequence?: number;
  throughSequence?: number;
};

const assistantMessageInclude = {
  sender: MESSAGE_SENDER_SELECT,
  mentions: MESSAGE_MENTIONS_SELECT,
  actionCard: { select: { state: true } },
  forward: AGENT_FORWARD_SELECT,
  attachments: { orderBy: { position: "asc" } },
} satisfies Prisma.MessageInclude;
function assistantMessage(
  row: Prisma.MessageGetPayload<{ include: typeof assistantMessageInclude }>,
  target: string,
): AgentMessage {
  const sender = agentMessageSender(row.sender);
  return {
    id: row.id,
    sequence: row.sequence,
    senderKind: sender.kind,
    senderHandle: sender.handle,
    senderDescription: sender.description,
    ...agentMessageView(row),
    target,
    createdAt: row.createdAt.toISOString(),
    attachments: row.attachments.map((attachment) => attachmentView(attachment)),
  };
}

/** Commands outside the assistant DM act as its human, through the same user use cases as Web.
 * This never makes the private execution Agent public or adds it to another conversation. */
export class WorkspaceAssistantCommands {
  constructor(
    private readonly db: PrismaClient,
    private readonly idempotency?: MessageRequestIdempotency,
    private readonly transport?: CentrifugoServerApi,
  ) {}

  async target(principal: WorkspaceAssistantPrincipal, target: string) {
    const actor = await workspaceAssistantUser(this.db, principal.workspaceId, principal.agentId);
    if (!actor) throw new AppError("ACCESS_DENIED");
    const [parent, anchor, extra] = target.split(":");
    if (!parent || extra !== undefined || !/^[#@][a-z0-9][a-z0-9_-]*$/.test(parent))
      throw new AppError("INVALID_INPUT");
    let conversationId: string;
    const ownAssistant = parent === `@${actor.username}`;
    if (parent.startsWith("#")) {
      const channel = await this.db.conversation.findFirst({
        where: {
          workspaceId: principal.workspaceId,
          channelName: parent.slice(1),
          ...VISIBLE_CONVERSATION_WHERE,
        },
        select: { id: true },
      });
      if (!channel) throw new AppError("NOT_FOUND");
      conversationId = channel.id;
    } else {
      const peer = ownAssistant
        ? null
        : await this.db.user.findUnique({
            where: { username: parent.slice(1) },
            select: { id: true },
          });
      const agent = ownAssistant
        ? { id: principal.agentId }
        : peer
          ? null
          : await this.db.agent.findFirst({
              where: {
                workspaceId: principal.workspaceId,
                name: parent.slice(1),
                ownerId: actor.userId,
              },
              select: { id: true },
            });
      if (!peer && !agent) throw new AppError("NOT_FOUND");
      const existing = agent
        ? await this.db.conversation.findFirst({
            where: {
              workspaceId: principal.workspaceId,
              directKey: agentDirectKey(actor.userId, agent.id),
              members: { some: { userId: actor.userId, ...ACTIVE_MEMBER_WHERE } },
            },
            select: { id: true },
          })
        : null;
      conversationId =
        existing?.id ??
        (
          await new DirectConversations(this.db).open(
            principal.workspaceId,
            actor.userId,
            agent ? { agentId: agent.id } : { userId: peer!.id },
          )
        ).conversationId;
    }
    await new ConversationHistory(this.db).authorize(
      principal.workspaceId,
      actor.userId,
      conversationId,
    );
    let threadRootId: string | undefined;
    if (anchor) {
      const roots = await this.db.message.findMany({
        where: { conversationId, id: messageAnchorWhere(anchor), threadRootId: null },
        select: { id: true },
        take: 2,
      });
      if (roots.length !== 1) throw new AppError("NOT_FOUND");
      threadRootId = roots[0]!.id;
    }
    return { ...actor, conversationId, threadRootId, isChannel: parent.startsWith("#") };
  }

  async send(
    principal: WorkspaceAssistantPrincipal,
    input: { target: string; content: string; idempotencyKey: string; attachmentIds?: string[] },
  ) {
    const target = await this.target(principal, input.target);
    const centrifugo = this.transport ?? createCentrifugoServerApi();
    const realtime = new CentrifugoConversationRealtime(centrifugo);
    const idempotency = this.idempotency ?? getMessageRequestIdempotency();
    if (target.isChannel)
      return new PublicChannels(this.db, idempotency, centrifugo, undefined, realtime).send({
        workspaceId: principal.workspaceId,
        userId: target.userId,
        channelId: target.conversationId,
        idempotencyKey: input.idempotencyKey,
        body: input.content,
        attachmentIds: input.attachmentIds,
        threadRootId: target.threadRootId,
      });
    return new DirectConversations(this.db, realtime).send(
      principal.workspaceId,
      target.userId,
      target.conversationId,
      {
        idempotencyKey: input.idempotencyKey,
        body: input.content,
        attachmentIds: input.attachmentIds,
        threadRootId: target.threadRootId,
      },
      { idempotency, centrifugo, realtime },
    );
  }

  async read(
    principal: WorkspaceAssistantPrincipal,
    target: string,
    window: AssistantReadWindow,
  ): Promise<Omit<AgentHistoryResponse, "idempotencyKey">> {
    const scope = await this.target(principal, target);
    return this.readScope(target, scope, window, this.db);
  }

  private async readScope(
    target: string,
    scope: { conversationId: string; threadRootId?: string },
    window: AssistantReadWindow,
    reader: Pick<PrismaClient, "message">,
  ): Promise<Omit<AgentHistoryResponse, "idempotencyKey">> {
    const limit = clampPageLimit(window.limit ?? 50, 100);
    const anchor = window.around ?? window.before ?? window.after;
    const scopeWhere = {
      conversationId: scope.conversationId,
      threadRootId: scope.threadRootId ?? null,
    };
    const anchors = anchor
      ? await reader.message.findMany({
          where: { ...scopeWhere, id: messageAnchorWhere(anchor) },
          select: { sequence: true },
          take: 2,
        })
      : [];
    if (anchor && anchors.length !== 1) throw new AppError("NOT_FOUND");
    const anchored = anchors[0];
    const sequence = {
      ...(window.fromSequence !== undefined ? { gte: window.fromSequence } : {}),
      ...(window.throughSequence !== undefined ? { lte: window.throughSequence } : {}),
      ...(window.before ? { lt: anchored!.sequence } : {}),
      ...(window.after ? { gt: anchored!.sequence } : {}),
    };
    const rows = window.around
      ? await (async () => {
          // Sequence numbers span parent messages and thread replies; count actual rows on each side.
          const [before, after] = await Promise.all([
            reader.message.findMany({
              where: { ...scopeWhere, sequence: { ...sequence, lte: anchored!.sequence } },
              orderBy: { sequence: "desc" },
              take: Math.floor(limit / 2) + 1,
              include: assistantMessageInclude,
            }),
            reader.message.findMany({
              where: { ...scopeWhere, sequence: { ...sequence, gt: anchored!.sequence } },
              orderBy: { sequence: "asc" },
              take: limit,
              include: assistantMessageInclude,
            }),
          ]);
          return [...before, ...after.slice(0, limit - before.length)];
        })()
      : await reader.message.findMany({
          where: { ...scopeWhere, sequence },
          orderBy: { sequence: window.after || window.fromSequence !== undefined ? "asc" : "desc" },
          take: limit,
          include: assistantMessageInclude,
        });
    rows.sort((a, b) => a.sequence - b.sequence);
    const messages = rows.map((row) => assistantMessage(row, target));
    const first = rows[0];
    const last = rows.at(-1);
    const where = {
      conversationId: scope.conversationId,
      threadRootId: scope.threadRootId ?? null,
    };
    const [older, newer] =
      first && last
        ? await Promise.all([
            reader.message.findFirst({
              where: { ...where, sequence: { lt: first.sequence } },
              select: { id: true },
            }),
            reader.message.findFirst({
              where: { ...where, sequence: { gt: last.sequence } },
              select: { id: true },
            }),
          ])
        : [null, null];
    return {
      messages,
      hasOlder: Boolean(older),
      hasNewer: Boolean(newer),
      olderCursor: first?.id,
      newerCursor: last?.id,
      modelSeenUpToSeq: null,
    };
  }

  async resolve(principal: WorkspaceAssistantPrincipal, anchor: string) {
    const actor = await workspaceAssistantUser(this.db, principal.workspaceId, principal.agentId);
    if (!actor) throw new AppError("ACCESS_DENIED");
    const rows = await this.db.message.findMany({
      where: {
        workspaceId: principal.workspaceId,
        id: messageAnchorWhere(anchor),
        conversation: {
          ...VISIBLE_CONVERSATION_WHERE,
          OR: [
            // A channel its person may read: a private one only from inside it.
            visibleChannelWhere(principal.workspaceId, { userId: actor.userId }),
            {
              ...DIRECT_CONVERSATION_WHERE,
              members: { some: { userId: actor.userId, ...ACTIVE_MEMBER_WHERE } },
            },
          ],
        },
      },
      take: 2,
      include: {
        ...assistantMessageInclude,
        conversation: {
          select: {
            channelName: true,
            directKey: true,
            members: {
              where: { agentId: { not: null } },
              select: { agent: { select: { id: true, name: true } } },
              take: 1,
            },
          },
        },
      },
    });
    if (rows.length !== 1) throw new AppError("NOT_FOUND");
    const row = rows[0]!;
    const agent = row.conversation.members[0]?.agent;
    const peerId = peopleDirectPeerId(row.conversation.directKey, actor.userId);
    const peer = peerId
      ? await this.db.user.findUnique({ where: { id: peerId }, select: { username: true } })
      : null;
    const parent = row.conversation.channelName
      ? `#${row.conversation.channelName}`
      : agent
        ? `@${agent.id === principal.agentId ? actor.username : agent.name}`
        : peer
          ? `@${peer.username}`
          : undefined;
    if (!parent) throw new AppError("NOT_FOUND");
    return {
      message: assistantMessage(row, row.threadRootId ? `${parent}:${row.threadRootId}` : parent),
      conversationId: row.conversationId,
      userId: actor.userId,
      ownAssistant: agent?.id === principal.agentId,
    };
  }

  async search(
    principal: WorkspaceAssistantPrincipal,
    input: {
      target?: string;
      query?: string;
      sender?: string;
      before?: Date;
      after?: Date;
      limit?: number;
      offset?: number;
      sort?: "recent" | "relevance";
    },
  ) {
    const actor = await workspaceAssistantUser(this.db, principal.workspaceId, principal.agentId);
    if (!actor) throw new AppError("ACCESS_DENIED");
    const scope = input.target ? await this.target(principal, input.target) : undefined;
    let senderId: string | undefined;
    if (input.sender) {
      const handle = input.sender.replace(/^@/, "");
      const viewer = await agentVisibilityViewerForUser(
        this.db,
        principal.workspaceId,
        actor.userId,
      );
      const [user, agent] = await Promise.all([
        this.db.user.findFirst({
          where: {
            username: handle,
            memberships: { some: { workspaceId: principal.workspaceId } },
          },
          select: { id: true },
        }),
        this.db.agent.findFirst({
          where: {
            workspaceId: principal.workspaceId,
            name: handle,
            deletedAt: null,
            ...visibleAgentWhere(viewer),
          },
          select: { id: true },
        }),
      ]);
      senderId = user?.id ?? agent?.id;
      if (!senderId) return [];
    }
    const page = await searchMessages(this.db, {
      ...input,
      workspaceId: principal.workspaceId,
      userId: actor.userId,
      conversationId: scope?.conversationId,
      threadRootId: scope?.threadRootId,
      senderId,
      sort: input.sort ?? "relevance",
      limit: input.limit ?? 20,
      offset: input.offset ?? 0,
    });
    const rows = await this.db.message.findMany({
      where: {
        id: { in: page.results.map((hit) => hit.message.id) },
        workspaceId: principal.workspaceId,
      },
      include: assistantMessageInclude,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return page.results.flatMap((hit) => {
      const row = byId.get(hit.message.id);
      if (!row) return [];
      const direct = hit.conversation.direct;
      const parent = hit.conversation.channelName
        ? `#${hit.conversation.channelName}`
        : direct?.kind === "people"
          ? `@${direct.peer.username}`
          : direct?.kind === "agent"
            ? `@${direct.agent.id === principal.agentId ? actor.username : direct.agent.name}`
            : undefined;
      if (!parent) return [];
      return [assistantMessage(row, row.threadRootId ? `${parent}:${row.threadRootId}` : parent)];
    });
  }

  async check(principal: WorkspaceAssistantPrincipal, target: string, limit = 50) {
    const scope = await this.target(principal, target);
    const session = await this.db.workspaceAssistantSession.findUniqueOrThrow({
      where: { agentId: principal.agentId },
      select: { id: true },
    });
    const key = {
      sessionId: session.id,
      conversationId: scope.conversationId,
      scope: scope.threadRootId ?? "",
    };
    return this.db.$transaction(async (tx) => {
      // This row lock serializes concurrent drains without moving the human's unread state.
      const cursor = await tx.workspaceAssistantReadCursor.upsert({
        where: { sessionId_conversationId_scope: key },
        create: key,
        update: { readThroughSequence: { increment: 0 } },
      });
      const page = await this.readScope(
        target,
        scope,
        {
          fromSequence: cursor.readThroughSequence + 1,
          limit,
        },
        tx,
      );
      const last = page.messages.at(-1);
      if (last)
        await tx.workspaceAssistantReadCursor.update({
          where: { sessionId_conversationId_scope: key },
          data: { readThroughSequence: last.sequence },
        });
      return { events: page.messages, hasMore: page.hasNewer };
    });
  }
}
