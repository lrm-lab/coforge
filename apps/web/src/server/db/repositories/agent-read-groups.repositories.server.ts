import {
  advanceAgentReadPosition,
  type AgentReadChangedInput,
  type AgentReadPositionInput,
} from "#src/server/conversations/agent-read-realtime.server";

export type AgentReadGroup = {
  conversationId: string;
  threadRootId: string | null;
  maxSequence: number;
};

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
