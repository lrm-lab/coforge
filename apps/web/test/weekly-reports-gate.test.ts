import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import {
  isWeeklyReportAgentBlocked,
  isWeeklyReportsEnabled,
  isWeeklyReportsEnabledInValue,
  requireWeeklyReports,
  weeklyReportsAgentFilter,
  weeklyReportsDisabledResponse,
} from "#src/server/records/weekly-reports-gate.server";
import { recordDistribution } from "#src/server/records/record-distribution.server";

function workspaceDb(experiments: unknown): PrismaClient {
  return {
    workspace: {
      findUnique: async () => ({ experiments }),
    },
  } as unknown as PrismaClient;
}

test("isWeeklyReportsEnabledInValue defaults to false and only accepts boolean true", () => {
  expect(isWeeklyReportsEnabledInValue(null)).toBe(false);
  expect(isWeeklyReportsEnabledInValue(undefined)).toBe(false);
  expect(isWeeklyReportsEnabledInValue({})).toBe(false);
  expect(isWeeklyReportsEnabledInValue({ weeklyReports: false })).toBe(false);
  expect(isWeeklyReportsEnabledInValue({ weeklyReports: "true" })).toBe(false);
  expect(isWeeklyReportsEnabledInValue([])).toBe(false);
  expect(isWeeklyReportsEnabledInValue({ weeklyReports: true })).toBe(true);
});

test("isWeeklyReportsEnabled and requireWeeklyReports enforce the workspace experiment", async () => {
  const offDb = workspaceDb(null);
  expect(await isWeeklyReportsEnabled(offDb, "w1")).toBe(false);
  await expect(requireWeeklyReports(offDb, "w1")).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });

  const explicitOffDb = workspaceDb({ weeklyReports: false });
  expect(await isWeeklyReportsEnabled(explicitOffDb, "w1")).toBe(false);
  await expect(requireWeeklyReports(explicitOffDb, "w1")).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });

  const onDb = workspaceDb({ weeklyReports: true });
  expect(await isWeeklyReportsEnabled(onDb, "w1")).toBe(true);
  await expect(requireWeeklyReports(onDb, "w1")).resolves.toBeUndefined();
  expect(await weeklyReportsDisabledResponse(onDb, "w1")).toBeUndefined();

  const disabledResponse = await weeklyReportsDisabledResponse(offDb, "w1");
  expect(disabledResponse?.status).toBe(403);
  expect(await disabledResponse?.json()).toEqual({ error: "weekly reports disabled" });
});

test("weeklyReportsAgentFilter and isWeeklyReportAgentBlocked gate weekly report agents", () => {
  expect(weeklyReportsAgentFilter(null)).toEqual({
    weeklyReportAssistant: null,
    weeklyReportCollectorBinding: null,
  });
  expect(weeklyReportsAgentFilter({ weeklyReports: false })).toEqual({
    weeklyReportAssistant: null,
    weeklyReportCollectorBinding: null,
  });
  expect(weeklyReportsAgentFilter({ weeklyReports: true })).toEqual({});

  expect(isWeeklyReportAgentBlocked({ weeklyReportAssistant: { id: "a" } }, null)).toBe(true);
  expect(isWeeklyReportAgentBlocked({ weeklyReportCollectorBinding: { id: "c" } }, null)).toBe(
    true,
  );
  expect(
    isWeeklyReportAgentBlocked({ weeklyReportAssistant: { id: "a" } }, { weeklyReports: true }),
  ).toBe(false);
  expect(isWeeklyReportAgentBlocked({}, null)).toBe(false);
});

test("runDueScheduledWeeklyAssignments skips workspaces where weekly reports are disabled", async () => {
  const db = {
    weeklyReportTemplate: {
      findMany: async () => [
        {
          id: "settings-off-default",
          name: "Default Off",
          workspaceId: "w-default-off",
          ownerId: "leader",
          sendTime: "15:00",
          sendWeekday: 5,
          workspace: { experiments: null },
        },
        {
          id: "settings-off-explicit",
          name: "Explicit Off",
          workspaceId: "w-explicit-off",
          ownerId: "leader",
          sendTime: "15:00",
          sendWeekday: 5,
          workspace: { experiments: { weeklyReports: false } },
        },
      ],
    },
  } as unknown as PrismaClient;

  const result = await recordDistribution(db).runDueScheduledWeeklyAssignments({
    now: new Date("2026-09-18T07:30:00.000Z"),
  });

  expect(result.sent).toBe(0);
  expect(result.results).toEqual([
    {
      workspaceId: "w-default-off",
      templateId: "settings-off-default",
      status: "skipped",
      reason: "disabled",
    },
    {
      workspaceId: "w-explicit-off",
      templateId: "settings-off-explicit",
      status: "skipped",
      reason: "disabled",
    },
  ]);
});

test("DirectConversations hides a weekly-report assistant DM while weeklyReports is off", async () => {
  const dmDb = (experiments: unknown) =>
    ({
      conversation: {
        findFirst: async () => ({
          directKey: agentDirectKey("user-1", "agent-1"),
          workspace: { experiments },
          members: [
            { id: "cm-user", userId: "user-1", agent: null },
            {
              id: "cm-agent",
              userId: null,
              agent: {
                id: "agent-1",
                ownerId: "user-1",
                visibility: "private",
                deletedAt: null,
                weeklyReportAssistant: { id: "wra-1" },
              },
            },
          ],
        }),
      },
    }) as unknown as PrismaClient;

  await expect(
    new DirectConversations(dmDb(null)).authorize("w1", "user-1", "conv-1"),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    new DirectConversations(dmDb({ weeklyReports: false })).authorize("w1", "user-1", "conv-1"),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    new DirectConversations(dmDb({ weeklyReports: true })).authorize("w1", "user-1", "conv-1"),
  ).resolves.toEqual({ kind: "agent", agentId: "agent-1" });
});
