import { expect, test } from "bun:test";
import type { ReminderFireRequest, ReminderFireResponse } from "@lrm/coforge-sdk/internal";
import type { ReminderReceipt } from "#src/agent-reminder/reminder-receipt";
import { ReminderScheduler } from "#src/agent-reminder/reminder-scheduler";
import { captureDaemonLogs } from "./log-capture";
import { Clock, exhaustedLogs, job, MemoryStore, snapshot } from "./reminder-scheduler-fixtures";

const scope = { workspaceId: "workspace-a", computerId: "computer-a" };
const RECONCILE_MS = 5 * 60_000;
const accepted = (request: ReminderFireRequest): ReminderFireResponse => ({
  ...request,
  result: "accepted",
  fired: true,
  catchup: false,
});

async function exhaustFire(clock: Clock, scheduler: ReminderScheduler) {
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  for (const delay of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000]) {
    await clock.advance(delay);
    await scheduler.awaitIdle();
  }
}

const unreachableCloud = () => {
  const requestIds: string[] = [];
  const state = { up: false };
  const fire = async (request: ReminderFireRequest) => {
    requestIds.push(request.requestId);
    if (!state.up) throw new Error("offline");
    return accepted(request);
  };
  return { requestIds, state, fire };
};

test("an exhausted fire asks the cloud again with the same request id and wakes once it accepts", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  const cloud = unreachableCloud();
  const wakes: string[] = [];
  const scheduler = new ReminderScheduler(
    scope,
    store,
    cloud.fire,
    async (woken) => {
      wakes.push(woken.reminderId);
      return true;
    },
    clock,
    () => 0.5,
  );
  await captureDaemonLogs(() => exhaustFire(clock, scheduler));
  expect(cloud.requestIds).toHaveLength(8);
  expect(store.receipts[0]).toMatchObject({ terminal: false, retryExhausted: { stage: "fire" } });
  cloud.state.up = true;
  await clock.advance(RECONCILE_MS);
  await scheduler.awaitIdle();
  expect(cloud.requestIds).toHaveLength(9);
  expect(new Set(cloud.requestIds).size).toBe(1);
  expect(wakes).toEqual([job.reminderId]);
  expect(store.receipts[0]).toMatchObject({ wakeAccepted: true, terminal: true });
  expect(store.receipts[0]).not.toHaveProperty("retryExhausted");
  expect(clock.timers).toHaveLength(0);
});

test("a fire that keeps failing is retried once per reconciliation window and logged exhausted once", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  const cloud = unreachableCloud();
  const scheduler = new ReminderScheduler(
    scope,
    store,
    cloud.fire,
    async () => true,
    clock,
    () => 0.5,
  );
  const { records } = await captureDaemonLogs(async () => {
    await exhaustFire(clock, scheduler);
    for (let window = 0; window < 12; window++) {
      await clock.advance(RECONCILE_MS);
      await scheduler.awaitIdle();
    }
  });
  expect(cloud.requestIds).toHaveLength(8 + 12);
  expect(store.receipts[0]?.attempt).toBe(8);
  expect(store.receipts[0]?.retryExhausted?.attempts).toBe(8);
  expect(exhaustedLogs(records)).toHaveLength(1);
  expect(clock.timers).toHaveLength(1);
});

test("the reconciliation delay is five minutes with ten percent jitter", async () => {
  for (const [random, expected] of [
    [0, 270_000],
    [1, 330_000],
  ] as const) {
    const clock = new Clock();
    const store = new MemoryStore();
    const cloud = unreachableCloud();
    const scheduler = new ReminderScheduler(
      scope,
      store,
      cloud.fire,
      async () => true,
      clock,
      () => random,
    );
    await captureDaemonLogs(() => exhaustFire(clock, scheduler));
    expect(store.receipts[0]?.nextAt).toBe(
      store.receipts[0]!.retryExhausted!.exhaustedAt + expected,
    );
  }
});

