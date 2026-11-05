import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { errorType } from "#src/server/errors/error-type.server";
import {
  CentrifugoConversationRealtime,
  type ConversationRealtime,
} from "./conversation-realtime.server";

/**
 * One line each for the path a new direct conversation takes into its people's DM lists (task
 * #551): a DM opened or started, the `dm.created.v1` that tells the lists, and the Agent created
 * just before. Ids only: never a message body, a token or an email address.
 */

/** `direct_conversation.opened`: someone opened a DM, and whether this open started it. */
export function logDirectConversationOpened(input: {
  workspaceId: string;
  conversationId: string;
  userId: string;
  peer: { agentId: string } | { userId: string };
  created: boolean;
}) {
  console.info(
    JSON.stringify({
      event: "direct_conversation.opened",
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      user_id: input.userId,
      ...("agentId" in input.peer
        ? { peer_agent_id: input.peer.agentId }
        : { peer_user_id: input.peer.userId }),
      created: input.created,
    }),
  );
}

/**
 * Tells these people's pages a DM with them started (`dm.created.v1`), on their own channels, and
 * logs `direct_conversation.created_announced` with the recipients, the channels and whether the
 * publish went out. Best effort like every viewer event: a list that misses it reads again on the
 * next message from the other side, or on reload.
 */
export async function announceDirectConversationCreated(
  realtime: Pick<ConversationRealtime, "viewerChanged"> | undefined,
  input: { workspaceId: string; conversationId: string; userIds: readonly string[] },
) {
  const userIds = [...new Set(input.userIds)];
  if (userIds.length === 0) return;
  const line = {
    event: "direct_conversation.created_announced",
    workspace_id: input.workspaceId,
    conversation_id: input.conversationId,
    recipient_user_ids: userIds,
    recipient_count: userIds.length,
    channels: userIds.map(userConversationChannel),
  };
  try {
    const port = realtime ?? new CentrifugoConversationRealtime(createCentrifugoServerApi());
    await port.viewerChanged?.({
      userIds,
      event: {
        type: REALTIME_EVENTS.dmCreated,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
      },
    });
    console.info(JSON.stringify({ ...line, outcome: "sent" }));
  } catch (error) {
    console.warn(JSON.stringify({ ...line, outcome: "failed", error_type: errorType(error) }));
  }
}

/** `agent.created`: an Agent was created, by whom and on which Computer. */
export function logAgentCreated(input: {
  workspaceId: string;
  agentId: string;
  creatorUserId: string;
  computerId: string;
}) {
  console.info(
    JSON.stringify({
      event: "agent.created",
      workspace_id: input.workspaceId,
      agent_id: input.agentId,
      creator_user_id: input.creatorUserId,
      computer_id: input.computerId,
    }),
  );
}
