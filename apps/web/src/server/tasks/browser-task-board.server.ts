import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { bestEffortMessageNotifier } from "#src/server/notifications/web-push-composition.server";
import { TaskBoard } from "./task-board.server";

type Database = Parameters<typeof bestEffortMessageNotifier>[0];

/** The board a person's Task writes go through: signalled, pushed and delivered. */
export function browserTaskBoard(db: Database) {
  const centrifugo = createCentrifugoServerApi();
  return new TaskBoard(db, {
    notifications: bestEffortMessageNotifier(db),
    realtime: new CentrifugoConversationRealtime(centrifugo),
    publisher: centrifugo,
  });
}

/**
 * Announces the Task a person's send made of its message (`sentMessageBecomesTask`). The Task
 * committed with the message, so a failed announcement fails nothing: open pages catch up on
 * their next read, as with any missed realtime event.
 */
export async function announceSentTask(
  db: Database,
  conversation: { conversationId: string; workspaceId: string },
  messageId: string,
) {
  await browserTaskBoard(db)
    .announceSentTask(conversation, messageId)
    .catch(() => undefined);
}