test("a restarted scheduler resumes reconciliation at the persisted time", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  const cloud = unreachableCloud();
  const first = new ReminderScheduler(
    scope,
    store,
    cloud.fire,
    async () => true,
    clock,
    () => 0.5,
  );
  await captureDaemonLogs(() => exhaustFire(clock, first));
  first.stop();
  const persistedNextAt = store.receipts[0]!.nextAt;
  expect(persistedNextAt).toBe(clock.time + RECONCILE_MS);
  clock.timers = [];
  cloud.state.up = true;
  const wakes: string[] = [];
  const second = new ReminderScheduler(
    scope,
    store,
    cloud.fire,
    async (woken) => {
      wakes.push(woken.reminderId);
      return true;
    },
    clock,
    () => 0.5,
  );
  await second.apply(snapshot([job]));
  await clock.advance(RECONCILE_MS - 1);
  await second.awaitIdle();
  expect(cloud.requestIds).toHaveLength(8);
  await clock.advance(1);
  await second.awaitIdle();
  expect(cloud.requestIds).toHaveLength(9);
  expect(wakes).toEqual([job.reminderId]);
  expect(store.receipts[0]).not.toHaveProperty("retryExhausted");
});

test("a receipt an earlier build left terminal after a fire exhaustion is resumed", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  const now = clock.time;
  store.receipts = [
    {
      ...scope,
      agentId: job.ownerAgentId,
      reminderId: job.reminderId,
      version: job.version,
      job,
      requestId: crypto.randomUUID(),
      firedAtClient: new Date(now - 3_600_000).toISOString(),
      attempt: 8,
      deadline: now - 3_000_000,
      nextAt: now - 3_000_000,
      wakeAccepted: false,
      consumed: false,
      terminal: true,
      retryExhausted: {
        code: "REMINDER_DELIVERY_RETRY_EXHAUSTED",
        stage: "fire",
        attempts: 8,
        deadline: now - 3_000_000,
        exhaustedAt: now - 3_200_000,
      },
    },
  ];
  const requestId = store.receipts[0]!.requestId;
  const requestIds: string[] = [];
  const wakes: string[] = [];
  const scheduler = new ReminderScheduler(
    scope,
    store,
    async (request) => {
      requestIds.push(request.requestId);
      return accepted(request);
    },
    async (woken) => {
      wakes.push(woken.reminderId);
      return true;
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(0);
  await scheduler.awaitIdle();
  expect(requestIds).toEqual([requestId]);
  expect(wakes).toEqual([job.reminderId]);
  expect(store.receipts[0]).not.toHaveProperty("retryExhausted");
});

test("a wake that ran out of retries after the cloud fired keeps retrying every minute without firing again", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  let fires = 0;
  let wakes = 0;
  let agentUp = false;
  const scheduler = new ReminderScheduler(
    scope,
    store,
    async (request) => {
      fires++;
      return accepted(request);
    },
    async () => {
      wakes++;
      if (!agentUp) throw new Error("agent socket closed");
      return true;
    },
    clock,
  );
  await captureDaemonLogs(() => exhaustFire(clock, scheduler));
  expect(store.receipts[0]).toMatchObject({ terminal: false, retryExhausted: { stage: "wake" } });
  const wakesAtExhaustion = wakes;
  await clock.advance(60_000);
  await scheduler.awaitIdle();
  await clock.advance(60_000);
  await scheduler.awaitIdle();
  expect(wakes).toBe(wakesAtExhaustion + 2);
  expect(store.receipts[0]?.retryExhausted?.attempts).toBe(store.receipts[0]?.attempt);
  agentUp = true;
  await clock.advance(60_000);
  await scheduler.awaitIdle();
  expect(wakes).toBe(wakesAtExhaustion + 3);
  expect(fires).toBe(1);
  expect(store.receipts[0]).toMatchObject({ wakeAccepted: true, terminal: true });
  expect(store.receipts[0]).not.toHaveProperty("retryExhausted");
  expect(clock.timers).toHaveLength(0);
});

