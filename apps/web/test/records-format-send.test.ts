import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { recordReportSend } from "#src/server/records/record-report-send.server";
import { recordDistribution } from "#src/server/records/record-distribution.server";

test("dismissWeeklyFormatSend stamps the current ISO week so a stale cycle cannot leak auto-send", async () => {
  const contentUpdates: Array<Record<string, unknown>> = [];
  let liveContent: Record<string, unknown> = {
    tabs: { Summary: { markdown: "outline" } },
  };
  const formatRow = {
    id: "format-1",
    authorId: "leader",
    kind: "template",
    settingsId: "settings-1",
    content: liveContent,
    cycle: { year: 2026, week: 38 },
    submissions: [] as Array<{ id: string }>,
  };
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
      findMany: async () => [],
    },
    weeklyReport: {
      findFirst: async (query: {
        where?: {
          id?: string;
          settingsId?: string;
          submissions?: { some?: unknown; none?: unknown };
          cycle?: { year?: number; week?: number };
        };
      }) => {
        if (query.where?.submissions?.some) return null;
        if (query.where?.submissions?.none) return { id: "format-1", content: liveContent };
        if (query.where?.id === "format-1" || query.where?.settingsId) return formatRow;
        return null;
      },
      update: async (query: { data: Record<string, unknown> }) => {
        contentUpdates.push(query.data);
        if (query.data.content && typeof query.data.content === "object") {
          liveContent = query.data.content as Record<string, unknown>;
          formatRow.content = liveContent;
        }
        return { id: "format-1" };
      },
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        sendWeekday: 4,
        sendTime: "15:00",
        scheduleEnabled: true,
        applied: true,
      }),
      findMany: async () => [
        {
          id: "settings-1",
          name: "算法汇报",
          workspaceId: "workspace-1",
          ownerId: "leader",
          sendTime: "15:00",
          sendWeekday: 4,
        },
      ],
    },
    recordComment: {
      create: async () => ({ id: "c1" }),
      findMany: async () => [],
    },
  } as unknown as PrismaClient;

  const now = new Date("2026-09-24T06:40:00.000Z");
  await recordReportSend(db).dismissWeeklyFormatSend({
    workspaceId: "workspace-1",
    userId: "leader",
    reportId: "format-1",
    now,
  });

  expect(contentUpdates[0]?.content).toMatchObject({
    schedule: {
      cancelledYear: 2026,
      cancelledWeek: 39,
      dismissSend: true,
    },
  });

  const tick = await recordDistribution(db).runDueScheduledWeeklyAssignments({
    now: new Date("2026-09-24T07:00:00.000Z"),
  });
  expect(tick.sent).toBe(0);
  expect(tick.results[0]).toMatchObject({
    status: "skipped",
    reason: "auto-send-cancelled",
  });
});
