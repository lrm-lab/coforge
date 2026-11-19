import {
  REMINDER_TRIGGER_CALLS_PER_MINUTE,
  REMINDER_TRIGGER_KEYS_PER_AGENT,
  type ReminderTriggerLevel,
} from "@lrm/coforge-sdk/internal";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import {
  decideReminderTrigger,
  type ReminderTriggerOutcome,
  type ReminderTriggerReceipt,
} from "#src/server/reminders/reminder-trigger-decision.server";
import { ReminderRefusal } from "#src/server/reminders/reminders.server";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const EVENT_RETENTION_MS = 7 * 86_400_000;
const EVENTS_PER_KEY = 1000;
const PRUNE_BATCH = 1000;

type TriggerScope = { workspaceId: string; agentId: string; computerId: string };

export type RecordReminderTriggerInput = {
  key: string;
  level: ReminderTriggerLevel;
  mergeWindowSeconds: number;
  title: string;
  details?: string;
  requestId: string;
  now: Date;
  deliverWake: boolean;
};

export type ReminderTriggerRecord = {
  outcome: ReminderTriggerOutcome;
  receipt: ReminderTriggerReceipt;
};

type LockedTrigger = {
  id: string;
  windowEndsAt: Date | null;
  pendingCount: number;
  firstPendingAt: Date | null;
};

async function lockTrigger(
  tx: Prisma.TransactionClient,
  scope: TriggerScope,
  key: string,
): Promise<LockedTrigger | undefined> {
  const rows = await tx.$queryRaw<LockedTrigger[]>`
    SELECT "id", "windowEndsAt", "pendingCount", "firstPendingAt"
    FROM "reminder_triggers"
    WHERE "workspaceId" = ${scope.workspaceId}::uuid
      AND "ownerAgentId" = ${scope.agentId}::uuid
      AND "key" = ${key}
    FOR UPDATE`;
  return rows[0];
}

async function lockOrCreateTrigger(
  tx: Prisma.TransactionClient,
  scope: TriggerScope,
  input: RecordReminderTriggerInput,
): Promise<LockedTrigger> {
  const existing = await lockTrigger(tx, scope, input.key);
  if (existing) return existing;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reminder_trigger_keys:${scope.agentId}`}, 0))`;
  const keys = await tx.reminderTrigger.count({
    where: { workspaceId: scope.workspaceId, ownerAgentId: scope.agentId },
  });
  if (keys >= REMINDER_TRIGGER_KEYS_PER_AGENT)
    throw new ReminderRefusal(
      "CONFLICT",
      `reminder trigger key limit (${REMINDER_TRIGGER_KEYS_PER_AGENT}) reached`,
    );
  await tx.reminderTrigger.createMany({
    data: {
      workspaceId: scope.workspaceId,
      ownerAgentId: scope.agentId,
      key: input.key,
      level: input.level,
      mergeWindowSeconds: input.mergeWindowSeconds,
    },
    skipDuplicates: true,
  });
  const created = await lockTrigger(tx, scope, input.key);
  if (!created) throw new Error("reminder trigger row missing after insert");
  return created;
}

