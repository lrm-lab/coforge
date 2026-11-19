import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { isValidTimeZone } from "#src/lib/dates";
import {
  DEFAULT_REMINDER_TIMEZONE,
  scheduledMessageId,
  type StoredReminder,
} from "#src/server/reminders/reminders.server";

type ReminderRow = Prisma.ReminderGetPayload<Record<string, never>>;

export const summary = (row: ReminderRow): StoredReminder => ({
  reminderId: row.id,
  ownerAgentId: row.ownerAgentId,
  computerId: row.computerId,
  version: row.version,
  title: row.title,
  target: row.target,
  messageId: scheduledMessageId(row),
  fireAt: row.fireAt.toISOString(),
  status: row.status as StoredReminder["status"],
  ...(row.repeat ? { repeat: row.repeat } : {}),
  ...(row.timezone ? { timezone: row.timezone } : {}),
  createdAt: row.createdAt.toISOString(),
  ...(row.firedAt ? { firedAt: row.firedAt.toISOString() } : {}),
});

export async function resolveOwnerDefaultTimezone(
  db: Pick<PrismaClient, "agent">,
  agentId: string,
): Promise<string> {
  return (await resolveOwnerTimeZone(db, agentId)) ?? DEFAULT_REMINDER_TIMEZONE;
}

export async function resolveOwnerTimeZone(
  db: Pick<PrismaClient, "agent">,
  agentId: string,
): Promise<string | undefined> {
  const agent = await db.agent.findUnique({
    where: { id: agentId },
    select: {
      owner: { select: { preferences: { select: { timeZone: true, observedTimeZone: true } } } },
    },
  });
  return [agent?.owner?.preferences?.timeZone, agent?.owner?.preferences?.observedTimeZone].find(
    (candidate): candidate is string => !!candidate && isValidTimeZone(candidate),
  );
}
