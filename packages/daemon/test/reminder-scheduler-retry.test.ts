import { expect, test } from "bun:test";
import type { ReminderFireRequest } from "@lrm/coforge-sdk/internal";
import type { ReminderReceipt, ReminderReceiptStore } from "#src/agent-reminder/reminder-receipt";
import { ReminderScheduler } from "#src/agent-reminder/reminder-scheduler";
import { captureDaemonLogs } from "./log-capture";
import { Clock, exhaustedLogs, job, MemoryStore, snapshot } from "./reminder-scheduler-fixtures";

test("a rejected network request completes and retries the same durable occurrence", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  const ids: string[] = [];
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      ids.push(request.requestId);
      if (ids.length === 1) throw new Error("offline");
      return { ...request, result: "accepted", fired: false, catchup: false };
    },
    async () => {
      throw new Error("must not wake");
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(1);
  expect(store.receipts[0]).toMatchObject({ attempt: 2, terminal: true, serverFired: false });
});

test("persistence failure is bounded and never sends an uncommitted occurrence", async () => {
  const clock = new Clock();
  let writes = 0;
  let sends = 0;
  const store: ReminderReceiptStore = {
    async read() {
      return [];
    },
    async write() {
      writes++;
      throw new Error("disk full");
    },
  };
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      sends++;
      return { ...request, result: "accepted", fired: true, catchup: false };
    },
    async () => true,
    clock,
  );
  const { records } = await captureDaemonLogs(async () => {
    await scheduler.apply(snapshot([job]));
    await clock.advance(1000);
    await scheduler.awaitIdle();
    for (let index = 0; index < 8; index++) {
      await clock.advance(60_000);
      await scheduler.awaitIdle();
    }
  });
  expect(writes).toBe(8);
  expect(sends).toBe(0);
  expect(clock.timers).toHaveLength(0);
  const exhausted = exhaustedLogs(records);
  expect(exhausted).toHaveLength(1);
  expect(exhausted[0]!.properties).toMatchObject({
    outcome: "failed",
    code: "REMINDER_DELIVERY_RETRY_EXHAUSTED",
    reminder_id: job.reminderId,
    stage: "persistence",
    persistence_failures: 8,
    error_name: "Error",
  });
});

test("a failed attempt write prevents fire until the durable retry", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  let writes = 0;
  const write = store.write.bind(store);
  store.write = async (agentId, receipts) => {
    writes++;
    if (writes === 2) throw new Error("second write failed");
    await write(agentId, receipts);
  };
  const ids: string[] = [];
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      ids.push(request.requestId);
      return { ...request, result: "accepted", fired: false, catchup: false };
    },
    async () => false,
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(ids).toEqual([]);
  const requestId = store.receipts[0]!.requestId;
  await clock.advance(999);
  await scheduler.awaitIdle();
  expect(ids).toEqual([]);
  await clock.advance(1);
  await scheduler.awaitIdle();
  expect(ids).toEqual([requestId]);
});

test("an accepted verdict is not woken until its result is durable", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  let writes = 0;
  const write = store.write.bind(store);
  store.write = async (agentId, receipts) => {
    writes++;
    if (writes === 3) throw new Error("accepted result write failed");
    await write(agentId, receipts);
  };
  let wakes = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => ({ ...request, result: "accepted", fired: true, catchup: false }),
    async () => {
      wakes++;
      return true;
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(wakes).toBe(0);
  expect(store.receipts[0]?.serverResult).toBeUndefined();
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(wakes).toBe(1);
  expect(store.receipts[0]).toMatchObject({ serverResult: "accepted", wakeAccepted: true });
});

test("a rejected wake waits for each backoff and exhausts the bounded attempt budget", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  let wakes = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => ({ ...request, result: "accepted", fired: true, catchup: false }),
    async () => {
      wakes++;
      return false;
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(wakes).toBe(1);
  await clock.advance(1999);
  await scheduler.awaitIdle();
  expect(wakes).toBe(1);
  await clock.advance(1);
  await scheduler.awaitIdle();
  expect(wakes).toBe(2);
  for (const delay of [4000, 8000, 16_000, 32_000, 60_000]) {
    await clock.advance(delay);
    await scheduler.awaitIdle();
  }
  expect(wakes).toBe(7);
  expect(store.receipts[0]).toMatchObject({
    attempt: 8,
    terminal: true,
    retryExhausted: { stage: "wake", attempts: 8 },
  });
  expect(clock.timers).toHaveLength(0);
});

