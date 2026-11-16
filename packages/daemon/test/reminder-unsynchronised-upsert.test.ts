import { expect, test } from "bun:test";
import { ReminderScheduler } from "#src/agent-reminder/reminder-scheduler";
import { change, Clock, job, MemoryStore, snapshot } from "./reminder-scheduler-fixtures";

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
    // The default randomness; the snapshot requester this test stands in for comes last.
    undefined,
    (agentId) => asked.push(agentId),
  );
  return { clock, asked, fired, scheduler };
};

/** Raft's requirement: keep the upsert for an Agent no snapshot has synchronised, ask for that
 * snapshot, and install the jobs when it lands. Every unsynchronised upsert asks: withholding an
 * ask is the requester's job (`ReminderSnapshotAsks`), not this bookkeeping's. */
test("an upsert for an unsynchronised Agent is kept, asked for, and installed by the snapshot", async () => {
  const { clock, asked, fired, scheduler } = harness();
  await scheduler.apply(change("upsert", 3));
  await scheduler.apply(change("upsert", 4));
  await scheduler.apply(change("upsert", 5));
  expect(asked).toEqual(["agent-a", "agent-a", "agent-a"]);
  await clock.advance(10_000);
  await scheduler.awaitIdle();
  expect(fired).toEqual([]);

  await scheduler.apply(snapshot([]));
  await clock.advance(0);
  await scheduler.awaitIdle();
  // Kept latest arrival per reminder: the three upserts install as one job, at its newest version.
  expect(fired).toEqual([job.reminderId]);
  expect(asked).toEqual(["agent-a", "agent-a", "agent-a"]);
});

test("the kept upsert wins over an older snapshot and is still due immediately", async () => {
  const { clock, fired, scheduler } = harness();
  await scheduler.apply(change("upsert", 6));
  await clock.advance(10_000);
  await scheduler.apply(snapshot([{ ...job, version: 5, title: "Stale" }]));
  await clock.advance(0);
  await scheduler.awaitIdle();
  expect(fired).toEqual([job.reminderId]);
});

test("a synchronised Agent's changes arm without asking again", async () => {
  const { asked, scheduler } = harness();
  await scheduler.apply(change("upsert", 3));
  await scheduler.apply(snapshot([]));
  await scheduler.apply(change("upsert", 4));
  expect(asked).toEqual(["agent-a"]);
});

test("a change for another daemon is refused and asks for nothing", async () => {
  const { asked, scheduler } = harness();
  await expect(
    scheduler.apply({ ...change("upsert", 3), workspaceId: "workspace-b" }),
  ).rejects.toThrow("reminder sync targets another daemon");
  await expect(
    scheduler.apply({ ...change("upsert", 3), jobs: [{ ...job, ownerAgentId: "agent-b" }] }),
  ).rejects.toThrow("reminder sync targets another daemon");
  expect(asked).toEqual([]);
});
