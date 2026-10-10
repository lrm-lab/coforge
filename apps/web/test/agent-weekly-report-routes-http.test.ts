import { expect, test } from "bun:test";

import { handleWeeklyReportCollectPost } from "#src/routes/api/agent/v1/weekly-report-collect";
import { handleWeeklyReportKeyPointsPost } from "#src/routes/api/agent/v1/weekly-report-key-points";
import { handleWeeklyReportMemoryPost } from "#src/routes/api/agent/v1/weekly-report-memory";
import type { CollectRunView } from "#src/server/records/weekly-report-collect-run.server";

const principal = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
  computerId: "33333333-3333-4333-8333-333333333333",
};
const KEY = "44444444-4444-4444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555";
const REPORT = "66666666-6666-4666-8666-666666666666";

const request = (path: string, body: unknown) =>
  new Request(`https://server.example/api/agent/v1/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

const runView: CollectRunView = {
  id: RUN,
  reportId: REPORT,
  status: "synthesizing",
  windowKind: "week",
  windowStart: new Date("2026-09-21T00:00:00Z"),
  windowEnd: new Date("2026-09-28T00:00:00Z"),
  startedAt: new Date("2026-09-28T01:00:00Z"),
  completedAt: null,
  createdAt: new Date("2026-09-28T00:30:00Z"),
  slots: [],
  allTerminal: true,
  canSynthesize: true,
};

// The daemon's weekly-report clients reject a response whose `idempotencyKey` does not echo the
// request's, so every one of these routes has to hand the key back under that name.

test("the collect route echoes the request's idempotencyKey when it accepts a slot report", async () => {
  let received: { requestId: string } | undefined;
  const response = await handleWeeklyReportCollectPost(
    request("weekly-report-collect", { idempotencyKey: KEY, runId: RUN, outcome: "empty" }),
    principal,
    {
      reportCollectSlotOutcome: async (input) => {
        received = input;
        return { run: runView, newlyAccepted: true, synthesisStarted: true, waveExhausted: false };
      },
      reportCollectorRuntimeFailure: async () => {
        throw new Error("not a turn-fail request");
      },
    },
  );

  expect(response.status).toBe(200);
  expect(received?.requestId).toBe(KEY);
  expect(await response.json()).toEqual({
    idempotencyKey: KEY,
    runId: RUN,
    status: "synthesizing",
    allTerminal: true,
    canSynthesize: true,
    newlyAccepted: true,
    synthesisStarted: true,
    waveExhausted: false,
  });
});

test("the collect route echoes the request's idempotencyKey on the turn-fail path", async () => {
  let received: { requestId: string } | undefined;
  const response = await handleWeeklyReportCollectPost(
    request("weekly-report-collect", {
      idempotencyKey: KEY,
      failRunningSlots: true,
      failureReason: "Error: 405 Not Allowed",
    }),
    principal,
    {
      reportCollectSlotOutcome: async () => {
        throw new Error("not a slot report");
      },
      reportCollectorRuntimeFailure: async (input) => {
        received = input;
        return { accepted: [], slotCount: 0 };
      },
    },
  );

  expect(response.status).toBe(200);
  expect(received?.requestId).toBe(KEY);
  expect(await response.json()).toMatchObject({ idempotencyKey: KEY, slotCount: 0 });
});

test("the key-points route echoes the request's idempotencyKey", async () => {
  let received: { requestId: string } | undefined;
  const response = await handleWeeklyReportKeyPointsPost(
    request("weekly-report-key-points", {
      idempotencyKey: KEY,
      reportId: REPORT,
      markdown: "# ok",
    }),
    principal,
    async (input) => {
      received = input;
      return { status: "ready", reportId: REPORT };
    },
  );

  expect(response.status).toBe(200);
  expect(received?.requestId).toBe(KEY);
  expect(await response.json()).toEqual({ idempotencyKey: KEY, reportId: REPORT, status: "ready" });
});

test("the memory route echoes the request's idempotencyKey and stores the settlement", async () => {
  let received:
    | { settlement: { explicitRules: Array<{ statement: string; effect: string }> } }
    | undefined;
  const response = await handleWeeklyReportMemoryPost(
    request("weekly-report-memory", {
      idempotencyKey: KEY,
      reportId: REPORT,
      year: 2026,
      week: 40,
      preferences: ["先写结果"],
      explicitRules: [{ statement: "以后都先写结果", effect: "adopt" }],
      factCorrections: ["已上线改为还在测试"],
      threads: [{ title: "登录改造", status: "open" }],
    }),
    principal,
    async (input) => {
      received = input;
      return { status: "saved", reportId: REPORT };
    },
  );

  expect(response.status).toBe(200);
  expect(received?.settlement.explicitRules).toEqual([
    { statement: "以后都先写结果", effect: "adopt" },
  ]);
  expect(await response.json()).toEqual({ idempotencyKey: KEY, reportId: REPORT, status: "saved" });
});

test("the memory route rejects a settlement with an empty preference", async () => {
  const response = await handleWeeklyReportMemoryPost(
    request("weekly-report-memory", {
      idempotencyKey: KEY,
      reportId: REPORT,
      year: 2026,
      week: 40,
      preferences: ["  "],
      explicitRules: [],
      factCorrections: [],
      threads: [],
    }),
    principal,
    async () => {
      throw new Error("service called");
    },
  );

  expect(response.status).toBe(400);
});
