import { expect, test } from "bun:test";

test("settleStaleCollectRun marks overdue running slots stalled and closes an empty wave", async () => {
  const { settleStaleCollectRun, COLLECT_RUN_STATUS, COLLECT_SLOT_STATUS, COLLECT_SLOT_STALL_MS } =
    await import("#src/server/records/weekly-report-collect-run.server");

  let slotStatus: string = COLLECT_SLOT_STATUS.running;
  let slotFailure: string | null = null;
  let runStatus: string = COLLECT_RUN_STATUS.collecting;
  let runCompletedAt: Date | null = null;
  const startedAt = new Date("2026-09-17T00:00:00.000Z");

  const slotRow = () => ({
    id: "slot-1",
    computerId: "computer-1",
    collectorAgentId: "agent-1",
    scanPaths: ["/work"],
    status: slotStatus,
    retryCount: 0,
    failureReason: slotFailure,
    packMarkdown: null,
    requestId: null,
  });

  const runRow = () => ({
    id: "run-1",
    reportId: "report-1",
    workspaceId: "ws-1",
    userId: "user-1",
    status: runStatus,
    windowKind: "week",
    windowStart: new Date("2026-08-31T00:00:00.000Z"),
    windowEnd: new Date("2026-09-07T00:00:00.000Z"),
    startedAt,
    completedAt: runCompletedAt,
    createdAt: startedAt,
    slots: [slotRow()],
  });

  const db = {
    weeklyReportCollectRun: {
      findFirst: async () => runRow(),
      findFirstOrThrow: async () => runRow(),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        if (where.status !== undefined && where.status !== runStatus) return { count: 0 };
        runStatus = String(data.status);
        runCompletedAt = (data.completedAt as Date | null | undefined) ?? runCompletedAt;
        return { count: 1 };
      },
    },
    weeklyReportCollectSlot: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { runId: string; status: string };
        data: Record<string, unknown>;
      }) => {
        expect(where.status).toBe(COLLECT_SLOT_STATUS.running);
        slotStatus = String(data.status);
        slotFailure = (data.failureReason as string | null) ?? null;
        return { count: 1 };
      },
    },
  };

  const now = startedAt.getTime() + COLLECT_SLOT_STALL_MS + 1;
  const view = await settleStaleCollectRun(
    db as never,
    { workspaceId: "ws-1", userId: "user-1", runId: "run-1" },
    now,
  );

  expect(slotStatus).toBe(COLLECT_SLOT_STATUS.stalled);
  expect(slotFailure).toMatch(/超时|模型|接口|上报/);
  expect(view.status).toBe(COLLECT_RUN_STATUS.cancelled);
  expect(view.allTerminal).toBe(true);
  expect(runCompletedAt).toBeInstanceOf(Date);
});

test("settleStaleCollectRun ends a collecting wave immediately when the computer runtime is offline", async () => {
  const { settleStaleCollectRun, COLLECT_RUN_STATUS, COLLECT_SLOT_STATUS } =
    await import("#src/server/records/weekly-report-collect-run.server");

  let slotStatus: string = COLLECT_SLOT_STATUS.running;
  let slotFailure: string | null = null;
  let runStatus: string = COLLECT_RUN_STATUS.collecting;
  let runCompletedAt: Date | null = null;
  const startedAt = new Date("2026-10-08T07:14:12.680Z");

  const slotRow = () => ({
    id: "slot-1",
    computerId: "computer-1",
    collectorAgentId: "agent-1",
    scanPaths: ["/work"],
    status: slotStatus,
    retryCount: 0,
    failureReason: slotFailure,
    packMarkdown: null,
    requestId: null,
  });

  const runRow = () => ({
    id: "run-1",
    reportId: "report-1",
    workspaceId: "ws-1",
    userId: "user-1",
    status: runStatus,
    windowKind: "week",
    windowStart: new Date("2026-10-05T00:00:00.000Z"),
    windowEnd: new Date("2026-10-12T00:00:00.000Z"),
    startedAt,
    completedAt: runCompletedAt,
    createdAt: startedAt,
    slots: [slotRow()],
  });

  const db = {
    weeklyReportCollectRun: {
      findFirst: async () => runRow(),
      findFirstOrThrow: async () => runRow(),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        if (where.status !== undefined && where.status !== runStatus) return { count: 0 };
        runStatus = String(data.status);
        runCompletedAt = (data.completedAt as Date | null | undefined) ?? runCompletedAt;
        return { count: 1 };
      },
    },
    weeklyReportCollectSlot: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { runId: string; status: string; computerId?: string | { in: string[] } };
        data: Record<string, unknown>;
      }) => {
        expect(where.status).toBe(COLLECT_SLOT_STATUS.running);
        const computerIds =
          typeof where.computerId === "string" ? [where.computerId] : where.computerId?.in;
        if (computerIds && !computerIds.includes("computer-1")) return { count: 0 };
        slotStatus = String(data.status);
        slotFailure = (data.failureReason as string | null) ?? null;
        return { count: 1 };
      },
    },
  };

  const view = await settleStaleCollectRun(
    db as never,
    { workspaceId: "ws-1", userId: "user-1", runId: "run-1" },
    startedAt.getTime() + 1_000,
    async () => false,
  );

  expect(slotStatus).toBe(COLLECT_SLOT_STATUS.failed);
  expect(slotFailure ?? "").toMatch(/离线|运行时/);
  expect(view.status).toBe(COLLECT_RUN_STATUS.cancelled);
  expect(view.slots[0]?.status).toBe(COLLECT_SLOT_STATUS.failed);
  expect(runCompletedAt).toBeInstanceOf(Date);
});

