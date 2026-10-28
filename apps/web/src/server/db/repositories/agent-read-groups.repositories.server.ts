import {
  advanceAgentReadPosition,
  type ConversationReadChangedInput,
  type AgentReadPositionInput,
} from "./agent-read-position.repositories.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";

export type ConversationReadRealtimePort = Pick<ConversationRealtime, "conversationReadChanged">;

export type AgentReadGroup = {
  conversationId: string;
  threadRootId: string | null;
  maxSequence: number;
};

export function agentReadGroupsForPage(
  rows: readonly {
    conversationId: string;
    threadRootId: string | null;
    sequence: number;
    nonMemberMention?: boolean;
  }[],
) {
  const groups = new Map<string, AgentReadGroup>();
  for (const row of rows) {
    if (row.nonMemberMention) continue;
    const key = `${row.conversationId}:${row.threadRootId ?? ""}`;
    const existing = groups.get(key);
    if (!existing || row.sequence > existing.maxSequence)
      groups.set(key, {
        conversationId: row.conversationId,
        threadRootId: row.threadRootId,
        maxSequence: row.sequence,
      });
  }
  return groups;
}

export function conversationReadPublicationMap(
  rows: readonly {
    conversationId: string;
    conversation: { channelName: string | null; directKey: string | null };
  }[],
  isUserAgentDirectConversation: (conversation: { directKey: string | null }) => boolean,
) {
  return new Map(
    rows.map((row) => [
      row.conversationId,
      row.conversation.channelName !== null || isUserAgentDirectConversation(row.conversation),
    ]),
  );
}

export function conversationReadChangedPort(realtime: ConversationReadRealtimePort | undefined) {
  return realtime?.conversationReadChanged?.bind(realtime);
}

export async function advanceAgentReadGroups(input: {
  db: AgentReadPositionInput["db"];
  groups: Iterable<AgentReadGroup>;
  memberIdByConversation: ReadonlyMap<string, string>;
  messageRows: readonly {
    conversationId: string;
    conversation: { channelName: string | null; directKey: string | null };
  }[];
  isUserAgentDirectConversation: (conversation: { directKey: string | null }) => boolean;
  workspaceId: string;
  agentId: string;
}) {
  const changes: ConversationReadChangedInput[] = [];
  const publishReadByConversation = conversationReadPublicationMap(
    input.messageRows,
    input.isUserAgentDirectConversation,
  );
  for (const group of input.groups) {
    const memberId = input.memberIdByConversation.get(group.conversationId);
    if (!memberId) throw new Error("Agent is not a conversation member");
    const publication = await advanceAgentReadPosition({
      db: input.db,
      memberId,
      conversationId: group.conversationId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      ...(group.threadRootId ? { threadRootId: group.threadRootId } : {}),
      sequence: group.maxSequence,
      publishConversationRead: publishReadByConversation.get(group.conversationId) === true,
    });
    if (publication) changes.push(publication);
  }
  return changes;
}

export async function publishConversationReadChangesAfterCommit<T>(
  transaction: () => Promise<{
    result: T;
    conversationReadChanges: readonly ConversationReadChangedInput[];
  }>,
  publish?: (change: ConversationReadChangedInput) => Promise<void>,
) {
  const committed = await transaction();
  for (const change of committed.conversationReadChanges) void publish?.(change).catch(() => {});
  return committed.result;
}
