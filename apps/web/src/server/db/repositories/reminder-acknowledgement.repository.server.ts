import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { ReminderRefusal, type StoredReminder } from "#src/server/reminders/reminders.server";
import { recordOperation, replayedOperation, summary } from "./reminder.repositories.server";

type Scope = { workspaceId: string; computerId: string; agentId: string; userId: string };

/** Records an acknowledgement without changing scheduling state. */
export async function acknowledgeReminder(
  db: PrismaClient,
  scope: Scope,
  requestId: string,
  fingerprint: string,
  id: string,
  revision: number,
  eventType: "acknowledged" | "dismissed",
  now: Date,
): Promise<StoredReminder> {
  return db.$transaction(
    async (tx) => {
      const authorized = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "agents"
        WHERE "id" = ${scope.agentId}::uuid AND "workspaceId" = ${scope.workspaceId}::uuid
          AND "ownerId" = ${scope.userId}::uuid AND "computerId" = ${scope.computerId}::uuid
        FOR UPDATE`;
      if (authorized.length !== 1)
        throw new ReminderRefusal("ACCESS_DENIED", "reminder operation is not authorized");
      const [membership, connection] = await Promise.all([
        tx.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId: scope.workspaceId, userId: scope.userId } },
          select: { userId: true },
        }),
        tx.workspaceComputer.findUnique({
          where: {
            workspaceId_computerId: {
              workspaceId: scope.workspaceId,
              computerId: scope.computerId,
            },
          },
          select: { id: true },
        }),
      ]);
      if (!membership || !connection)
        throw new ReminderRefusal("ACCESS_DENIED", "reminder operation is not authorized");
      await tx.$queryRaw`SELECT "id" FROM "reminders" WHERE "id" = ${id}::uuid AND "workspaceId" = ${scope.workspaceId}::uuid AND "ownerAgentId" = ${scope.agentId}::uuid AND "computerId" = ${scope.computerId}::uuid FOR UPDATE`;
      const replay = await replayedOperation(tx, scope, requestId, fingerprint, id);
      if (replay) return replay;
      const reminder = await tx.reminder.findFirst({
        where: {
          id,
          workspaceId: scope.workspaceId,
          ownerAgentId: scope.agentId,
          computerId: scope.computerId,
        },
      });
      if (!reminder) throw new ReminderRefusal("NOT_FOUND", "reminder not found");
      const occurrence = await tx.reminderOccurrence.findUnique({
        where: { reminderId_version: { reminderId: id, version: revision } },
      });
      if (occurrence) {
        if (
          occurrence.workspaceId !== scope.workspaceId ||
          occurrence.computerId !== scope.computerId ||
          occurrence.agentId !== scope.agentId ||
          occurrence.status !== "delivered"
        )
          throw new ReminderRefusal("CONFLICT", "reminder revision was not delivered");
        const already = await tx.reminderEvent.findFirst({
          where: {
            reminderId: id,
            workspaceId: scope.workspaceId,
            type: { in: ["acknowledged", "dismissed"] },
            scheduledFor: occurrence.scheduledFor,
          },
        });
        if (!already)
          await tx.reminderEvent.create({
            data: {
              reminderId: id,
              workspaceId: scope.workspaceId,
              type: eventType,
              title: reminder.title,
              time: now,
              scheduledFor: occurrence.scheduledFor,
            },
          });
        const result = summary(reminder);
        await recordOperation(tx, scope, requestId, fingerprint, id, result);
        return result;
      }
      const fireReceipts = await tx.reminderFireReceipt.findMany({
        where: {
          reminderId: id,
          workspaceId: scope.workspaceId,
          computerId: scope.computerId,
          agentId: scope.agentId,
        },
        orderBy: { version: "asc" },
        select: { version: true },
      });
      const index = fireReceipts.findIndex((receipt) => receipt.version === revision);
      if (index < 0) throw new ReminderRefusal("CONFLICT", "reminder revision was not fired");
      const fired = await tx.$queryRaw<Array<{ scheduledFor: Date }>>`
        SELECT e."scheduledFor" FROM "reminder_events" e
        WHERE e."reminderId" = ${id}::uuid AND e."workspaceId" = ${scope.workspaceId}::uuid
          AND e."type" = 'fired' AND NOT EXISTS (
            SELECT 1 FROM "reminder_occurrences" o
            WHERE o."reminderId" = e."reminderId" AND o."scheduledFor" = e."scheduledFor"
          ) ORDER BY e."time", e."id"`;
      const scheduledFor = fired[Math.min(index, fired.length - 1)]?.scheduledFor;
      if (!scheduledFor) throw new ReminderRefusal("CONFLICT", "reminder revision was not fired");
      const already = await tx.reminderEvent.findFirst({
        where: {
          reminderId: id,
          workspaceId: scope.workspaceId,
          type: { in: ["acknowledged", "dismissed"] },
          scheduledFor,
        },
      });
      if (!already)
        await tx.reminderEvent.create({
          data: {
            reminderId: id,
            workspaceId: scope.workspaceId,
            type: eventType,
            title: reminder.title,
            time: now,
            scheduledFor,
          },
        });
      const result = summary(reminder);
      await recordOperation(tx, scope, requestId, fingerprint, id, result);
      return result;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}