test("a premature delay beyond one budget rearms a fresh authoritative occurrence", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  const requests: ReminderFireRequest[] = [];
  const retryAfterMs = 16 * 60_000;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      requests.push(request);
      if (requests.length === 1)
        return {
          ...request,
          result: "premature",
          fired: false,
          catchup: false,
          retryAfterMs,
        };
      return { ...request, result: "accepted", fired: false, catchup: false };
    },
    async () => false,
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(store.receipts).toEqual([]);
  await clock.advance(retryAfterMs - 1);
  await scheduler.awaitIdle();
  expect(requests).toHaveLength(1);
  await clock.advance(1);
  await scheduler.awaitIdle();
  expect(requests).toHaveLength(2);
  expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId);
  expect(requests[1]!.firedAtClient).not.toBe(requests[0]!.firedAtClient);
  expect(store.receipts[0]?.job).toEqual(job);
  expect(store.receipts[0]!.deadline - Date.parse(store.receipts[0]!.firedAtClient)).toBe(
    15 * 60_000,
  );
});

test("a receipt write drops consumed receipts whose re-fire fence expired", async () => {
  const store = new MemoryStore();
  const clock = new Clock();
  const consumed = (reminderId: string, deadline: number): ReminderReceipt => ({
    workspaceId: "workspace-a",
    computerId: "computer-a",
    agentId: "agent-a",
    reminderId,
    version: 1,
    job: { ...job, reminderId, version: 1 },
    requestId: crypto.randomUUID(),
    firedAtClient: new Date(deadline).toISOString(),
    attempt: 2,
    deadline,
    nextAt: deadline,
    serverResult: "accepted",
    serverFired: true,
    wakeAccepted: true,
    consumed: true,
    terminal: true,
  });
  const day = 24 * 60 * 60 * 1000;
  store.receipts = [
    consumed("123e4567-e89b-42d3-a456-426614174101", clock.time - 8 * day),
    consumed("123e4567-e89b-42d3-a456-426614174102", clock.time - 1 * day),
  ];
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => ({ ...request, result: "accepted", fired: true, catchup: false }),
    async () => true,
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();

  expect(store.receipts.map((r) => r.reminderId)).toEqual([
    "123e4567-e89b-42d3-a456-426614174102",
    job.reminderId,
  ]);
});

test("a fire request that keeps failing records why its retries ran out", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  let fires = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async () => {
      fires++;
      throw Object.assign(new Error("method not found"), { code: 104 });
    },
    async () => {
      throw new Error("must not wake");
    },
    clock,
  );
  const { records } = await captureDaemonLogs(async () => {
    await scheduler.apply(snapshot([job]));
    await clock.advance(1000);
    await scheduler.awaitIdle();
    for (const delay of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000]) {
      await clock.advance(delay);
      await scheduler.awaitIdle();
    }
  });
  expect(fires).toBe(8);
  expect(store.receipts[0]).toMatchObject({
    terminal: true,
    wakeAccepted: false,
    retryExhausted: {
      code: "REMINDER_DELIVERY_RETRY_EXHAUSTED",
      stage: "fire",
      attempts: 8,
      deadline: Date.parse("2026-09-08T12:15:01Z"),
      exhaustedAt: Date.parse("2026-09-08T12:02:04Z"),
    },
  });
  expect(store.receipts[0]?.serverResult).toBeUndefined();
  expect(clock.timers).toHaveLength(0);
  const exhausted = exhaustedLogs(records);
  expect(exhausted).toHaveLength(1);
  expect(exhausted[0]!.level).toBe("error");
  expect(exhausted[0]!.properties).toMatchObject({
    outcome: "failed",
    code: "REMINDER_DELIVERY_RETRY_EXHAUSTED",
    agent_id: "agent-a",
    reminder_id: job.reminderId,
    reminder_version: job.version,
    stage: "fire",
    attempts: 8,
    retry_deadline: "2026-09-08T12:15:01.000Z",
    error_code: "104",
    error_name: "Error",
  });
});

test("a wake that keeps failing after the cloud fired records the wake step and its error", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  let wakes = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => ({ ...request, result: "accepted", fired: true, catchup: false }),
    async () => {
      wakes++;
      throw Object.assign(new TypeError("agent socket closed"), { code: "ECONNRESET" });
    },
    clock,
  );
  const { records } = await captureDaemonLogs(async () => {
    await scheduler.apply(snapshot([job]));
    await clock.advance(1000);
    await scheduler.awaitIdle();
    for (const delay of [2000, 4000, 8000, 16_000, 32_000, 60_000]) {
      await clock.advance(delay);
      await scheduler.awaitIdle();
    }
  });
  expect(wakes).toBe(7);
  expect(store.receipts[0]).toMatchObject({
    serverResult: "accepted",
    serverFired: true,
    wakeAccepted: false,
    terminal: true,
    retryExhausted: {
      code: "REMINDER_DELIVERY_RETRY_EXHAUSTED",
      stage: "wake",
      attempts: 8,
      deadline: Date.parse("2026-09-08T12:15:01Z"),
      exhaustedAt: Date.parse("2026-09-08T12:02:03Z"),
    },
  });
  const exhausted = exhaustedLogs(records);
  expect(exhausted).toHaveLength(1);
  expect(exhausted[0]!.properties).toMatchObject({
    stage: "wake",
    attempts: 8,
    error_code: "ECONNRESET",
    error_name: "TypeError",
  });
});