test("settleStaleCollectRun keeps collecting while the computer runtime is online", async () => {
  const { settleStaleCollectRun, COLLECT_RUN_STATUS, COLLECT_SLOT_STATUS } =
    await import("#src/server/records/weekly-report-collect-run.server");

  const startedAt = new Date("2026-10-08T07:14:12.680Z");
  const db = {
    weeklyReportCollectRun: {
      findFirst: async () => ({
        id: "run-1",
        reportId: "report-1",
        status: COLLECT_RUN_STATUS.collecting,
        windowKind: "week",
        windowStart: new Date("2026-10-05T00:00:00.000Z"),
        windowEnd: new Date("2026-10-12T00:00:00.000Z"),
        startedAt,
        completedAt: null,
        createdAt: startedAt,
        slots: [
          {
            id: "slot-1",
            computerId: "computer-1",
            collectorAgentId: "agent-1",
            scanPaths: ["/work"],
            status: COLLECT_SLOT_STATUS.running,
            retryCount: 0,
            failureReason: null,
            packMarkdown: null,
          },
        ],
      }),
      updateMany: async () => {
        throw new Error("an online computer must not settle the wave early");
      },
    },
    weeklyReportCollectSlot: {
      updateMany: async () => {
        throw new Error("an online computer must not fail its slot");
      },
    },
  };

  const view = await settleStaleCollectRun(
    db as never,
    { workspaceId: "ws-1", userId: "user-1", runId: "run-1" },
    startedAt.getTime() + 1_000,
    async () => true,
  );

  expect(view.status).toBe(COLLECT_RUN_STATUS.collecting);
  expect(view.slots[0]?.status).toBe(COLLECT_SLOT_STATUS.running);
});

test("settleStaleCollectRun checks and marks offline computers in parallel", async () => {
  const { settleStaleCollectRun, COLLECT_RUN_STATUS, COLLECT_SLOT_STATUS } =
    await import("#src/server/records/weekly-report-collect-run.server");

  const startedAt = new Date("2026-10-08T07:14:12.680Z");
  const slotStatuses = new Map([
    ["computer-1", COLLECT_SLOT_STATUS.running],
    ["computer-2", COLLECT_SLOT_STATUS.running],
  ]);
  let runStatus = COLLECT_RUN_STATUS.collecting;
  let activePresenceChecks = 0;
  let maxPresenceChecks = 0;
  let activeSlotUpdates = 0;
  let maxSlotUpdates = 0;
  const runRow = () => ({
    id: "run-1",
    reportId: "report-1",
    workspaceId: "ws-1",
    userId: "user-1",
    status: runStatus,
    windowKind: "week",
    windowStart: new Date("2026-10-05T00:00:00.000Z"),
    windowEnd: new Date("2026-10-12T00:00:00.000Z"),
    startedAt,
    completedAt: null,
    createdAt: startedAt,
    slots: [...slotStatuses].map(([computerId, status]) => ({
      id: `slot-${computerId}`,
      computerId,
      collectorAgentId: `agent-${computerId}`,
      scanPaths: ["/work"],
      status,
      retryCount: 0,
      failureReason: status === COLLECT_SLOT_STATUS.failed ? "offline" : null,
      packMarkdown: null,
      requestId: null,
    })),
  });
  const db = {
    weeklyReportCollectRun: {
      findFirst: async () => runRow(),
      findFirstOrThrow: async () => runRow(),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        runStatus = String(data.status);
        return { count: 1 };
      },
    },
    weeklyReportCollectSlot: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { computerId?: string };
        data: Record<string, unknown>;
      }) => {
        activeSlotUpdates += 1;
        maxSlotUpdates = Math.max(maxSlotUpdates, activeSlotUpdates);
        await Promise.resolve();
        activeSlotUpdates -= 1;
        if (where.computerId) slotStatuses.set(where.computerId, String(data.status));
        return { count: 1 };
      },
    },
  };

  const view = await settleStaleCollectRun(
    db as never,
    { workspaceId: "ws-1", userId: "user-1", runId: "run-1" },
    startedAt.getTime() + 1_000,
    async () => {
      activePresenceChecks += 1;
      maxPresenceChecks = Math.max(maxPresenceChecks, activePresenceChecks);
      await Promise.resolve();
      activePresenceChecks -= 1;
      return false;
    },
  );

  expect(maxPresenceChecks).toBe(2);
  expect(maxSlotUpdates).toBe(2);
  expect(view.status).toBe(COLLECT_RUN_STATUS.cancelled);
});
