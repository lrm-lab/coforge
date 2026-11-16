import { expect, test } from "bun:test";
import type { LogRecord } from "@logtape/logtape";
import type { ReminderSync } from "@lrm/coforge-sdk/internal";
import {
  requestReminderSnapshot,
  type ReminderSnapshotGeneration,
  type ReminderSnapshotOutcome,
  type ReminderSnapshotReason,
  type RuntimeAppInboxSyncPorts,
} from "#src/daemon-runtime/runtime-app-inbox-sync";
import { ReminderSnapshotAsks } from "#src/daemon-runtime/reminder-snapshot-asks";
import { captureDaemonLogs } from "./log-capture";

const snapshotFor = (agentId: string): ReminderSync => ({
  protocolMajor: 1,
  requestId: "reminder-snapshot",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId,
  operation: "snapshot",
  jobs: [],
  messageType: "coforge.rpc.v1.ReminderSync",
});

const until = async (ready: () => boolean) => {
  for (let waited = 0; waited < 300 && !ready(); waited++)
    await new Promise((resolve) => setTimeout(resolve, 1));
};

const event = (records: readonly LogRecord[], name: string) =>
  records.filter((record) => record.properties.event === name);

/** A flapping connection used to leave the retry loop of the previous connection running: every
 * reconnect started another loop for the same Agent, and each of those kept an RPC and a timer of
 * its own. One reconnect, one loop: the old one ends silently and never asks again. */
test("a reconnect during a retry ends the old loop and asks that Agent once", async () => {
  const outcomes: ReminderSnapshotOutcome[] = [];
  const applied: string[] = [];
  let askAgain = false;
  let attempts = 0;
  let asking = 0;
  let mostAsking = 0;
  const transport = {
    requestSnapshot: async ({ agentId }: { agentId: string }) => {
      attempts++;
      asking++;
      mostAsking = Math.max(mostAsking, asking);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (!askAgain) throw new Error("connection reset");
        return snapshotFor(agentId);
      } finally {
        asking--;
      }
    },
  };
  const ports = {
    transport: () => transport,
    reminders: {
      apply: async (sync: ReminderSync) => {
        applied.push(sync.agentId);
      },
    },
    env: () => ({ workspaceId: "workspace-1", computerId: "computer-1", protocolMajor: 1 }),
  } as unknown as RuntimeAppInboxSyncPorts;
  const asking1 = new ReminderSnapshotAsks({
    requestReminderSnapshot: (
      agentId: string,
      reason: ReminderSnapshotReason,
      generation: ReminderSnapshotGeneration,
    ) =>
      requestReminderSnapshot(ports, agentId, {
        reason,
        generation,
        retryDelaysMs: [40, 40, 40, 40, 40],
      }).then((outcome) => {
        outcomes.push(outcome);
        return outcome;
      }),
  });

  const { records } = await captureDaemonLogs(async (logged) => {
    asking1.request("agent-a", "connection");
    await until(() => attempts === 1);
    // The first attempt has failed and its loop is inside the backoff: the connection flaps.
    await until(() => event(logged, "reminder_snapshot:failed").length === 1);
    askAgain = true;
    asking1.connected();
    asking1.request("agent-a", "connection");
    await until(() => applied.length === 1);
    // Long enough for the replaced loop's backoff to have elapsed had it survived.
    await new Promise((resolve) => setTimeout(resolve, 120));
  });

  expect(attempts).toBe(2);
  expect(applied).toEqual(["agent-a"]);
  expect([...outcomes].sort()).toEqual(["applied", "replaced"]);
  expect(mostAsking).toBe(1);
  // The replaced loop said why its first attempt failed and nothing after that.
  expect(event(records, "reminder_snapshot:failed")).toHaveLength(1);
  expect(event(records, "reminder_snapshot:recovered")).toHaveLength(0);
});
