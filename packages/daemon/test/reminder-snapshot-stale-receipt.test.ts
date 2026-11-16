import { expect, test } from "bun:test";
import { ReminderScheduler } from "#src/agent-reminder/reminder-scheduler";
import { captureDaemonLogs } from "./log-capture";
import { Clock, exhaustedLogs, job, MemoryStore, snapshot } from "./reminder-scheduler-fixtures";

/** Main's follow-up on `f35a625f6`: the per-Agent serial queue closes the window between "retries
 * exhausted" and "the receipt is persisted", except when the store is the step that fails. The disk
 * then still holds the older, unexhausted copy while the durable write backs off for up to a
 * minute, and a snapshot restoring in that gap must not take the exhausted occurrence back from it
 * and run it again. */
test("a snapshot inside a backing-off receipt write leaves the exhausted receipt alone", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  const write = store.write.bind(store);
  let backingOff = true;
  // The exhaustion write is the one that backs off, so the disk keeps the older, unexhausted copy.
  store.write = async (agentId, receipts) => {
    if (backingOff && receipts.some((receipt) => receipt.retryExhausted))
      throw new Error("receipt write is backing off");
    await write(agentId, receipts);
  };
  const ids: string[] = [];
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      ids.push(request.requestId);
      throw Object.assign(new Error("method not found"), { code: 104 });
    },
    async () => {
      throw new Error("must not wake");
    },
    clock,
    () => 0.5,
  );
  let exhaustedAt = 0;
  const { records } = await captureDaemonLogs(async () => {
    await scheduler.apply(snapshot([job]));
    await clock.advance(1000);
    await scheduler.awaitIdle();
    for (const delay of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000]) {
      await clock.advance(delay);
      await scheduler.awaitIdle();
    }
    // Eight attempts, then the exhaustion write is refused: the disk still holds the older copy.
    expect(ids).toHaveLength(8);
    expect(store.receipts[0]?.retryExhausted).toBeUndefined();
    exhaustedAt = clock.now();

    // A snapshot arrives seconds into that gap, then the store stays in backoff a while longer.
    await clock.advance(5000);
    await scheduler.awaitIdle();
    await scheduler.apply(snapshot([job]));
    await clock.advance(1);
    await scheduler.awaitIdle();
    expect(ids).toHaveLength(8);

    // The write recovers on its own schedule; what it then stores is still the exhausted receipt.
    backingOff = false;
    for (const delay of [1000, 2000, 4000]) {
      await clock.advance(delay);
      await scheduler.awaitIdle();
    }
  });
  // Restoring the stale copy would re-arm the occurrence from it, which shows as a second exhaustion
  // of an occurrence that was never asked again.
  expect(exhaustedLogs(records)).toHaveLength(1);
  // The recovered write permits exactly one reconciliation attempt; the stale snapshot must not
  // create a second occurrence or a second exhaustion record.
  expect(ids).toHaveLength(9);
  expect(new Set(ids).size).toBe(1);
  expect(store.receipts[0]).toMatchObject({ attempt: 8, terminal: false });
  expect(store.receipts[0]?.retryExhausted).toMatchObject({ stage: "fire", attempts: 8 });
  expect(store.receipts[0]?.retryExhausted?.exhaustedAt).toBe(exhaustedAt);
});

test("a restarted scheduler reconciles a persisted exhausted receipt once", async () => {
  const clock = new Clock();
  clock.time = Date.parse("2026-09-08T12:01:00Z");
  const store = new MemoryStore();
  store.receipts = [
    {
      workspaceId: "workspace-a",
      computerId: "computer-a",
      agentId: job.ownerAgentId,
      reminderId: job.reminderId,
      version: job.version,
      job,
      requestId: "persisted-request",
      firedAtClient: new Date(clock.time - 60_000).toISOString(),
      attempt: 8,
      deadline: clock.time - 30_000,
      nextAt: clock.time - 20_000,
      wakeAccepted: false,
      consumed: false,
      terminal: true,
      retryExhausted: {
        code: "REMINDER_DELIVERY_RETRY_EXHAUSTED",
        stage: "fire",
        attempts: 8,
        deadline: clock.time - 30_000,
        exhaustedAt: clock.time - 40_000,
      },
    },
  ];
  const requestIds: string[] = [];
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      requestIds.push(request.requestId);
      return { ...request, result: "accepted", fired: true, catchup: true };
    },
    async () => true,
    clock,
  );

  await scheduler.apply(snapshot([job]));
  await clock.advance(0);
  await scheduler.awaitIdle();

  expect(requestIds).toEqual(["persisted-request"]);
  expect(store.receipts[0]).toMatchObject({
    serverResult: "accepted",
    serverFired: true,
    terminal: true,
  });
  expect(store.receipts[0]).not.toHaveProperty("retryExhausted");
});
