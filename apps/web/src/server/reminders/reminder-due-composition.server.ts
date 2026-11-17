import { encodeReminderDue } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaReminderDueRepository } from "#src/server/db/repositories/reminder-due.repositories.server";
import {
  daemonControlChannel,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { ReminderDueWorker } from "./reminder-due-worker.server";

export function createReminderDueWorker(db: PrismaClient, centrifugo: CentrifugoServerApi) {
  return new ReminderDueWorker(new PrismaReminderDueRepository(db), (dues) =>
    centrifugo.publishBatch(
      dues.map((due) => ({
        channel: daemonControlChannel(due.workspaceId, due.computerId),
        data: encodeReminderDue(due),
      })),
    ),
  );
}
