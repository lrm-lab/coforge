import {
  REMINDER_DUE_CAPABILITY,
  REMINDER_DUE_MESSAGE_TYPE,
  decodeReminderDue,
  encodeReminderDue,
  type ReminderDueAckRequest,
} from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { nextOccurrence } from "#src/server/reminders/reminders.server";
import {
  REMINDER_DUE_RETENTION_MS,
  type ReminderComputerScope,
  type ReminderDueStore,
} from "#src/server/reminders/reminder-due-worker.server";

const BATCH_SIZE = 100;

export class PrismaReminderDueRepository implements ReminderDueStore {
  constructor(private readonly db: PrismaClient) {}

  async record(
    workspaceId: string,
    computerId: string,
    capabilities: readonly string[],
    identity: { workerInstanceId: string; startedAt: number },
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const changed = await tx.workspaceComputer.updateMany({
        where: {
          workspaceId,
          computerId,
          OR: [
            { readyStartedAt: null },
            { readyStartedAt: { lt: BigInt(identity.startedAt) } },
            {
              readyStartedAt: BigInt(identity.startedAt),
              readyWorkerInstanceId: identity.workerInstanceId,
            },
          ],
        },
        data: {
          readyCapabilities: [...capabilities],
          readyStartedAt: BigInt(identity.startedAt),
          readyWorkerInstanceId: identity.workerInstanceId,
        },
      });
      if (changed.count && !capabilities.includes(REMINDER_DUE_CAPABILITY))
        await tx.reminderOccurrence.updateMany({
          where: { workspaceId, computerId, status: "pending" },
          data: { status: "expiring" },
        });
    });
  }

  async claim(now: Date): Promise<void> {
    const candidates = await this.db.$queryRaw<
      Array<{ id: string; ownerAgentId: string; workspaceId: string; computerId: string }>
    >`
      SELECT r."id", r."ownerAgentId", r."workspaceId", r."computerId" FROM "reminders" r
      JOIN "agents" a ON a."id" = r."ownerAgentId" AND a."workspaceId" = r."workspaceId" AND a."computerId" = r."computerId"
      JOIN "workspace_memberships" m ON m."workspaceId" = a."workspaceId" AND m."userId" = a."ownerId"
      JOIN "workspace_computers" wc ON wc."workspaceId" = r."workspaceId" AND wc."computerId" = r."computerId"
      WHERE r."status" = 'scheduled' AND r."fireAt" <= ${now} AND a."deletedAt" IS NULL
        AND ${REMINDER_DUE_CAPABILITY} = ANY(wc."readyCapabilities")
      ORDER BY r."fireAt", r."id" LIMIT ${BATCH_SIZE}`;
    for (const candidate of candidates) {
      const occurrence = await this.db.$transaction(async (tx) => {
        const lockedAgent = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT a."id" FROM "agents" a
          JOIN "workspace_memberships" m ON m."workspaceId" = a."workspaceId" AND m."userId" = a."ownerId"
          WHERE a."id" = ${candidate.ownerAgentId}::uuid AND a."workspaceId" = ${candidate.workspaceId}::uuid
            AND a."computerId" = ${candidate.computerId}::uuid AND a."deletedAt" IS NULL
          FOR UPDATE OF a SKIP LOCKED`;
        if (!lockedAgent.length) return;
        const capable = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "workspace_computers" WHERE "workspaceId" = ${candidate.workspaceId}::uuid
            AND "computerId" = ${candidate.computerId}::uuid AND ${REMINDER_DUE_CAPABILITY} = ANY("readyCapabilities")
          FOR SHARE SKIP LOCKED`;
        if (!capable.length) return;
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "reminders" WHERE "id" = ${candidate.id}::uuid
          AND "status" = 'scheduled' AND "fireAt" <= ${now} FOR UPDATE SKIP LOCKED`;
        if (!locked.length) return;
        const reminder = await tx.reminder.findUniqueOrThrow({ where: { id: candidate.id } });
        const next = reminder.repeat
          ? nextOccurrence(reminder.repeat, reminder.timezone!, reminder.fireAt, now)
          : undefined;
        const due = {
          protocolMajor: 1,
          occurrenceId: crypto.randomUUID(),
          workspaceId: reminder.workspaceId,
          computerId: reminder.computerId,
          agentId: reminder.ownerAgentId,
          messageType: REMINDER_DUE_MESSAGE_TYPE,
          expiresAt: new Date(reminder.fireAt.getTime() + REMINDER_DUE_RETENTION_MS).toISOString(),
          job: {
            reminderId: reminder.id,
            ownerAgentId: reminder.ownerAgentId,
            version: reminder.version,
            title: reminder.title,
            target: reminder.target,
            messageId: reminder.messageId,
            fireAt: reminder.fireAt.toISOString(),
          },
        };
        await tx.reminderOccurrence.updateMany({
          where: { reminderId: reminder.id, status: "pending" },
          data: { status: "superseded" },
        });
        await tx.reminderOccurrence.create({
          data: {
            id: due.occurrenceId,
            reminderId: reminder.id,
            workspaceId: reminder.workspaceId,
            computerId: reminder.computerId,
            agentId: reminder.ownerAgentId,
            version: reminder.version,
            scheduledFor: reminder.fireAt,
            claimedAt: now,
            nextPublishAt: now,
            expiresAt: new Date(due.expiresAt),
            payload: new Uint8Array(encodeReminderDue(due)),
          },
        });
        await tx.reminderEvent.create({
          data: {
            reminderId: reminder.id,
            workspaceId: reminder.workspaceId,
            type: "fired",
            title: reminder.title,
            time: now,
            scheduledFor: reminder.fireAt,
            nextFireAt: next,
          },
        });
        await tx.reminder.update({
          where: { id: reminder.id },
          data: {
            version: { increment: 1 },
            firedAt: now,
            ...(next ? { fireAt: next } : { status: "fired" }),
          },
        });
        return due;
      });
      if (occurrence)
        console.info(
          JSON.stringify({
            event: "reminder.due_claimed",
            occurrence_id: occurrence.occurrenceId,
            reminder_id: occurrence.job.reminderId,
            revision: occurrence.job.version,
            delay_ms: now.getTime() - Date.parse(occurrence.job.fireAt),
            deduplicated: false,
          }),
        );
    }
  }

  async expire(now: Date) {
    const rows = await this.db.$transaction(
      (tx) => tx.$queryRaw<Array<{ payload: Uint8Array }>>`
      WITH expired AS (
        SELECT o."id" FROM "reminder_occurrences" o
        WHERE (o."status" = 'expiring' OR (o."status" = 'pending' AND (o."expiresAt" <= ${now} OR NOT EXISTS (
          SELECT 1 FROM "workspace_computers" wc JOIN "agents" a
            ON a."workspaceId" = wc."workspaceId" AND a."computerId" = wc."computerId"
          JOIN "workspace_memberships" m ON m."workspaceId" = a."workspaceId" AND m."userId" = a."ownerId"
          WHERE wc."workspaceId" = o."workspaceId" AND wc."computerId" = o."computerId"
            AND a."id" = o."agentId" AND a."deletedAt" IS NULL
            AND ${REMINDER_DUE_CAPABILITY} = ANY(wc."readyCapabilities")
        )))) ORDER BY o."expiresAt", o."id" LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
      ) UPDATE "reminder_occurrences" o SET "status" = 'expired' FROM expired
        WHERE o."id" = expired."id" RETURNING o."payload"`,
    );
    return rows.map((row) => decodeReminderDue(row.payload));
  }

  async pending(now: Date, scope?: ReminderComputerScope) {
    const rows = await this.db.$transaction(
      (tx) => tx.$queryRaw<Array<{ payload: Uint8Array }>>`
      WITH selected AS (
        SELECT o."id" FROM "reminder_occurrences" o
        JOIN "reminders" r ON r."id" = o."reminderId" AND r."workspaceId" = o."workspaceId"
        JOIN "agents" a ON a."id" = o."agentId" AND a."workspaceId" = o."workspaceId" AND a."computerId" = o."computerId"
        JOIN "workspace_memberships" m ON m."workspaceId" = a."workspaceId" AND m."userId" = a."ownerId"
        JOIN "workspace_computers" wc ON wc."workspaceId" = o."workspaceId" AND wc."computerId" = o."computerId"
        WHERE o."status" = 'pending' AND o."expiresAt" > ${now} AND a."deletedAt" IS NULL
          AND r."status" <> 'canceled' AND ${REMINDER_DUE_CAPABILITY} = ANY(wc."readyCapabilities")
          AND (${scope?.workspaceId ?? null}::uuid IS NULL OR o."workspaceId" = ${scope?.workspaceId ?? null}::uuid)
          AND (${scope?.computerId ?? null}::uuid IS NULL OR o."computerId" = ${scope?.computerId ?? null}::uuid)
          AND (${Boolean(scope)} OR o."nextPublishAt" <= ${now})
        ORDER BY o."nextPublishAt", o."id" LIMIT ${BATCH_SIZE} FOR UPDATE OF o SKIP LOCKED
      ) UPDATE "reminder_occurrences" o SET "nextPublishAt" = ${new Date(now.getTime() + 15_000)}
        FROM selected WHERE o."id" = selected."id" RETURNING o."payload"`,
    );
    return rows.map((row) => decodeReminderDue(row.payload));
  }

  async acknowledge(request: ReminderDueAckRequest, now: Date): Promise<boolean> {
    const where = {
      id: request.occurrenceId,
      reminderId: request.reminderId,
      version: request.version,
      workspaceId: request.workspaceId,
      computerId: request.computerId,
      agentId: request.agentId,
    };
    const changed = await this.db.reminderOccurrence.updateMany({
      where: { ...where, status: "pending", expiresAt: { gt: now } },
      data: { status: "delivered", deliveredAt: now },
    });
    if (changed.count) return true;
    return Boolean(
      await this.db.reminderOccurrence.findFirst({ where: { ...where, status: "delivered" } }),
    );
  }
}
