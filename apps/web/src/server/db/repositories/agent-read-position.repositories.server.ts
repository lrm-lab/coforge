import { advanceAgentRead } from "./thread-read-position.server";

export type AgentReadChangedInput = {
  workspaceId: string;
  conversationId: string;
  agentId: string;
  readThroughSequence: number;
};

export type AgentReadPositionInput = {
  db: Parameters<typeof advanceAgentRead>[0];
  memberId?: string;
  conversationId: string;
  workspaceId: string;
  agentId: string;
  threadRootId?: string | null;
  sequence: number;
  isDirectConversation: boolean;
};

export async function advanceAgentReadPosition(input: AgentReadPositionInput) {
  const advanced = await advanceAgentRead(input.db, {
    memberId: input.memberId ?? "",
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    threadRootId: input.threadRootId ?? null,
    sequence: input.sequence,
  });
  return advanced && input.isDirectConversation && !input.threadRootId
    ? {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        agentId: input.agentId,
        readThroughSequence: input.sequence,
      }
    : undefined;
}
