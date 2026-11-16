import { expect, test } from "bun:test";
import type { ReminderFireRequest, ReminderFireResponse } from "@lrm/coforge-sdk/internal";
import { ReminderScheduler } from "#src/agent-reminder/reminder-scheduler";
import {
  change,
  Clock,
  HoldableStore,
  job,
  MemoryStore,
  snapshot,
} from "./reminder-scheduler-fixtures";

test("fires only an authoritative snapshot job and persists identity before waking", async () => {
  const store = new MemoryStore();
  const clock = new Clock();
  const observed: string[] = [];
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      expect(store.receipts[0]?.requestId).toBe(request.requestId);
      observed.push("fire");
      return {
        ...request,
        result: "accepted",
        fired: true,
        catchup: false,
      } satisfies ReminderFireResponse;
    },
    async () => {
      observed.push("wake");
      return true;
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(observed).toEqual(["fire", "wake"]);
  expect(store.receipts[0]).toMatchObject({
    attempt: 2,
    serverResult: "accepted",
    wakeAccepted: true,
  });
});

test("replacement snapshot cancels the old timer and exact revision ack is idempotent", async () => {
  const store = new MemoryStore();
  const clock = new Clock();
  let fires = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      fires++;
      return { ...request, result: "accepted", fired: true, catchup: false };
    },
    async () => true,
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await scheduler.apply(snapshot([]));
  await clock.advance(2000);
  expect(fires).toBe(0);
  store.receipts = [
    {
      workspaceId: "workspace-a",
      computerId: "computer-a",
      agentId: "agent-a",
      reminderId: job.reminderId,
      version: 3,
      job,
      requestId: "stable",
      firedAtClient: job.fireAt,
      attempt: 1,
      deadline: clock.time + 1,
      nextAt: clock.time,
      serverResult: "accepted",
      serverFired: true,
      serverCatchup: false,
      wakeAccepted: true,
      consumed: false,
      terminal: false,
    },
  ];
  expect(await scheduler.acknowledge("agent-a", job.reminderId, 2)).toBe(false);
  expect(await scheduler.acknowledge("agent-a", job.reminderId, 3)).toBe(true);
  expect(await scheduler.acknowledge("agent-a", job.reminderId, 3)).toBe(true);
});

test("an empty authoritative snapshot restores a committed occurrence payload", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  store.receipts = [
    {
      workspaceId: "workspace-a",
      computerId: "computer-a",
      agentId: "agent-a",
      reminderId: job.reminderId,
      version: job.version,
      job,
      requestId: "stable",
      firedAtClient: job.fireAt,
      attempt: 1,
      deadline: clock.time + 60_000,
      nextAt: clock.time,
      wakeAccepted: false,
      consumed: false,
      terminal: false,
    },
  ];
  const requests: string[] = [];
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      requests.push(request.requestId);
      return { ...request, result: "accepted", fired: true, catchup: true };
    },
    async (restored) => restored.title === "Review",
    clock,
  );
  await scheduler.apply(snapshot([]));
  await clock.advance(0);
  await scheduler.awaitIdle();
  expect(requests).toEqual(["stable"]);
  expect(store.receipts[0]).toMatchObject({ serverFired: true, wakeAccepted: true });
});

test("cancel tombstone rejects the same and older upsert versions", async () => {
  const clock = new Clock();
  let fires = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    new MemoryStore(),
    async (request) => {
      fires++;
      return { ...request, result: "accepted", fired: true, catchup: false };
    },
    async () => true,
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await scheduler.apply(change("cancel", 4));
  await scheduler.apply(change("upsert", 4));
  await scheduler.apply(change("upsert", 3));
  await clock.advance(2000);
  expect(fires).toBe(0);
});

