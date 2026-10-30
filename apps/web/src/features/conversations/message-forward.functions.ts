import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { searchForwardTargets } from "#src/server/conversations/forward-targets.server";
import { MessageForwards } from "#src/server/conversations/message-forwards.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { getFileStorage } from "#src/server/files/file-storage.server";
import { productionCloudComputers } from "#src/server/hosts/host-production.server";
import { bestEffortMessageNotifier } from "#src/server/notifications/web-push-composition.server";
import { forwardMessageInputSchema, forwardTargetsInputSchema } from "./message-forward";

/**
 * Forwards one message to one or more conversations, with an optional note. A source that cannot
 * be forwarded (a forward, an action card, a server notice, a message the person cannot see)
 * rejects the whole request; each destination then succeeds or fails on its own, and a retry with
 * the same `requestId` sends only to those that failed. A channel the person has not joined fails
 * with `not_joined`: the client asks, joins it, and retries.
 */
export const forwardMessage = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(forwardMessageInputSchema)
  .handler(async ({ context: { db, user, workspaceId }, data }) => {
    const centrifugo = createCentrifugoServerApi();
    return new MessageForwards({
      db,
      idempotency: getMessageRequestIdempotency(),
      centrifugo,
      realtime: new CentrifugoConversationRealtime(centrifugo),
      notifications: bestEffortMessageNotifier(db),
      storage: getFileStorage,
      prepareDirect: (workspace, userId, conversationId) =>
        new WorkspaceAssistants(db).prepareConversation(
          workspace,
          userId,
          conversationId,
          (input) => productionCloudComputers(db).ensureDefault(input),
        ),
    }).forward({
      workspaceId,
      userId: user.id,
      requestId: data.requestId,
      sourceMessageId: data.sourceMessageIds[0]!,
      destinations: data.destinations,
      note: data.note,
    });
  });

/** The picker behind a forward: channels, members and Agents matching `q`, with whether each is
 * joined and can take the message. */
export const searchForwardDestinations = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(forwardTargetsInputSchema)
  .handler(({ context: { db, user, workspaceId }, data }) =>
    searchForwardTargets(db, { workspaceId, userId: user.id, q: data.q, limit: data.limit }),
  );
