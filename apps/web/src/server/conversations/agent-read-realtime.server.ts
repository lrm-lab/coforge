import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { conversationRealtimeChannel } from "#src/features/conversations/conversation-realtime";
import type { AgentReadChangedInput } from "#src/server/db/repositories/agent-read-position.repositories.server";

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
