import { expect, test } from "bun:test";
import type {
  ReminderFireRequest,
  ReminderFireResponse,
  ReminderJob,
  ReminderSync,
} from "@lrm/coforge-sdk/internal";
import { ReminderScheduler } from "#src/agent-reminder/reminder-scheduler";
import { ReminderSnapshotAsks } from "#src/daemon-runtime/reminder-snapshot-asks";
import { Clock, MemoryStore } from "./reminder-scheduler-fixtures";

const job = (reminderId: string, version: number, fireAt: string): ReminderJob => ({
  reminderId,
  ownerAgentId: "agent-a",
  version,
  title: `Reminder ${reminderId}`,
  target: "@frank",
  messageId: crypto.randomUUID(),
  fireAt,
});

const first = job("11111111-1111-4111-8111-111111111111", 1, "2026-09-08T12:00:01Z");
const second = job("22222222-2222-4222-8222-222222222222", 1, "2026-09-08T12:00:02Z");

const snapshot = (
  jobs: ReminderJob[],
  operation: "snapshot" | "upsert" = "snapshot",
): ReminderSync => ({
  protocolMajor: 1,
  requestId: crypto.randomUUID(),
  workspaceId: "workspace-a",
  computerId: "computer-a",
  agentId: "agent-a",
  operation,
  jobs,
  messageType: "coforge.rpc.v1.ReminderSync",
});

const until = async (ready: () => boolean) => {
  for (let waited = 0; waited < 200 && !ready(); waited++)
    await new Promise((resolve) => setTimeout(resolve, 1));
};

/** The bug this pins: `UnsyncedReminderChanges` used to hold the Agent until `take()`, so after one
 * ask that did not land, every later upsert for that Agent asked nothing and the snapshot that
 * would have installed them never came. One ask in flight must not silence the next upsert, and a
 * change kept while an ask is in flight must still arm when the snapshot lands. */
test("an upsert after a failed ask asks again, and both changes arm when the snapshot lands", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  const fired: string[] = [];
  const asked: string[] = [];
  const asks: Array<Promise<unknown>> = [];
  let scheduler: ReminderScheduler;
  const requester = new ReminderSnapshotAsks({
    requestReminderSnapshot: (agentId) => {
      asked.push(agentId);
      const asking = (async () => {
        if (asked.length === 1) throw new Error("the ask fell over");
        // The snapshot raced ahead of the local upserts: neither reminder is in it, so both can
        // only come from what the daemon kept.
        await scheduler.apply(snapshot([]));
        return "applied" as const;
      })();
      asks.push(
        asking.then(
          () => {},
          () => {},
        ),
      );
      return asking;
    },
  });
  scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request: ReminderFireRequest) => {
      fired.push(request.reminderId);
      return {
        ...request,
        result: "accepted",
        fired: true,
        catchup: false,
      } as ReminderFireResponse;
    },
    async () => true,
    clock,
    // The default randomness; the scheduler waits on the requester under test.
    undefined,
    (agentId) => requester.request(agentId, "unsynchronised_upsert"),
  );

  await scheduler.apply(snapshot([first], "upsert"));
  await until(() => asks.length === 1);
  await asks[0];
  await new Promise((resolve) => setTimeout(resolve, 0));

  await scheduler.apply(snapshot([second], "upsert"));
  expect(asked).toEqual(["agent-a", "agent-a"]);
  await asks[1];
  await clock.advance(2_000);
  await scheduler.awaitIdle();
  expect(fired).toEqual([first.reminderId, second.reminderId]);
});

test("a requester told the daemon is stopping never asks again", async () => {
  const asked: string[] = [];
  const requester = new ReminderSnapshotAsks({
    requestReminderSnapshot: async (agentId) => {
      asked.push(agentId);
      return "stopped";
    },
  });
  requester.request("agent-a", "unsynchronised_upsert");
  await until(() => asked.length === 1);
  requester.request("agent-a", "unsynchronised_upsert");
  requester.connected();
  requester.request("agent-a", "connection");
  requester.request("agent-b", "connection");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(asked).toEqual(["agent-a"]);
});
