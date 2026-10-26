import { planCommentMigrationReads } from "./attachment-comment-migration-reads.server";

type MessageIdentity = {
  id: string;
  conversationId: string;
  workspaceId: string;
  threadRootId: string | null;
};

export type AttachmentCommentMigrationSnapshot = {
  threads: {
    attachmentId: string;
    workspaceId: string;
    conversationId: string;
    sourceConversationId: string;
    sourceKind: string | null;
    legacyKind: string | null;
    source: (MessageIdentity & { threadRoot: MessageIdentity | null }) | null;
  }[];
  messages: (MessageIdentity & {
    sequence: number;
    createdAt: string;
    attachmentId: string | null;
    sender: { userId: string | null; agentId: string | null } | null;
  })[];
  lastSequences: { conversationId: string; sequence: number }[];
  members: {
    id: string;
    conversationId: string;
    userId: string | null;
    agentId: string | null;
    readThroughSequence: number;
    agentReadThroughSequence: number;
    doneThroughSequence: number | null;
    unreadFromSequence: number | null;
  }[];
  sourceReplies: { id: string; conversationId: string; threadRootId: string; sequence: number }[];
  threadReads: {
    memberId: string;
    conversationId: string;
    rootMessageId: string;
    readThroughSequence: number;
    doneThroughSequence: number | null;
  }[];
  assistantSessions: { id: string; agentId: string; workspaceId: string }[];
  assistantCursors: {
    sessionId: string;
    conversationId: string;
    scope: string;
    readThroughSequence: number;
  }[];
  referencedMembers: { memberId: string; conversationId: string }[];
  reactionCount: number;
  unboundConversationIds: string[];
  unexpectedDependencies: { schema: string; table: string; constraint: string; count: number }[];
};

export type AttachmentCommentMigrationPlan = {
  status: "ready" | "blocked";
  counts: { attachments: number; messages: number; reactions: number; historicalSeats: number };
  blockers: {
    code: string;
    attachmentId?: string;
    conversationId?: string;
    schema?: string;
    table?: string;
    constraint?: string;
    count?: number;
  }[];
  threadReadMappings: {
    memberId: string;
    conversationId: string;
    rootMessageId: string;
    readThroughSequence: number;
    doneThroughSequence: number | null;
    reunreadMessages: number;
  }[];
  assistantReadMappings: {
    sessionId: string;
    conversationId: string;
    scope: string;
    readThroughSequence: number;
    reunreadMessages: number;
  }[];
  memberMappings: {
    fromMemberId: string;
    conversationId: string;
    targetMemberId: string | null;
    userId: string | null;
    agentId: string | null;
    createInactive: boolean;
  }[];
  moves: {
    messageId: string;
    conversationId: string;
    threadRootId: string;
    sequence: number;
  }[];
};

