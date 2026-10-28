import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { conversationRealtimeChannel } from "#src/features/conversations/conversation-realtime";
import { errorType } from "#src/server/errors/error-type.server";
import type { ConversationReadChangedInput } from "#src/server/db/repositories/agent-read-position.repositories.server";
export type { ConversationReadChangedInput } from "#src/server/db/repositories/agent-read-position.repositories.server";
import type { ConversationRealtime } from "./conversation-realtime.server";

export function publishConversationReadChanged(
  centrifugo: Pick<CentrifugoServerApi, "publishJson">,
  input: ConversationReadChangedInput,
) {
  return centrifugo.publishJson(
    conversationRealtimeChannel(input.conversationId),
    {
      type: "conversation.read.v1",
      conversationId: input.conversationId,
      memberId: input.memberId,
      readThroughSequence: input.readThroughSequence,
    },
    `${input.conversationId}:read:${input.memberId}:${input.readThroughSequence}`,
  );
}

export async function announceConversationReadChanged(
  realtime: Pick<ConversationRealtime, "conversationReadChanged"> | undefined,
  input: ConversationReadChangedInput,
) {
  try {
    await (realtime?.conversationReadChanged?.(input) ??
      publishConversationReadChanged(createCentrifugoServerApi(), input));
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "conversation_realtime:conversation_read_failed",
        workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        member_id: input.memberId,
        error_type: errorType(error),
      }),
    );
  }
}
