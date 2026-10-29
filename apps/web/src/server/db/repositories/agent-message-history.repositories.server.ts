import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { AgentHistoryConsumptionScope } from "@lrm/coforge-sdk/agent";
import type { AgentMessagesPage } from "#src/server/agents/agent-messages.server";
import { agentHistoryModelSeenBoundary } from "#src/server/agents/agent-history-boundary.server";
import { AgentMessageValidationError } from "#src/server/conversations/agent-message-validation-error.server";
import { readChannelCoordination } from "#src/server/conversations/channel-coordination.server";
import { clampPageLimit } from "#src/server/db/page-limit.server";
import {
  AGENT_MESSAGE_INCLUDE,
  toAgentMessage,
  readPositionReport,
  readLatestWindow,
  readWindowAround,
  type DirectConversationMessageRow,
} from "./direct-conversation-agent-message.server";
import {
  anchorSideHasMessages,
  isSequenceAnchor,
  sequenceAnchor,
} from "./direct-conversation-anchor.server";
import { readThroughOf } from "./thread-read-position.server";
import {
  advanceAgentReadPosition,
  type ConversationReadChangedInput,
} from "./agent-read-position.repositories.server";

/** Windowing and read-through after the caller has authorized and resolved its target. */
export async function readAgentMessagePage(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    conversationId: string;
    threadRootId: string | null;
    canonicalTarget: string;
    isChannel: boolean;
    isUserAgentDirectConversation: boolean;
    page: AgentMessagesPage;
    consumptionScope?: AgentHistoryConsumptionScope;
    additionalScope?: Prisma.MessageWhereInput;
    conversationReadChanged?(input: ConversationReadChangedInput): Promise<void>;
    resolveAnchor(
      anchor: string,
    ): Promise<{ id: string; sequence: number; threadRootId: string | null }>;
  },
) {
  const {
    workspaceId,
    agentId,
    conversationId,
    threadRootId,
    canonicalTarget,
    isChannel,
    isUserAgentDirectConversation,
    page,
    consumptionScope,
    additionalScope,
    conversationReadChanged,
    resolveAnchor,
  } = input;
  const scope = {
    conversationId,
    threadRootId,
    ...additionalScope,
    ...(isChannel && page.throughSequence !== undefined
      ? { deliveries: { some: { agentId } } }
      : {}),
  };
  const limit = clampPageLimit(page.limit ?? 50, 100);
  if ([page.before, page.after, page.around].filter(Boolean).length > 1)
    throw new Error("use only one range anchor");
  const anchorId = page.before ?? page.after ?? page.around;
  const [agentMember, anchor] = await Promise.all([
    db.conversationMember.findUnique({
      where: { conversationId_agentId: { conversationId, agentId } },
      select: { id: true, agentReadThroughSequence: true },
    }),
    anchorId
      ? isSequenceAnchor(anchorId)
        ? sequenceAnchor(anchorId, threadRootId)
        : resolveAnchor(anchorId)
      : undefined,
  ]);
  if (!agentMember) throw new Error("Agent is not a conversation member");
  if (anchor && anchor.threadRootId !== threadRootId)
    throw new AgentMessageValidationError("message anchor is outside this target");
  const readThrough = await readThroughOf(
    db,
    agentMember.id,
    agentMember.agentReadThroughSequence,
    threadRootId,
  );
  const include = AGENT_MESSAGE_INCLUDE;
  const coordination = isChannel
    ? (await readChannelCoordination(db, workspaceId, agentId, [conversationId])).get(
        conversationId,
      )
    : undefined;
  const map = (rows: DirectConversationMessageRow[]) =>
    rows.map((row) => toAgentMessage(row, canonicalTarget, agentId, coordination));
  const isHistoryRead = Boolean(page.before || page.after || page.around);
  const advanceReadThrough = async (sequence: number) => {
    const publication = await advanceAgentReadPosition({
      db,
      memberId: agentMember.id,
      conversationId,
      workspaceId,
      agentId,
      threadRootId,
      sequence,
      publishConversationRead: isChannel || isUserAgentDirectConversation,
    });
    if (publication) void conversationReadChanged?.(publication)?.catch(() => {});
  };
  // An `unread` read starts at the read position. A latest page moves it only when the shared
  // contiguity rule proves that it joins the existing read-through; an anchored page never joins.
  const window =
    page.around && anchor
      ? await readWindowAround(db, scope, anchor.sequence, limit)
      : !page.unread &&
          !isHistoryRead &&
          page.fromSequence === undefined &&
          page.throughSequence === undefined
        ? await readLatestWindow(db, scope, limit)
        : undefined;
  if (window) {
    const latestSequence = window.rows.at(-1)?.sequence ?? readThrough;
    // An anchored page never joins: jumping to a middle message says nothing about what sits
    // between it and the read-through, so it reports no boundary and moves nothing.
    const modelSeenUpToSeq = page.around
      ? null
      : agentHistoryModelSeenBoundary({
          anchor: "latest",
          readThrough,
          minSequence: window.rows[0]?.sequence,
          maxSequence: latestSequence,
          hasOlder: window.hasOlder,
          sequenceBeforePage:
            "sequenceBeforePage" in window && typeof window.sequenceBeforePage === "number"
              ? window.sequenceBeforePage
              : undefined,
        });
    const agentReadThroughSequence =
      modelSeenUpToSeq !== null && modelSeenUpToSeq > readThrough ? modelSeenUpToSeq : 0;
    if (agentReadThroughSequence) await advanceReadThrough(agentReadThroughSequence);
    return {
      messages: map(window.rows),
      hasOlder: window.hasOlder,
      hasNewer: window.hasNewer,
      modelSeenUpToSeq,
      consumptionScope,
      ...readPositionReport(page.unread, isHistoryRead, { readThrough }),
      ...(agentReadThroughSequence ? { readPositionAfter: agentReadThroughSequence } : {}),
    };
  }
  const effectiveFromSequence = isHistoryRead
    ? page.fromSequence
    : (page.fromSequence ?? readThrough + 1);
  const effectiveSequence = {
    ...(effectiveFromSequence !== undefined ? { gte: effectiveFromSequence } : {}),
    ...(page.throughSequence !== undefined ? { lte: page.throughSequence } : {}),
    ...(anchor && page.before ? { lt: anchor.sequence } : {}),
    ...(anchor && page.after ? { gt: anchor.sequence } : {}),
  };
  const rows = await db.message.findMany({
    where: {
      ...scope,
      ...(Object.keys(effectiveSequence).length ? { sequence: effectiveSequence } : {}),
    },
    orderBy: { sequence: page.before ? "desc" : "asc" },
    take: limit + 1,
    include,
  });
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit).sort((a, b) => a.sequence - b.sequence);
  // An unread read lists what others wrote; the Agent's own messages sit under the same
  // read-through the page moves, so they are consumed without being listed.
  const messages = map(
    page.unread ? pageRows.filter((row) => row.sender?.agentId !== agentId) : pageRows,
  );
  const hasOlder = page.after
    ? await anchorSideHasMessages(db, scope, anchor, "older")
    : page.before
      ? hasMore
      : false;
  // Decided against the read-through as it was before this read moves it.
  const modelSeenUpToSeq = agentHistoryModelSeenBoundary({
    anchor: page.before ? "before" : page.after ? "after" : undefined,
    anchorSequence: anchor?.sequence,
    fromSequence: page.fromSequence,
    readThrough,
    minSequence: pageRows[0]?.sequence,
    maxSequence: pageRows.at(-1)?.sequence,
    hasOlder,
  });
  // One contiguity rule: a page that joins what the Agent had read both reports its boundary and
  // moves the read-through there.
  const agentReadThroughSequence =
    modelSeenUpToSeq !== null && modelSeenUpToSeq > readThrough ? modelSeenUpToSeq : 0;
  if (agentReadThroughSequence) await advanceReadThrough(agentReadThroughSequence);
  return {
    messages,
    hasOlder,
    hasNewer: page.before
      ? await anchorSideHasMessages(db, scope, anchor, "newer")
      : page.after || !isHistoryRead
        ? hasMore
        : false,
    modelSeenUpToSeq,
    consumptionScope,
    ...readPositionReport(page.unread, isHistoryRead, {
      readThrough,
      modelSeenUpToSeq,
      hasMore,
    }),
  };
}
