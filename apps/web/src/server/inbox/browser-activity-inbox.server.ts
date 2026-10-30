import type { PrismaClient } from "#src/generated/prisma/client";
import {
  createCentrifugoServerApi,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { ActivityInbox } from "./activity-inbox.server";

/**
 * The inbox a person's own pages write through. It publishes, so Done and Mark all read reach the
 * person's other tabs: an inbox built without realtime still writes, and those tabs keep a dot the
 * server has already cleared.
 */
export function browserActivityInbox(
  db: PrismaClient,
  centrifugo: CentrifugoServerApi = createCentrifugoServerApi(),
) {
  return new ActivityInbox(db, new CentrifugoConversationRealtime(centrifugo));
}
