import { expect, test } from "bun:test";

import { dispatchCollectorWakes } from "#src/server/records/weekly-report-collect-dispatch.server";
import {
  COLLECT_RUN_STATUS,
  COLLECT_SLOT_STATUS,
} from "#src/server/records/weekly-report-collect-run.server";

type SlotRow = {
  id: string;
  collectorAgentId: string;
  computerId: string;
  scanPaths: string[];
  status: string;
  failureReason: string | null;
  requestId: string | null;
};

function fakeDb(slots: SlotRow[]) {
  const run: { id: string; status: string; slots: SlotRow[] } = {
    id: "run-1",
    status: COLLECT_RUN_STATUS.collecting,
    slots,
  };
  const slotUpdateMany: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const runUpdateMany: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const db = {
    user: {
      findUnique: async () => ({
        username: "owner",
        displayName: null,
        gitHubConnection: null,
      }),
    },
    weeklyReportCollectSlot: {
      updateMany: async (args: { where: unknown; data: Record<string, unknown> }) => {
        slotUpdateMany.push(args);
        const where = args.where as {
          id?: { in?: string[] };
          runId?: string;
          status?: string;
        };
        for (const slot of slots) {
          if (where.id?.in && !where.id.in.includes(slot.id)) continue;
          if (where.runId !== undefined) continue;
          if (where.status !== undefined && slot.status !== where.status) continue;
          Object.assign(slot, args.data);
        }
        return { count: slots.length };
      },
    },
    weeklyReportCollectRun: {
      findFirst: async () => run,
      updateMany: async (args: { where: unknown; data: Record<string, unknown> }) => {
        runUpdateMany.push(args);
        if (run.status === COLLECT_RUN_STATUS.collecting) Object.assign(run, args.data);
        return { count: 1 };
      },
    },
  };
  return { db: db as never, run, slotUpdateMany, runUpdateMany };
}

const slot = (id: string, computerId: string): SlotRow => ({
  id,
  collectorAgentId: `agent-${id}`,
  computerId,
  scanPaths: [],
  status: COLLECT_SLOT_STATUS.running,
  failureReason: null,
  requestId: null,
});

const input = (slots: SlotRow[]) => ({
  workspaceId: "ws-1",
  userId: "user-1",
  reportId: "report-1",
  runId: "run-1",
  slots,
  windowStart: new Date("2026-09-14T00:00:00Z"),
  windowEnd: new Date("2026-09-21T00:00:00Z"),
});

test("a failed wake send does not cancel slots whose DM already landed", async () => {
  const slots = [slot("slot-a", "computer-a"), slot("slot-b", "computer-b")];
  const { db, run } = fakeDb(slots);
  const sent: string[] = [];

  await dispatchCollectorWakes(db, input(slots), async (wakeSlot) => {
    sent.push(wakeSlot.id);
    if (wakeSlot.id === "slot-b") throw new Error("centrifugo publish failed");
  });

  // The already-dispatched slot must stay running so its collector can submit;
  // only the failed send settles, and without a requestId fence a stored DM can
  // still reopen it (#695).
  expect(sent).toEqual(["slot-a", "slot-b"]);
  expect(slots[0].status).toBe(COLLECT_SLOT_STATUS.running);
  expect(slots[1].status).toBe(COLLECT_SLOT_STATUS.failed);
  expect(slots[1].failureReason).toBe("collector dispatch failed");
  expect(slots[1].requestId).toBeNull();
  expect(run.status).toBe(COLLECT_RUN_STATUS.collecting);
});

test("when every wake send fails the run still cancels and the error surfaces", async () => {
  const slots = [slot("slot-a", "computer-a")];
  const { db, run } = fakeDb(slots);

  await expect(
    dispatchCollectorWakes(db, input(slots), async () => {
      throw new Error("send refused");
    }),
  ).rejects.toThrow("send refused");

  expect(slots[0].status).toBe(COLLECT_SLOT_STATUS.failed);
  expect(run.status).toBe(COLLECT_RUN_STATUS.cancelled);
});
