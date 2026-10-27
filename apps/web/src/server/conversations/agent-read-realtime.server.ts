import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { conversationRealtimeChannel } from "#src/features/conversations/conversation-realtime";
import { advanceAgentRead } from "#src/server/db/repositories/thread-read-position.server";

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

export function publishAgentReadChanged(
  centrifugo: CentrifugoServerApi,
  input: AgentReadChangedInput,
) {
  return centrifugo.publishJson(
    conversationRealtimeChannel(input.conversationId),
    { type: "conversation.agent_read.v1", ...input },
    `${input.conversationId}:agent-read:${input.agentId}:${input.readThroughSequence}`,
  );
}
