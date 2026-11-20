import { afterAll, beforeEach } from "bun:test";
import {
  channelThreadUnreadQueueReady,
  prepareAppNotificationQueues,
  stopAppNotificationQueue,
} from "#src/server/app-notifications/app-notification-queue.server";

// The integration runner exercises services directly while Centrifugo is configured. These
// tests have no SSR entry to prepare the transactional outbox, and some suites stop the queue
// between files. Prepare the producer before their writes, without starting any workers.
beforeEach(async () => {
  if (!channelThreadUnreadQueueReady()) await prepareAppNotificationQueues();
});

afterAll(stopAppNotificationQueue);