test("a fire the cloud accepts on the last attempt leaves no attempt to wake and says so", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  let fires = 0;
  let wakes = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      fires++;
      if (fires < 8) throw Object.assign(new Error("offline"), { code: "EOFFLINE" });
      return { ...request, result: "accepted", fired: true, catchup: false };
    },
    async () => {
      wakes++;
      return true;
    },
    clock,
  );
  const { records } = await captureDaemonLogs(async () => {
    await scheduler.apply(snapshot([job]));
    await clock.advance(1000);
    await scheduler.awaitIdle();
    for (const delay of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000]) {
      await clock.advance(delay);
      await scheduler.awaitIdle();
    }
  });
  expect(fires).toBe(8);
  expect(wakes).toBe(0);
  expect(store.receipts[0]).toMatchObject({
    serverResult: "accepted",
    serverFired: true,
    wakeAccepted: false,
    terminal: true,
    retryExhausted: { stage: "wake", attempts: 8 },
  });
  const exhausted = exhaustedLogs(records);
  expect(exhausted).toHaveLength(1);
  expect(exhausted[0]!.properties).toMatchObject({ stage: "wake", attempts: 8 });
  // The last attempt did not fail, so no earlier attempt's error is reported as the reason.
  expect(exhausted[0]!.properties.error_code).toBeUndefined();
  expect(exhausted[0]!.properties.error_name).toBeUndefined();
});

test("a fire deferred to its deadline runs out of time before its attempts do", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  let fires = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      fires++;
      // The cloud defers the fire by exactly the whole retry budget.
      return {
        ...request,
        result: "premature",
        fired: false,
        catchup: false,
        retryAfterMs: 15 * 60_000,
      };
    },
    async () => {
      throw new Error("must not wake");
    },
    clock,
  );
  const { records } = await captureDaemonLogs(async () => {
    await scheduler.apply(snapshot([job]));
    await clock.advance(1000);
    await scheduler.awaitIdle();
    await clock.advance(15 * 60_000);
    await scheduler.awaitIdle();
  });
  expect(fires).toBe(1);
  expect(store.receipts[0]).toMatchObject({
    terminal: true,
    retryExhausted: {
      code: "REMINDER_DELIVERY_RETRY_EXHAUSTED",
      stage: "fire",
      attempts: 1,
      deadline: Date.parse("2026-09-08T12:15:01Z"),
      exhaustedAt: Date.parse("2026-09-08T12:15:01Z"),
    },
  });
  const exhausted = exhaustedLogs(records);
  expect(exhausted).toHaveLength(1);
  expect(exhausted[0]!.properties).toMatchObject({ stage: "fire", attempts: 1 });
});

test("a delivered or declined occurrence ends without an exhausted record", async () => {
  for (const [result, fired, wake] of [
    ["accepted", true, true],
    ["obsolete", false, false],
  ] as const) {
    const clock = new Clock();
    const store = new MemoryStore();
    const scheduler = new ReminderScheduler(
      { workspaceId: "workspace-a", computerId: "computer-a" },
      store,
      async (request) => ({ ...request, result, fired, catchup: false }),
      async () => wake,
      clock,
    );
    const { records } = await captureDaemonLogs(async () => {
      await scheduler.apply(snapshot([job]));
      await clock.advance(1000);
      await scheduler.awaitIdle();
    });
    expect(store.receipts[0]).toMatchObject({ serverResult: result, terminal: true });
    expect(store.receipts[0]).not.toHaveProperty("retryExhausted");
    expect(exhaustedLogs(records)).toHaveLength(0);
  }
});

test("a wake on time is not late, even when the cloud calls the fire a catch-up", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  const wakes: Array<{ late: boolean }> = [];
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    // The cloud marks any fire after the due instant as a catch-up, even by a millisecond.
    async (request) => ({ ...request, result: "accepted", fired: true, catchup: true }),
    async (_job, occurrence) => {
      wakes.push(occurrence);
      return true;
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(wakes).toEqual([{ late: false }]);
});

test("a wake more than a minute after the due time is late", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  const wakes: Array<{ late: boolean }> = [];
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => ({ ...request, result: "accepted", fired: true, catchup: true }),
    async (_job, occurrence) => {
      wakes.push(occurrence);
      return true;
    },
    clock,
  );
  // The daemon was offline at the due time and learns about the reminder two hours later.
  clock.time = Date.parse(job.fireAt) + 2 * 60 * 60_000;
  await scheduler.apply(snapshot([job]));
  await clock.advance(0);
  await scheduler.awaitIdle();
  expect(wakes).toEqual([{ late: true }]);
});
