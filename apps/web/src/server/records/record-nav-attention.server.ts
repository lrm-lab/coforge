import type { PrismaClient } from "#src/generated/prisma/client";
import {
  currentIsoWeek,
  isAutoSendCancelled,
  normalizeReportContent,
} from "#src/features/records/records-content";
import { isWeeklySendArmed } from "#src/features/records/weekly-send-window";
import { zonedCalendarDate } from "#src/features/records/weekly-report-schedule-due";
import { requireMembership } from "./record-catalog-access.server";

export function recordNavAttention(db: PrismaClient) {
  async function loadNavAttention(input: { workspaceId: string; userId: string; now?: Date }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const unreadAssignment = await db.weeklyReport.findFirst({
      where: {
        workspaceId: input.workspaceId,
        kind: "member",
        authorId: input.userId,
        sourceTemplateId: { not: null },
        hiddenFromAuthor: false,
        content: { path: ["assignment", "unread"], equals: true },
      },
      select: { id: true },
    });
    if (unreadAssignment) return { preview: true as const };

    const now = input.now ?? new Date();
    const currentWeek = currentIsoWeek(zonedCalendarDate(now));
    const settings = await db.weeklyReportTemplate.findMany({
      where: {
        workspaceId: input.workspaceId,
        ownerId: input.userId,
        applied: true,
        scheduleEnabled: true,
      },
      select: { id: true, sendWeekday: true, sendTime: true },
    });
    if (settings.length === 0) return { preview: false as const };
    const stream = {
      workspaceId: input.workspaceId,
      authorId: input.userId,
      kind: "template" as const,
      settingsId: { in: settings.map((row) => row.id) },
    };
    const [sent, live] = await Promise.all([
      db.weeklyReport.findMany({
        where: {
          ...stream,
          cycle: { year: currentWeek.year, week: currentWeek.week },
          submissions: { some: { kind: "member" } },
        },
        select: { settingsId: true },
      }),
      db.weeklyReport.findMany({
        where: { ...stream, submissions: { none: { kind: "member" } } },
        select: { settingsId: true, content: true },
      }),
    ]);
    const sentSettingsIds = new Set(sent.map((row) => row.settingsId));
    const liveContentBySettingsId = new Map<string | null, unknown>();
    for (const row of live) {
      if (!liveContentBySettingsId.has(row.settingsId))
        liveContentBySettingsId.set(row.settingsId, row.content);
    }
    for (const row of settings) {
      const armed = isWeeklySendArmed({
        applied: true,
        alreadySent: sentSettingsIds.has(row.id),
        sendWeekday: row.sendWeekday,
        sendTime: row.sendTime,
        scheduleEnabled: true,
        autoSendCancelled: isAutoSendCancelled(
          normalizeReportContent(liveContentBySettingsId.get(row.id)),
          currentWeek.year,
          currentWeek.week,
        ),
        now,
      });
      if (armed) return { preview: true as const };
    }
    return { preview: false as const };
  }

  return { loadNavAttention };
}