test("stop during a pending fire prevents its response from waking or arming", async () => {
  const clock = new Clock();
  let resolve!: (response: ReminderFireResponse) => void;
  let fireStarted!: () => void;
  const started = new Promise<void>((done) => (fireStarted = done));
  let wakes = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    new MemoryStore(),
    (_request) =>
      new Promise((done) => {
        fireStarted();
        resolve = (response) => done(response);
      }),
    async () => {
      wakes++;
      return true;
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await started;
  scheduler.stop();
  resolve({
    protocolMajor: 1,
    requestId: "ignored",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    agentId: "agent-a",
    reminderId: job.reminderId,
    version: job.version,
    result: "accepted",
    fired: true,
    catchup: false,
  });
  await scheduler.awaitIdle();
  expect(wakes).toBe(0);
  expect(clock.timers).toHaveLength(0);
});

test("a receipt write under way when the scheduler stops still lands and arms no retry", async () => {
  const store = new HoldableStore();
  const clock = new Clock();
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => ({ ...request, result: "accepted", fired: true, catchup: false }),
    async () => {
      // The refused wake is recorded next: hold that write.
      store.holding = true;
      throw new Error("wake refused");
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await store.started.promise;
  const writesWhenStopped = store.writes;

  scheduler.stop();
  store.release.resolve();
  await scheduler.awaitIdle();

  expect(store.writes).toBe(writesWhenStopped + 1);
  expect(store.receipts[0]).toMatchObject({ serverResult: "accepted", wakeAccepted: false });
  expect(clock.timers).toHaveLength(0);
});

test("a premature answer whose receipt is deleted after the scheduler stopped arms no server retry", async () => {
  const store = new HoldableStore();
  const clock = new Clock();
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      // Later than one retry budget: the occurrence is deleted and rearmed from the schedule.
      store.holding = true;
      return {
        ...request,
        result: "premature",
        fired: false,
        catchup: false,
        retryAfterMs: 16 * 60_000,
      };
    },
    async () => false,
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await store.started.promise;

  scheduler.stop();
  store.release.resolve();
  await scheduler.awaitIdle();

  expect(store.receipts).toEqual([]);
  expect(clock.timers).toHaveLength(0);
});

for (const [field, mismatch] of [
  ["requestId", "another-request"],
  ["workspaceId", "another-workspace"],
  ["computerId", "another-computer"],
  ["agentId", "another-agent"],
  ["reminderId", "123e4567-e89b-42d3-a456-426614174099"],
  ["protocolMajor", 2],
  ["version", 4],
] as const) {
  test(`a fire response with mismatched ${field} is not accepted or woken`, async () => {
    const clock = new Clock();
    const store = new MemoryStore();
    let wakes = 0;
    const scheduler = new ReminderScheduler(
      { workspaceId: "workspace-a", computerId: "computer-a" },
      store,
      async (request) => ({
        ...request,
        result: "accepted",
        fired: true,
        catchup: false,
        [field]: mismatch,
      }),
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
    expect(store.receipts[0]?.terminal).toBe(false);
  });
}

test("a newer recurring schedule does not invalidate its pending occurrence", async () => {
  const clock = new Clock();
  let resolve!: (response: ReminderFireResponse) => void;
  let request!: ReminderFireRequest;
  let begin!: () => void;
  const firing = new Promise<void>((done) => (begin = done));
  let wakes = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    new MemoryStore(),
    (sent) =>
      new Promise((done) => {
        begin();
        resolve = done;
        request = sent;
      }),
    async () => {
      wakes++;
      return true;
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await firing;
  await scheduler.apply(change("upsert", 4));
  resolve({ ...request, result: "accepted", fired: true, catchup: false });
  await scheduler.awaitIdle();
  expect(wakes).toBe(1);
});

test("an acknowledgement falls back to the daemon's own copy when the stored receipt is gone", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  let wakes = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => ({ ...request, result: "accepted", fired: true, catchup: false }),
    async () => {
      wakes++;
      // The Agent was shown the item but the wake is still retrying.
      return false;
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(wakes).toBe(1);

  // The receipt file disappears while the daemon still holds the receipt in memory.
  store.receipts = [];
  expect(await scheduler.acknowledge("agent-a", job.reminderId, job.version)).toBe(true);
  // The consumed copy is written back, so it keeps fencing the revision.
  expect(store.receipts).toEqual([
    expect.objectContaining({ reminderId: job.reminderId, version: job.version, consumed: true }),
  ]);

  // The acknowledged revision is not woken again.
  await clock.advance(60_000);
  await scheduler.awaitIdle();
  expect(wakes).toBe(1);
  expect(clock.timers).toHaveLength(0);
});

test("an acknowledgement whose receipt cannot be written fails instead of passing silently", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
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

  store.write = async () => {
    throw new Error("disk full");
  };
  await expect(scheduler.acknowledge("agent-a", job.reminderId, job.version)).rejects.toThrow(
    "disk full",
  );
});

test("an acknowledgement reads past an unreadable receipt file to the daemon's own copy", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
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

  store.read = async () => {
    throw new Error("reminder receipts are corrupt");
  };
  expect(await scheduler.acknowledge("agent-a", job.reminderId, job.version)).toBe(true);
});

/** A clock whose `cancel` cannot stop a timer, the way a real timer can already be queued to run
 * when it is cancelled: only the scheduler's own bookkeeping can make such a callback a no-op. */
class LeakyClock extends Clock {
  override cancel() {}
}

function countingScheduler(clock: Clock) {
  const fires: string[] = [];
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    new MemoryStore(),
    async (request) => {
      fires.push(request.requestId);
      return { ...request, result: "accepted", fired: true, catchup: false };
    },
    async () => true,
    clock,
  );
  return { scheduler, fires };
}

test("a timer replaced by a later arm does nothing even when the clock still runs it", async () => {
  const clock = new LeakyClock();
  const { scheduler, fires } = countingScheduler(clock);
  await scheduler.apply(snapshot([job]));
  await scheduler.apply(snapshot([job]));
  expect(clock.timers).toHaveLength(2);
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(fires).toHaveLength(1);
});

test("a timer the clock still runs after stop() does nothing", async () => {
  const clock = new LeakyClock();
  const { scheduler, fires } = countingScheduler(clock);
  await scheduler.apply(snapshot([job]));
  scheduler.stop();
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(fires).toEqual([]);
});

test("a reminder due beyond one day re-arms at the day cap instead of firing early", async () => {
  const clock = new Clock();
  const { scheduler, fires } = countingScheduler(clock);
  const day = 24 * 60 * 60_000;
  const fireAt = clock.time + day + 6 * 60 * 60_000;
  await scheduler.apply(snapshot([{ ...job, fireAt: new Date(fireAt).toISOString() }]));
  expect(clock.timers.map((timer) => timer.at)).toEqual([clock.time + day]);
  await clock.advance(day);
  await scheduler.awaitIdle();
  expect(fires).toEqual([]);
  expect(clock.timers.map((timer) => timer.at)).toEqual([fireAt]);
  await clock.advance(6 * 60 * 60_000);
  await scheduler.awaitIdle();
  expect(fires).toHaveLength(1);
});
