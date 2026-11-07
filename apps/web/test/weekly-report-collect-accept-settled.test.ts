import { expect, test } from "bun:test";
import { acceptCollectSlotReport } from "#src/server/records/weekly-report-collect-run.server";

/**
 * `acceptCollectSlotReport`'s not-accepted shapes (task #695): a slot already settled by a
 * different submission is a rejection, while a requestId replay carrying the same outcome is
 * "already accepted" — the CLI words the two differently, so the service must tell them apart.
 */

const SLOT_REQUEST_ID = "11111111-1111-4111-8111-111111111111";

const slotRow = () => ({
  id: "slot-1",
  computerId: "computer-1",
  collectorAgentId: "agent-1",
  scanPaths: ["/work"],
  status: "empty",
  retryCount: 0,
  failureReason: null,
  packMarkdown: null,
  requestId: SLOT_REQUEST_ID,
});

const runRow = () => ({
  id: "run-1",
  reportId: "report-1",
  workspaceId: "ws-1",
  userId: "user-1",
  status: "collecting",
  windowKind: "week",
  windowStart: new Date("2026-08-31T00:00:00.000Z"),
  windowEnd: new Date("2026-09-07T00:00:00.000Z"),
  startedAt: new Date("2026-09-17T00:00:00.000Z"),
  completedAt: null,
  createdAt: new Date("2026-09-17T00:00:00.000Z"),
  slots: [slotRow()],
});

const db = {
  weeklyReportCollectSlot: {
    findFirst: async ({ where }: { where: { requestId?: string } }) =>
      where.requestId === SLOT_REQUEST_ID ? { ...slotRow(), run: runRow() } : null,
    update: async () => {
      throw new Error("a settled slot must not be written");
    },
  },
  weeklyReportCollectRun: {
    findFirst: async () => runRow(),
    findFirstOrThrow: async () => runRow(),
    updateMany: async () => ({ count: 0 }),
  },
};

const submit = (requestId: string, outcome: "ready" | "empty" | "failed") =>
  acceptCollectSlotReport(db as never, {
    workspaceId: "ws-1",
    agentId: "agent-1",
    requestId,
    runId: "run-1",
    outcome,
  });

test("acceptCollectSlotReport distinguishes replay from a settled slot", async () => {
  // A different requestId against the settled slot: rejected, not a replay.
  const settled = await submit("22222222-2222-4222-8222-222222222222", "failed");
  expect(settled.newlyAccepted).toBe(false);
  expect(settled.replayed).toBe(false);
  expect(settled.slotStatus).toBe("empty");

  // The same requestId carrying a different outcome reused it: still not this submission's
  // result, so not a replay either.
  const reused = await submit(SLOT_REQUEST_ID, "failed");
  expect(reused.newlyAccepted).toBe(false);
  expect(reused.replayed).toBe(false);
  expect(reused.slotStatus).toBe("empty");

  // The genuine retry: same requestId, same outcome — already accepted earlier.
  const replay = await submit(SLOT_REQUEST_ID, "empty");
  expect(replay.newlyAccepted).toBe(false);
  expect(replay.replayed).toBe(true);
  expect(replay.slotStatus).toBe("empty");
});