/** Sequence is authoritative within each old discussion; timestamps merge independent ones. */
export function planAttachmentCommentMigration(
  snapshot: AttachmentCommentMigrationSnapshot,
): AttachmentCommentMigrationPlan {
  const plan: AttachmentCommentMigrationPlan = {
    status: "ready",
    counts: {
      attachments: snapshot.threads.length,
      messages: snapshot.messages.length,
      reactions: snapshot.reactionCount,
      historicalSeats: 0,
    },
    blockers: [],
    moves: [],
    memberMappings: [],
    threadReadMappings: [],
    assistantReadMappings: [],
  };
  for (const conversationId of snapshot.unboundConversationIds) {
    plan.blockers.push({ code: "unbound-legacy-conversation", conversationId });
  }
  for (const dependency of snapshot.unexpectedDependencies) {
    plan.blockers.push({ code: "unexpected-dependency", ...dependency });
  }
  for (const cursor of snapshot.assistantCursors) {
    const old = snapshot.threads.find((row) => row.conversationId === cursor.conversationId);
    const source = snapshot.threads.find(
      (row) =>
        row.sourceConversationId === cursor.conversationId &&
        row.source &&
        (row.source.threadRootId ?? row.source.id) === cursor.scope,
    );
    const thread = old ?? source;
    if (!thread) continue;
    const session = snapshot.assistantSessions.find((row) => row.id === cursor.sessionId);
    const root = snapshot.messages.find(
      (row) =>
        row.id === cursor.scope &&
        row.conversationId === cursor.conversationId &&
        row.threadRootId === null,
    );
    if (
      !session ||
      session.workspaceId !== thread.workspaceId ||
      (old && cursor.scope !== "" && !root)
    ) {
      plan.blockers.push({
        code: "invalid-assistant-cursor",
        conversationId: cursor.conversationId,
      });
    }
  }
  for (const thread of snapshot.threads) {
    const block = (code: string) => plan.blockers.push({ code, attachmentId: thread.attachmentId });
    if (thread.sourceKind !== null) block("invalid-source-conversation");
    if (thread.legacyKind !== "attachment_comments") block("invalid-legacy-conversation");
    const source = thread.source;
    if (!source) {
      block("missing-source-message");
    } else {
      if (
        source.conversationId !== thread.sourceConversationId ||
        source.workspaceId !== thread.workspaceId
      )
        block("source-scope-mismatch");
      if (
        source.threadRootId &&
        (!source.threadRoot ||
          source.threadRoot.id === source.id ||
          source.threadRoot.threadRootId !== null ||
          source.threadRoot.conversationId !== thread.sourceConversationId ||
          source.threadRoot.workspaceId !== thread.workspaceId)
      )
        block("invalid-source-root");
    }
    for (const message of snapshot.messages.filter(
      (row) => row.conversationId === thread.conversationId,
    )) {
      if (
        message.attachmentId !== thread.attachmentId ||
        message.workspaceId !== thread.workspaceId
      )
        block("unbound-legacy-message");
      if (!message.sender || Boolean(message.sender.userId) === Boolean(message.sender.agentId))
        block("invalid-message-actor");
    }
    const last =
      snapshot.lastSequences.find((row) => row.conversationId === thread.sourceConversationId)
        ?.sequence ?? 0;
    const incomingIds = new Set(
      snapshot.threads
        .filter((row) => row.sourceConversationId === thread.sourceConversationId)
        .map((row) => row.conversationId),
    );
    const incoming = snapshot.messages.filter((row) => incomingIds.has(row.conversationId)).length;
    if (last + incoming > 2_147_483_647) block("sequence-overflow");
  }
  if (plan.blockers.length) return { ...plan, status: "blocked" };

  const mappingKeys = new Set<string>();
  const historicalSeats = new Set<string>();
  for (const reference of snapshot.referencedMembers) {
    const thread = snapshot.threads.find((row) => row.conversationId === reference.conversationId);
    const member = snapshot.members.find((row) => row.id === reference.memberId);
    if (
      !thread ||
      !member ||
      member.conversationId !== reference.conversationId ||
      Boolean(member.userId) === Boolean(member.agentId)
    ) {
      plan.blockers.push({
        code: "invalid-referenced-actor",
        conversationId: reference.conversationId,
      });
      continue;
    }
    const key = `${member.id}:${thread.sourceConversationId}`;
    if (mappingKeys.has(key)) continue;
    mappingKeys.add(key);
    const target = snapshot.members.find(
      (row) =>
        row.conversationId === thread.sourceConversationId &&
        row.userId === member.userId &&
        row.agentId === member.agentId,
    );
    if (!target)
      historicalSeats.add(`${thread.sourceConversationId}:${member.userId ?? member.agentId}`);
    plan.memberMappings.push({
      fromMemberId: member.id,
      conversationId: thread.sourceConversationId,
      targetMemberId: target?.id ?? null,
      userId: member.userId,
      agentId: member.agentId,
      createInactive: !target,
    });
  }
  if (plan.blockers.length) return { ...plan, status: "blocked", memberMappings: [] };
  plan.memberMappings.sort((a, b) => a.fromMemberId.localeCompare(b.fromMemberId));
  plan.counts.historicalSeats = historicalSeats.size;

  const sequences = new Map(
    snapshot.lastSequences.map((row) => [row.conversationId, row.sequence]),
  );
  const conversations = [
    ...new Set(snapshot.threads.map((thread) => thread.sourceConversationId)),
  ].sort();
  for (const conversationId of conversations) {
    const discussions = snapshot.threads
      .filter((thread) => thread.sourceConversationId === conversationId)
      .map((thread) => ({
        thread,
        messages: snapshot.messages
          .filter((message) => message.conversationId === thread.conversationId)
          .sort((a, b) => a.sequence - b.sequence),
      }));
    let sequence = sequences.get(conversationId) ?? 0;
    while (true) {
      const available = discussions.filter((discussion) => discussion.messages.length);
      if (!available.length) break;
      available.sort((a, b) => {
        const first = a.messages[0]!;
        const second = b.messages[0]!;
        return (
          Date.parse(first.createdAt) - Date.parse(second.createdAt) ||
          a.thread.conversationId.localeCompare(b.thread.conversationId)
        );
      });
      const selected = available[0]!;
      const message = selected.messages.shift()!;
      plan.moves.push({
        messageId: message.id,
        conversationId,
        threadRootId: selected.thread.source!.threadRootId ?? selected.thread.source!.id,
        sequence: ++sequence,
      });
    }
  }
  Object.assign(plan, planCommentMigrationReads(snapshot, plan.moves));
  return plan;
}
