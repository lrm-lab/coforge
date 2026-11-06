import { expect, test } from "bun:test";

test("failRunningCollectSlotsForAgent accepts multiple slots concurrently", async () => {
  const { failRunningCollectSlotsForAgent, COLLECT_RUN_STATUS, COLLECT_SLOT_STATUS } =
    await import("#src/server/records/weekly-report-collect-run.server");

  const slots = Array.from({ length: 4 }, (_, index) => ({
    id: `slot-${index}`,
    computerId: `computer-${index}`,
    collectorAgentId: "agent-1",
    scanPaths: [],
    status: COLLECT_SLOT_STATUS.running,
    retryCount: 0,
    failureReason: null as string | null,
    packMarkdown: null as string | null,
    requestId: null as string | null,
  }));
  let activeReads = 0;
  let maxActiveReads = 0;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 2));
  const run = () => ({
    id: "run-1",
    reportId: "report-1",
    workspaceId: "ws-1",
    userId: "user-1",
    status: COLLECT_RUN_STATUS.collecting,
    windowKind: "week",
    windowStart: new Date("2026-08-31T00:00:00.000Z"),
    windowEnd: new Date("2026-09-07T00:00:00.000Z"),
    startedAt: new Date("2026-09-17T00:00:00.000Z"),
    completedAt: null,
    createdAt: new Date("2026-09-17T00:00:00.000Z"),
    slots: slots.map((slot) => ({ ...slot })),
  });
  const db = {
    weeklyReportCollectSlot: {
      findMany: async () => slots.map(({ id }) => ({ id, runId: "run-1" })),
      findFirst: async () => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await pause();
        activeReads -= 1;
        return null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const slot = slots.find((slot) => slot.id === where.id);
        if (!slot) throw new Error(`unknown slot ${where.id}`);
        Object.assign(slot, data);
        return slot;
      },
    },
    weeklyReportCollectRun: {
      findFirst: async () => run(),
      findFirstOrThrow: async () => run(),
      updateMany: async () => ({ count: 1 }),
    },
  };

  const result = await failRunningCollectSlotsForAgent(db as never, {
    workspaceId: "ws-1",
    agentId: "agent-1",
    computerId: "computer-1",
    requestId: "turn-1",
    failureReason: "collector failed",
  });

  expect(result.slotCount).toBe(4);
  expect(result.accepted).toHaveLength(4);
  expect(maxActiveReads).toBeGreaterThan(1);
});
