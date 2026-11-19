import type { AgentInboxReadItem, AgentInboxReadResponse } from "@lrm/coforge-sdk/agent";
import {
  REMINDER_PROTOCOL_MAJOR,
  REMINDER_SYNC_MESSAGE_TYPE,
  type ReminderSync,
} from "@lrm/coforge-sdk/internal";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  DEFAULT_REMINDER_TIMEZONE,
  nextOccurrence,
  scheduledMessageId,
  type ReminderPublisher,
} from "./reminders.server";

export const REMINDER_TARGET_PREFIX = "reminder:";
const REMINDER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REMINDER_CURSOR = /^(\d+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

type Principal = {
  workspaceId: string;
  agentId: string;
  computerId?: string;
  userId?: string;
};

type SettledEventRef = { scheduledFor: Date };

type ReadableReminderRow = {
  id: string;
  title: string;
  target: string;
  messageId: string | null;
  fireAt: Date;
  status: string;
  version: number;
  repeat: string | null;
  timezone: string | null;
  events?: readonly SettledEventRef[];
};

function parseReminderCursor(cursor: string): { fireAt: Date; id: string } {
  const match = REMINDER_CURSOR.exec(cursor.trim());
  if (!match) {
    throw new AppError("INVALID_INPUT", {
      hint: "reminder cursor must be formatted as <epochMs>:<uuid>",
    });
  }
  const ms = Number(match[1]);
  const fireAt = new Date(ms);
  if (!Number.isFinite(ms) || Number.isNaN(fireAt.getTime())) {
    throw new AppError("INVALID_INPUT", { hint: "reminder cursor timestamp is invalid" });
  }
  return { fireAt, id: match[2]!.toLowerCase() };
}

function encodeReminderCursor(row: { fireAt: Date; id: string }): string {
  return `${row.fireAt.getTime()}:${row.id}`;
}

function isAlreadySettledFired(row: {
  status: string;
  fireAt: Date;
  events?: readonly SettledEventRef[];
}): boolean {
  if (row.status !== "fired") return false;
  const latest = row.events?.[0];
  return latest !== undefined && latest.scheduledFor.getTime() >= row.fireAt.getTime();
}

export async function readAgentInboxReminders(
  db: PrismaClient,
  principal: Principal,
  input: { target: string; limit: number; cursor?: string },
): Promise<AgentInboxReadResponse> {
  const specificId = input.target.startsWith(REMINDER_TARGET_PREFIX)
    ? input.target.slice(REMINDER_TARGET_PREFIX.length).trim()
    : undefined;
  if (specificId !== undefined && !REMINDER_UUID.test(specificId)) {
    throw new AppError("INVALID_INPUT", { hint: "reminder target must be a valid UUID" });
  }
  let scanCursor = input.cursor !== undefined ? parseReminderCursor(input.cursor) : undefined;

  if (specificId) {
    const row = await db.reminder.findFirst({
      where: {
        id: specificId,
        workspaceId: principal.workspaceId,
        ownerAgentId: principal.agentId,
        kind: "scheduled",
      },
      select: {
        id: true,
        title: true,
        target: true,
        messageId: true,
        fireAt: true,
        status: true,
        version: true,
        repeat: true,
        timezone: true,
        events: {
          where: { type: { in: ["acknowledged", "dismissed"] } },
          orderBy: { scheduledFor: "desc" },
          take: 1,
          select: { scheduledFor: true },
        },
      },
    });
    if (!row) throw new AppError("NOT_FOUND");
    const items: AgentInboxReadItem[] =
      row.status === "canceled" || isAlreadySettledFired(row)
        ? []
        : [
            {
              kind: "reminder",
              id: row.id,
              title: row.title,
              target: row.target,
              messageId: scheduledMessageId(row),
              fireAt: row.fireAt.toISOString(),
              status: row.status,
              version: row.version,
              repeat: row.repeat,
              timezone: row.timezone,
            },
          ];
    return {
      ok: true,
      kind: "reminders",
      target: input.target,
      items,
      hasMore: false,
      nextCursor: null,
    };
  }

  const batchTake = input.limit + 1;
  const collected: ReadableReminderRow[] = [];
  for (let guard = 0; guard < 16 && collected.length < batchTake; guard += 1) {
    const rows = await db.reminder.findMany({
      where: {
        workspaceId: principal.workspaceId,
        ownerAgentId: principal.agentId,
        kind: "scheduled",
        status: { in: ["scheduled", "fired"] },
        NOT: {
          status: "fired",
          repeat: null,
          events: { some: { type: { in: ["acknowledged", "dismissed"] } } },
        },
        ...(scanCursor
          ? {
              OR: [
                { fireAt: { gt: scanCursor.fireAt } },
                { fireAt: scanCursor.fireAt, id: { gt: scanCursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ fireAt: "asc" }, { id: "asc" }],
      take: batchTake,
      select: {
        id: true,
        title: true,
        target: true,
        messageId: true,
        fireAt: true,
        status: true,
        version: true,
        repeat: true,
        timezone: true,
        events: {
          where: { type: { in: ["acknowledged", "dismissed"] } },
          orderBy: { scheduledFor: "desc" },
          take: 1,
          select: { scheduledFor: true },
        },
      },
    });
    for (const row of rows) {
      if (!isAlreadySettledFired(row)) {
        collected.push(row);
        if (collected.length >= batchTake) break;
      }
    }
    if (rows.length < batchTake || collected.length >= batchTake) break;
    const lastFetched = rows[rows.length - 1]!;
    if (
      scanCursor &&
      scanCursor.fireAt.getTime() === lastFetched.fireAt.getTime() &&
      scanCursor.id === lastFetched.id
    ) {
      break;
    }
    scanCursor = { fireAt: lastFetched.fireAt, id: lastFetched.id };
  }

  const hasMore = collected.length > input.limit;
  const page = hasMore ? collected.slice(0, input.limit) : collected;
  const items: AgentInboxReadItem[] = page.map((row) => ({
    kind: "reminder",
    id: row.id,
    title: row.title,
    target: row.target,
    messageId: scheduledMessageId(row),
    fireAt: row.fireAt.toISOString(),
    status: row.status,
    version: row.version,
    repeat: row.repeat,
    timezone: row.timezone,
  }));
  return {
    ok: true,
    kind: "reminders",
    target: input.target,
    items,
    hasMore,
    nextCursor: hasMore ? encodeReminderCursor(page[page.length - 1]!) : null,
  };
}

function buildUpsertSync(
  principal: Principal,
  row: {
    id: string;
    computerId: string;
    title: string;
    target: string;
    messageId: string | null;
  },
  newVersion: number,
  nextFireAt: Date,
): ReminderSync {
  return {
    protocolMajor: REMINDER_PROTOCOL_MAJOR,
    requestId: crypto.randomUUID(),
    workspaceId: principal.workspaceId,
    computerId: principal.computerId ?? row.computerId,
    agentId: principal.agentId,
    operation: "upsert",
    jobs: [
      {
        reminderId: row.id,
        ownerAgentId: principal.agentId,
        version: newVersion,
        title: row.title,
        target: row.target,
        messageId: scheduledMessageId(row),
        fireAt: nextFireAt.toISOString(),
      },
    ],
    messageType: REMINDER_SYNC_MESSAGE_TYPE,
  };
}

function buildCancelSync(
  principal: Principal,
  row: { id: string; computerId: string },
  newVersion: number,
): ReminderSync {
  return {
    protocolMajor: REMINDER_PROTOCOL_MAJOR,
    requestId: crypto.randomUUID(),
    workspaceId: principal.workspaceId,
    computerId: principal.computerId ?? row.computerId,
    agentId: principal.agentId,
    operation: "cancel",
    jobs: [],
    reminderId: row.id,
    version: newVersion,
    messageType: REMINDER_SYNC_MESSAGE_TYPE,
  };
}

export async function dismissDueAgentReminders(
  db: PrismaClient,
  principal: Principal,
  options: {
    specificId?: string;
    dueBefore: Date;
    beforeExclusive?: boolean;
    customDismiss?: (reminderId: string, computerId: string, version: number) => Promise<void>;
    publishReminderSync?: ReminderPublisher;
  },
): Promise<string[]> {
  if (options.specificId !== undefined && !REMINDER_UUID.test(options.specificId)) {
    throw new AppError("INVALID_INPUT", { hint: "reminder target must be a valid UUID" });
  }
  const boundMs = options.dueBefore.getTime();
  const isScheduledDue = (fireAt: Date) =>
    options.beforeExclusive ? fireAt.getTime() < boundMs : fireAt.getTime() <= boundMs;
  const fireAtBound = options.beforeExclusive
    ? { lt: options.dueBefore }
    : { lte: options.dueBefore };
  const bulkStatusWhere: Prisma.ReminderWhereInput = options.beforeExclusive
    ? { status: { in: ["scheduled", "fired"] }, fireAt: fireAtBound }
    : { OR: [{ status: "fired" }, { status: "scheduled", fireAt: fireAtBound }] };

  if (options.customDismiss) {
    const rows = options.specificId
      ? await (async () => {
          const one = await db.reminder.findFirst({
            where: {
              id: options.specificId,
              workspaceId: principal.workspaceId,
              ownerAgentId: principal.agentId,
              kind: "scheduled",
            },
            select: {
              id: true,
              computerId: true,
              version: true,
              status: true,
              fireAt: true,
              events: {
                where: { type: { in: ["acknowledged", "dismissed"] } },
                orderBy: { scheduledFor: "desc" },
                take: 1,
                select: { scheduledFor: true },
              },
            },
          });
          if (!one) throw new AppError("NOT_FOUND");
          if (
            one.status === "canceled" ||
            isAlreadySettledFired(one) ||
            (one.status === "scheduled" && !isScheduledDue(one.fireAt))
          ) {
            return [];
          }
          return [one];
        })()
      : await db.reminder.findMany({
          where: {
            workspaceId: principal.workspaceId,
            ownerAgentId: principal.agentId,
            kind: "scheduled",
            ...bulkStatusWhere,
            NOT: {
              status: "fired",
              repeat: null,
              events: { some: { type: { in: ["acknowledged", "dismissed"] } } },
            },
          },
          select: {
            id: true,
            computerId: true,
            version: true,
            status: true,
            fireAt: true,
            events: {
              where: { type: { in: ["acknowledged", "dismissed"] } },
              orderBy: { scheduledFor: "desc" },
              take: 1,
              select: { scheduledFor: true },
            },
          },
        });
    const dismissed: string[] = [];
    for (const row of rows) {
      if (isAlreadySettledFired(row)) continue;
      if ((row.status === "scheduled" || options.beforeExclusive) && !isScheduledDue(row.fireAt))
        continue;
      await options.customDismiss(row.id, row.computerId, row.version);
      dismissed.push(`reminder:${row.id}`);
    }
    return dismissed;
  }

  const now = new Date();
  const syncsToPublish: ReminderSync[] = [];
  const dismissedTargets = await db.$transaction(async (tx) => {
    const selectFields = {
      id: true,
      computerId: true,
      title: true,
      target: true,
      messageId: true,
      fireAt: true,
      status: true,
      version: true,
      repeat: true,
      timezone: true,
      events: {
        where: { type: { in: ["acknowledged", "dismissed"] } },
        orderBy: { scheduledFor: "desc" },
        take: 1,
        select: { scheduledFor: true },
      },
    } satisfies Prisma.ReminderSelect;

    const candidates = options.specificId
      ? await (async () => {
          const one = await tx.reminder.findFirst({
            where: {
              id: options.specificId,
              workspaceId: principal.workspaceId,
              ownerAgentId: principal.agentId,
              kind: "scheduled",
            },
            select: selectFields,
          });
          if (!one) throw new AppError("NOT_FOUND");
          if (one.status === "canceled") return [];
          return [one];
        })()
      : await tx.reminder.findMany({
          where: {
            workspaceId: principal.workspaceId,
            ownerAgentId: principal.agentId,
            kind: "scheduled",
            ...bulkStatusWhere,
            NOT: {
              status: "fired",
              repeat: null,
              events: { some: { type: { in: ["acknowledged", "dismissed"] } } },
            },
          },
          select: selectFields,
        });

    const dueRows = candidates.filter((row) => {
      if (isAlreadySettledFired(row)) return false;
      if (row.status === "scheduled" || options.beforeExclusive) return isScheduledDue(row.fireAt);
      return true;
    });
    if (dueRows.length === 0) return [];

    const eventsToCreate: Array<{
      reminderId: string;
      workspaceId: string;
      type: string;
      title: string;
      time: Date;
      scheduledFor: Date;
      nextFireAt?: Date;
    }> = [];
    const scheduledIds: string[] = [];

    for (const row of dueRows) {
      if (row.status === "scheduled") {
        scheduledIds.push(row.id);
        const newVersion = row.version + 1;
        if (row.repeat) {
          const next = nextOccurrence(
            row.repeat,
            row.timezone ?? DEFAULT_REMINDER_TIMEZONE,
            row.fireAt,
            options.dueBefore,
          );
          await tx.reminder.update({
            where: { id: row.id },
            data: { fireAt: next, version: { increment: 1 } },
          });
          eventsToCreate.push({
            reminderId: row.id,
            workspaceId: principal.workspaceId,
            type: "dismissed",
            title: row.title,
            time: now,
            scheduledFor: row.fireAt,
            nextFireAt: next,
          });
          syncsToPublish.push(buildUpsertSync(principal, row, newVersion, next));
        } else {
          await tx.reminder.update({
            where: { id: row.id },
            data: { status: "fired", firedAt: now, version: { increment: 1 } },
          });
          eventsToCreate.push({
            reminderId: row.id,
            workspaceId: principal.workspaceId,
            type: "dismissed",
            title: row.title,
            time: now,
            scheduledFor: row.fireAt,
          });
          syncsToPublish.push(buildCancelSync(principal, row, newVersion));
        }
      } else {
        eventsToCreate.push({
          reminderId: row.id,
          workspaceId: principal.workspaceId,
          type: "dismissed",
          title: row.title,
          time: now,
          scheduledFor: row.fireAt,
        });
      }
    }

    if (scheduledIds.length > 0) {
      await tx.reminderOccurrence?.updateMany({
        where: {
          reminderId: { in: scheduledIds },
          status: "pending",
          scheduledFor: fireAtBound,
        },
        data: { status: "expired" },
      });
    }
    await tx.reminderEvent.createMany({ data: eventsToCreate });
    return dueRows.map((row) => `reminder:${row.id}`);
  });

  if (options.publishReminderSync && syncsToPublish.length > 0) {
    await Promise.all(
      syncsToPublish.map((sync) => options.publishReminderSync!(sync).catch(() => undefined)),
    );
  }

  return dismissedTargets;
}