export async function recordReminderTrigger(
  db: PrismaClient,
  scope: TriggerScope,
  input: RecordReminderTriggerInput,
): Promise<ReminderTriggerRecord> {
  return db.$transaction(
    async (tx) => {
      const trigger = await lockOrCreateTrigger(tx, scope, input);
      const replay = await tx.reminderTriggerEvent.findUnique({
        where: { triggerId_requestId: { triggerId: trigger.id, requestId: input.requestId } },
      });
      if (replay)
        return {
          outcome: replay.outcome as ReminderTriggerOutcome,
          receipt: {
            triggerCount: replay.triggerCount,
            firstTriggeredAt: replay.firstTriggeredAt,
            lastTriggeredAt: replay.lastTriggeredAt,
            ...(replay.nextWakeAllowedAt ? { nextWakeAllowedAt: replay.nextWakeAllowedAt } : {}),
          },
        };

      const callsInLastMinute = await tx.reminderTriggerEvent.count({
        where: {
          workspaceId: scope.workspaceId,
          ownerAgentId: scope.agentId,
          at: { gt: new Date(input.now.getTime() - MINUTE_MS), lte: input.now },
        },
      });
      if (callsInLastMinute >= REMINDER_TRIGGER_CALLS_PER_MINUTE)
        throw new ReminderRefusal("RATE_LIMITED", "too many reminder trigger calls; retry shortly");

      const mayWake = input.level === "wake" && input.deliverWake;
      if (mayWake)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reminder_trigger_wakes:${scope.agentId}`}, 0))`;
      const wakes = await tx.reminderTriggerEvent.findMany({
        where: {
          workspaceId: scope.workspaceId,
          ownerAgentId: scope.agentId,
          outcome: "woke",
          at: { gt: new Date(input.now.getTime() - HOUR_MS), lte: input.now },
        },
        select: { at: true },
      });
      const decision = decideReminderTrigger({
        level: input.deliverWake ? input.level : "log",
        mergeWindowSeconds: input.mergeWindowSeconds,
        now: input.now,
        state: trigger,
        wakesInLastHour: wakes.map((wake) => wake.at),
      });

      let reminderId: string | null | undefined;
      if (decision.outcome === "woke") {
        reminderId = Bun.randomUUIDv7();
        await tx.reminder.create({
          data: {
            id: reminderId,
            workspaceId: scope.workspaceId,
            ownerAgentId: scope.agentId,
            computerId: scope.computerId,
            title: input.title,
            target: `reminder:${reminderId}`,
            kind: "trigger",
            triggerKey: input.key,
            details: input.details ?? null,
            fireAt: input.now,
            status: "scheduled",
            events: {
              create: {
                workspace: { connect: { id: scope.workspaceId } },
                type: "created",
                title: input.title,
                scheduledFor: input.now,
              },
            },
          },
        });
      }
      if (mayWake)
        await tx.reminderTrigger.update({
          where: { id: trigger.id },
          data: {
            windowEndsAt: decision.nextState.windowEndsAt,
            pendingCount: decision.nextState.pendingCount,
            firstPendingAt: decision.nextState.firstPendingAt,
            lastPendingAt: decision.nextState.pendingCount > 0 ? input.now : null,
            ...(decision.outcome === "woke"
              ? {
                  level: input.level,
                  mergeWindowSeconds: input.mergeWindowSeconds,
                  lastWokeAt: input.now,
                  reminderId,
                }
              : {}),
          },
        });
      await tx.reminderTriggerEvent.create({
        data: {
          triggerId: trigger.id,
          workspaceId: scope.workspaceId,
          ownerAgentId: scope.agentId,
          at: input.now,
          level: input.level,
          outcome: decision.outcome,
          title: input.title,
          requestId: input.requestId,
          triggerCount: decision.receipt.triggerCount,
          firstTriggeredAt: decision.receipt.firstTriggeredAt,
          lastTriggeredAt: decision.receipt.lastTriggeredAt,
          nextWakeAllowedAt: decision.receipt.nextWakeAllowedAt ?? null,
        },
      });
      return { outcome: decision.outcome, receipt: decision.receipt };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}

export async function pruneReminderTriggerEvents(db: PrismaClient, now: Date): Promise<number> {
  const expired = await db.$executeRaw`
    DELETE FROM "reminder_trigger_events"
    WHERE "id" IN (
      SELECT "id" FROM "reminder_trigger_events"
      WHERE "at" < ${new Date(now.getTime() - EVENT_RETENTION_MS)}
      LIMIT ${PRUNE_BATCH}
      FOR UPDATE SKIP LOCKED)`;
  const trimmed = await db.$executeRaw`
    DELETE FROM "reminder_trigger_events" AS e
    USING (
      SELECT "id", row_number() OVER (PARTITION BY "triggerId" ORDER BY "at" DESC, "id" DESC) AS rank
      FROM "reminder_trigger_events"
      WHERE "triggerId" IN (
        SELECT "id" FROM "reminder_triggers"
        WHERE "updatedAt" > ${new Date(now.getTime() - 86_400_000)})) AS ranked
    WHERE e."id" = ranked."id"
      AND ranked.rank > ${EVENTS_PER_KEY}
      AND e."at" < ${new Date(now.getTime() - HOUR_MS)}`;
  return expired + trimmed;
}