test("stop() during reconciliation leaves no timers and no further fires", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  const cloud = unreachableCloud();
  const scheduler = new ReminderScheduler(
    scope,
    store,
    cloud.fire,
    async () => true,
    clock,
    () => 0.5,
  );
  await captureDaemonLogs(() => exhaustFire(clock, scheduler));
  expect(clock.timers).toHaveLength(1);
  scheduler.stop();
  await scheduler.awaitIdle();
  expect(clock.timers).toHaveLength(0);
  await clock.advance(RECONCILE_MS * 3);
  await scheduler.awaitIdle();
  expect(cloud.requestIds).toHaveLength(8);
});

test("a receipt the cloud declined stays terminal and quiet", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  let fires = 0;
  const scheduler = new ReminderScheduler(
    scope,
    store,
    async (request) => {
      fires++;
      return { ...request, result: "obsolete", fired: false, catchup: false };
    },
    async () => {
      throw new Error("must not wake");
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  await clock.advance(RECONCILE_MS * 3);
  await scheduler.awaitIdle();
  expect(fires).toBe(1);
  expect(store.receipts[0]).toMatchObject({ terminal: true });
  expect(store.receipts[0]).not.toHaveProperty("retryExhausted");
  expect(clock.timers).toHaveLength(0);
});

test("a reconciliation whose next attempt could not be saved is still retried once the store recovers", async () => {
  const clock = new Clock();
  let failNextWrite = false;
  class FlakyStore extends MemoryStore {
    override async write(agentId: string, receipts: readonly ReminderReceipt[]) {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("disk busy");
      }
      await super.write(agentId, receipts);
    }
  }
  const store = new FlakyStore();
  let fires = 0;
  const scheduler = new ReminderScheduler(
    scope,
    store,
    async () => {
      fires++;
      if (fires === 9) failNextWrite = true;
      throw new Error("offline");
    },
    async () => true,
    clock,
    () => 0.5,
  );
  await captureDaemonLogs(async () => {
    await exhaustFire(clock, scheduler);
    await clock.advance(RECONCILE_MS);
    await scheduler.awaitIdle();
    expect(fires).toBe(9);
    await clock.advance(1000);
    await scheduler.awaitIdle();
    await clock.advance(RECONCILE_MS);
    await scheduler.awaitIdle();
  });
  expect(fires).toBe(10);
  expect(clock.timers).toHaveLength(1);
});

test("an exhausted fire outlasts a long store outage and is asked again once writes succeed", async () => {
  const clock = new Clock();
  let storeDown = false;
  class OutageStore extends MemoryStore {
    override async write(agentId: string, receipts: readonly ReminderReceipt[]) {
      if (storeDown) throw new Error("disk full");
      await super.write(agentId, receipts);
    }
  }
  const store = new OutageStore();
  let fires = 0;
  const scheduler = new ReminderScheduler(
    scope,
    store,
    async () => {
      fires++;
      throw new Error("offline");
    },
    async () => true,
    clock,
    () => 0.5,
  );
  await captureDaemonLogs(async () => {
    await exhaustFire(clock, scheduler);
    storeDown = true;
    for (let minute = 0; minute < 40; minute++) {
      await clock.advance(60_000);
      await scheduler.awaitIdle();
    }
    storeDown = false;
    for (let minute = 0; minute < 12; minute++) {
      await clock.advance(60_000);
      await scheduler.awaitIdle();
    }
  });
  expect(fires).toBeGreaterThan(8);
  expect(clock.timers).toHaveLength(1);
  expect(store.receipts[0]).toMatchObject({ terminal: false });
});

test("an acknowledgement after the wake ran out of retries ends the receipt as delivered", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  const scheduler = new ReminderScheduler(
    scope,
    store,
    async (request) => accepted(request),
    async () => false,
    clock,
    () => 0.5,
  );
  await captureDaemonLogs(() => exhaustFire(clock, scheduler));
  expect(store.receipts[0]).toMatchObject({ terminal: false, retryExhausted: { stage: "wake" } });
  expect(await scheduler.acknowledge(job.ownerAgentId, job.reminderId, job.version)).toBe(true);
  expect(store.receipts[0]).toMatchObject({ consumed: true, terminal: true });
  expect(store.receipts[0]).not.toHaveProperty("retryExhausted");
  await clock.advance(10 * 60_000);
  await scheduler.awaitIdle();
  expect(clock.timers).toHaveLength(0);
});
