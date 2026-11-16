import { expect, test } from "bun:test";
import type { ReminderJob, ReminderSync } from "@lrm/coforge-sdk/internal";
import {
  ReminderScheduler,
  type ReminderClock,
  type ReminderReceipt,
  type ReminderReceiptStore,
} from "#src/agent-reminder/reminder-scheduler";
import { captureDaemonLogs } from "./log-capture";

class MemoryStore implements ReminderReceiptStore {
  receipts: ReminderReceipt[] = [];
  async read() {
    return structuredClone(this.receipts);
  }
  async write(_agentId: string, receipts: readonly ReminderReceipt[]) {
    this.receipts = structuredClone([...receipts]);
  }
}

class Clock implements ReminderClock {
  time = Date.parse("2026-09-08T12:00:00Z");
  timers: Array<{ at: number; callback: () => void }> = [];
  now = () => this.time;
  schedule(callback: () => void, delayMs: number) {
    const timer = { at: this.time + delayMs, callback };
    this.timers.push(timer);
    return timer;
  }
  cancel(timer: unknown) {
    this.timers = this.timers.filter((item) => item !== timer);
  }
  async advance(ms: number) {
    this.time += ms;
    const due = this.timers.filter((timer) => timer.at <= this.time);
    this.timers = this.timers.filter((timer) => timer.at > this.time);
    for (const timer of due) timer.callback();
    await Promise.all(due.map(async () => {}));
  }
}

const reminderId = "123e4567-e89b-42d3-a456-426614174000";
const job: ReminderJob = {
  reminderId,
  ownerAgentId: "agent-a",
  version: 3,
  title: "Review",
  target: "@frank",
  messageId: "123e4567-e89b-42d3-a456-426614174001",
  fireAt: "2026-09-08T12:00:01Z",
};
const sync = (operation: ReminderSync["operation"], version: number): ReminderSync => ({
  protocolMajor: 1,
  requestId: crypto.randomUUID(),
  workspaceId: "workspace-a",
  computerId: "computer-a",
  agentId: "agent-a",
  operation,
  jobs: operation === "upsert" ? [{ ...job, version }] : [],
  ...(operation === "cancel" ? { reminderId, version } : {}),
  messageType: "coforge.rpc.v1.ReminderSync",
});
const snapshot = (jobs: ReminderJob[]): ReminderSync => ({ ...sync("snapshot", 0), jobs });

const harness = () => {
  const clock = new Clock();
  const asked: string[] = [];
  const fired: string[] = [];
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    new MemoryStore(),
    async (request) => {
      fired.push(request.reminderId);
      return { ...request, result: "accepted", fired: true, catchup: false };
    },
    async () => true,
    clock,
    (agentId) => asked.push(agentId),
  );
  return { clock, asked, fired, scheduler };
};

/** Raft's requirement: keep the upsert for an Agent no snapshot has synchronised, ask once, and
 * install the jobs when the snapshot lands. */
test("an upsert for an unsynchronised Agent is kept, asked once, and installed by the snapshot", async () => {
  const { clock, asked, fired, scheduler } = harness();
  await scheduler.apply(sync("upsert", 3));
  await scheduler.apply(sync("upsert", 4));
  await scheduler.apply(sync("upsert", 5));
  expect(asked).toEqual(["agent-a"]);
  await clock.advance(10_000);
  await scheduler.awaitIdle();
  expect(fired).toEqual([]);

  await scheduler.apply(snapshot([]));
  await clock.advance(0);
  await scheduler.awaitIdle();
  expect(fired).toEqual([reminderId]);
  expect(asked).toEqual(["agent-a"]);
});

test("the kept upsert wins over an older snapshot and is still due immediately", async () => {
  const { clock, fired, scheduler } = harness();
  await scheduler.apply(sync("upsert", 6));
  await clock.advance(10_000);
  await scheduler.apply(snapshot([{ ...job, version: 5, title: "Stale" }]));
  await clock.advance(0);
  await scheduler.awaitIdle();
  expect(fired).toEqual([reminderId]);
});

test("a synchronised Agent's changes arm without asking again", async () => {
  const { asked, scheduler } = harness();
  await scheduler.apply(sync("upsert", 3));
  await scheduler.apply(snapshot([]));
  await scheduler.apply(sync("upsert", 4));
  expect(asked).toEqual(["agent-a"]);
});

test("a change for another daemon is dropped and logged with its Agent and reminder", async () => {
  const { asked, scheduler } = harness();
  const { records } = await captureDaemonLogs(async () => {
    await scheduler.apply({ ...sync("upsert", 3), workspaceId: "workspace-b" });
    await scheduler.apply({
      ...sync("upsert", 3),
      jobs: [{ ...job, ownerAgentId: "agent-b" }],
    });
  });
  const dropped = records.filter((record) => record.properties.event === "reminder.sync_dropped");
  expect(dropped).toHaveLength(2);
  expect(dropped[0]?.properties.agent_id).toBe("agent-a");
  expect(dropped[0]?.properties.reminder_id).toBe(reminderId);
  expect(dropped[1]?.properties.reminder_id).toBe(reminderId);
  expect(asked).toEqual([]);
});
