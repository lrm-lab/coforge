import { expect, test } from "bun:test";

test("startCollectRun refuses a collector Agent whose wake DM cannot be delivered", async () => {
  const { startCollectRun } = await import("#src/server/records/weekly-report-collect-run.server");

  const agentRow = (patch: Record<string, unknown>) => ({
    id: "agent-1",
    computerId: "computer-1",
    runtimeConfig: { runtime: "pi", provider: { kind: "default" } },
    stoppedAt: null,
    deletedAt: null,
    ...patch,
  });
  const dbFor = (agent: Record<string, unknown>) => ({
    weeklyReport: {
      findFirst: async () => ({
        id: "report-1",
        workspaceId: "ws-1",
        authorId: "user-1",
        kind: "member",
      }),
    },
    workspaceComputer: {
      findMany: async () => [
        { computerId: "computer-1", computer: { id: "computer-1", ownerId: "user-1" } },
      ],
    },
    weeklyReportCollectorBinding: {
      findMany: async () => [
        {
          id: "b1",
          workspaceId: "ws-1",
          userId: "user-1",
          computerId: "computer-1",
          collectorAgentId: "agent-1",
        },
      ],
    },
    agent: { findMany: async () => [agent] },
    weeklyReportCollectRun: {
      create: async () => {
        throw new Error("must not create a run for an undeliverable wake");
      },
    },
  });
  const input = {
    workspaceId: "ws-1",
    userId: "user-1",
    reportId: "report-1",
    windowKind: "week" as const,
    windowStart: new Date("2026-08-31T00:00:00.000Z"),
    windowEnd: new Date("2026-09-07T00:00:00.000Z"),
    computers: [{ computerId: "computer-1", scanPaths: [] }],
  };

  await expect(
    startCollectRun(dbFor(agentRow({ stoppedAt: new Date() })) as never, input),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "collector_agent_stopped" },
  });
  await expect(
    startCollectRun(dbFor(agentRow({ deletedAt: new Date() })) as never, input),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "collector_agent_deleted" },
  });
  await expect(
    startCollectRun(dbFor(agentRow({ computerId: null })) as never, input),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

test("listOwnedComputerSlots reports a stopped collector Agent as not ready", async () => {
  const { listOwnedComputerSlots } =
    await import("#src/server/records/weekly-report-collector.server");

  const db = {
    workspaceComputer: {
      findMany: async () => [
        {
          computerId: "computer-1",
          computer: {
            id: "computer-1",
            ownerId: "user-1",
            displayName: "ubuntu",
            name: "ubuntu",
            platform: "linux",
          },
        },
        {
          computerId: "computer-2",
          computer: {
            id: "computer-2",
            ownerId: "user-1",
            displayName: "mac",
            name: "mac",
            platform: "darwin",
          },
        },
      ],
    },
    weeklyReportCollectorBinding: {
      findMany: async () => [
        {
          id: "b1",
          computerId: "computer-1",
          collectorAgentId: "agent-stopped",
        },
        { id: "b2", computerId: "computer-2", collectorAgentId: "agent-live" },
      ],
    },
    agent: {
      findMany: async () => [
        {
          id: "agent-stopped",
          computerId: "computer-1",
          runtimeConfig: { runtime: "pi", provider: { kind: "default" } },
          stoppedAt: new Date("2026-11-06T08:58:43.000Z"),
          deletedAt: null,
        },
        {
          id: "agent-live",
          computerId: "computer-2",
          runtimeConfig: { runtime: "pi", provider: { kind: "default" } },
          stoppedAt: null,
          deletedAt: null,
        },
      ],
    },
  };

  const slots = await listOwnedComputerSlots(db as never, {
    workspaceId: "ws-1",
    userId: "user-1",
  });

  const stopped = slots.find((slot) => slot.computerId === "computer-1");
  const live = slots.find((slot) => slot.computerId === "computer-2");
  expect(stopped).toMatchObject({ ready: false, agentIssue: "stopped" });
  expect(live).toMatchObject({ ready: true, agentIssue: null });
});
