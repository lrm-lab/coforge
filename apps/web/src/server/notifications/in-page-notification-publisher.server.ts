import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import {
  userConversationChannel,
  type NotificationAvailableEvent,
} from "#src/features/conversations/conversation-realtime";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { NotificationPublisher } from "./web-push-notifications.server";

const MAX_BATCH_SIZE = 100;

type PendingPublication = {
  publication: { channel: string; data: NotificationAvailableEvent; idempotencyKey: string };
  resolve: () => void;
  reject: (reason: unknown) => void;
};

export function createCentrifugoNotificationPublisher(
  centrifugo: Pick<CentrifugoServerApi, "publishJsonBatch">,
): NotificationPublisher {
  let pending: PendingPublication[] = [];

  async function publish(batch: PendingPublication[]) {
    try {
      const replies = await centrifugo.publishJsonBatch(
        batch.map(({ publication }) => publication),
      );
      batch.forEach(({ resolve, reject }, index) => {
        const reply = replies[index];
        if (reply?.status === "fulfilled") resolve();
        else reject(reply?.reason ?? new Error("missing notification publication result"));
      });
    } catch (error) {
      batch.forEach(({ reject }) => reject(error));
    }
  }

  function flush() {
    const ready = pending;
    pending = [];
    for (let offset = 0; offset < ready.length; offset += MAX_BATCH_SIZE) {
      void publish(ready.slice(offset, offset + MAX_BATCH_SIZE));
    }
  }

  return {
    notifyRecipient({ userId, ...decision }) {
      const data: NotificationAvailableEvent = {
        type: REALTIME_EVENTS.notificationAvailable,
        ...decision,
      };
      return new Promise<void>((resolve, reject) => {
        if (pending.length === 0) setTimeout(flush, 0);
        pending.push({
          publication: {
            channel: userConversationChannel(userId),
            data,
            idempotencyKey: `notification:v2:${data.messageId}`,
          },
          resolve,
          reject,
        });
      });
    },
  };
}
