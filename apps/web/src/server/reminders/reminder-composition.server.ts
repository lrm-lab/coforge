import { encodeReminderSync } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaReminderRepository } from "#src/server/db/repositories/reminder.repositories.server";
import {
  daemonControlChannel,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { Reminders, type ReminderCapabilityLease } from "./reminders.server";

export function createReminders(
  db: PrismaClient,
  centrifugo: CentrifugoServerApi,
  lease: ReminderCapabilityLease,
) {
  return new Reminders(new PrismaReminderRepository(db), lease, (sync) =>
    centrifugo.publish(
      daemonControlChannel(sync.workspaceId, sync.computerId),
      encodeReminderSync(sync),
    ),
  );
}
