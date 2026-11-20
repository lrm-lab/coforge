import { afterAll, beforeEach } from "bun:test";
import {
  channelThreadUnreadQueueReady,
  prepareAppNotificationQueues,
  stopAppNotificationQueue,
} from "#src/server/app-notifications/app-notification-queue.server";

beforeEach(async () => {
  if (!channelThreadUnreadQueueReady()) await prepareAppNotificationQueues();
});

afterAll(stopAppNotificationQueue);
