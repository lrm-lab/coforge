import { expect, test } from "bun:test";
import { recordReportManagement } from "#src/server/records/record-report-management.server";

test("deleteMemberWeek cancels settings streams concurrently", async () => {
  const templates = Array.from({ length: 4 }, (_, index) => ({
    id: `template-${index}`,
    workspaceId: "ws-1",
    cycleId: "cycle-39",
    kind: "template",
    authorId: "user-1",
    settingsId: `settings-${index}`,
  }));
  const updatedSettings = new Set<string>();
  let activeReads = 0;
  let maxActiveReads = 0;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 2));
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "member" }) },
    weeklyReportCycle: {
      findFirst: async () => ({ id: "cycle-39", workspaceId: "ws-1", year: 2026, week: 39 }),
      delete: async () => ({ id: "cycle-39" }),
    },
    weeklyReport: {
      findMany: async ({ where }: { where: { kind?: string } }) =>
        where.kind === "template" ? templates : [],
      findFirst: async ({ where }: { where: { settingsId?: string } }) => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await pause();
        activeReads -= 1;
        return where.settingsId
          ? { id: `format-${where.settingsId}`, content: { tabs: { Summary: { markdown: "live" } } } }
          : null;
      },
      deleteMany: async () => ({ count: templates.length }),
      count: async () => 1,
      update: async ({ where }: { where: { id: string } }) => {
        await pause();
        updatedSettings.add(where.id.replace("format-", ""));
        return { id: where.id };
      },
    },
    $transaction: async (fn: (transaction: unknown) => Promise<unknown>) => fn(db),
  };

  const result = await recordReportManagement(db as never).deleteMemberWeek({
    workspaceId: "ws-1",
    userId: "user-1",
    cycleId: "cycle-39",
  });

  expect(result).toEqual({ ok: true });
  expect(updatedSettings).toEqual(new Set(templates.map((template) => template.settingsId)));
  expect(maxActiveReads).toBeGreaterThan(1);
});
