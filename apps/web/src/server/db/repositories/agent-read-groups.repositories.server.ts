import {
  advanceAgentReadPosition,
  type AgentReadChangedInput,
  type AgentReadPositionInput,
} from "./agent-read-position.repositories.server";

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

export async function advanceAgentReadGroups(input: {
  db: AgentReadPositionInput["db"];
  groups: Iterable<AgentReadGroup>;
  memberIdByConversation: ReadonlyMap<string, string>;
  directConversationById: ReadonlyMap<string, boolean>;
  workspaceId: string;
  agentId: string;
}) {
  const changes: AgentReadChangedInput[] = [];
  for (const group of input.groups) {
    const memberId = input.memberIdByConversation.get(group.conversationId);
    if (group.threadRootId && !memberId) throw new Error("Agent is not a conversation member");
    const publication = await advanceAgentReadPosition({
      db: input.db,
      memberId,
      conversationId: group.conversationId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      ...(group.threadRootId ? { threadRootId: group.threadRootId } : {}),
      sequence: group.maxSequence,
      isDirectConversation: input.directConversationById.get(group.conversationId) === true,
    });
    if (publication) changes.push(publication);
  }
  return changes;
}

export async function publishAgentReadChangesAfterCommit<T>(
  transaction: () => Promise<{
    result: T;
    agentReadChanges: readonly AgentReadChangedInput[];
  }>,
  publish?: (change: AgentReadChangedInput) => Promise<void>,
) {
  const committed = await transaction();
  for (const change of committed.agentReadChanges) void publish?.(change).catch(() => {});
  return committed.result;
}
