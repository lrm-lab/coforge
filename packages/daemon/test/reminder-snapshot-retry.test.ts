import { expect, test } from "bun:test";
import type { ReminderSync } from "@lrm/coforge-sdk/internal";
import {
  requestReminderSnapshot,
  type RuntimeAppInboxSyncPorts,
} from "#src/daemon-runtime/runtime-app-inbox-sync";
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

const portsWith = (transport: unknown, applied: string[]) =>
  ({
    transport: () => transport,
    reminders: {
      apply: async (sync: ReminderSync) => {
        applied.push(sync.agentId);
      },
    },
    env: () => ({ workspaceId: "workspace-1", computerId: "computer-1", protocolMajor: 1 }),
  }) as unknown as RuntimeAppInboxSyncPorts;

/** Raft's requirement: a failed ask is retried instead of only logged, and the snapshot it finally
 * gets still installs. */
test("an ask that fails is retried and the snapshot it then gets is applied", async () => {
  const applied: string[] = [];
  let attempts = 0;
  const { records } = await captureDaemonLogs(async () => {
    await requestReminderSnapshot(
      portsWith(
        {
          requestSnapshot: async ({ agentId }: { agentId: string }) => {
            attempts++;
            if (attempts === 1) throw new Error("connection reset");
            return snapshotFor(agentId);
          },
        },
        applied,
      ),
      "agent-1",
      { retryDelaysMs: [1] },
    );
  });
  expect(attempts).toBe(2);
  expect(applied).toEqual(["agent-1"]);
  const retrying = records.find((record) => record.properties.event === "reminder_snapshot:failed");
  expect(retrying?.level).toBe("warning");
  expect(retrying?.properties.attempt).toBe(1);
  expect(retrying?.properties.outcome).toBe("retrying");
});

test("an ask that never succeeds stops after the bounded attempts and says so", async () => {
  const applied: string[] = [];
  let attempts = 0;
  const { records } = await captureDaemonLogs(async () => {
    await requestReminderSnapshot(
      portsWith(
        {
          requestSnapshot: async () => {
            attempts++;
            throw new Error("reminder snapshot is not authorized");
          },
        },
        applied,
      ),
      "agent-1",
      { retryDelaysMs: [1, 1] },
    );
  });
  expect(attempts).toBe(3);
  expect(applied).toEqual([]);
  const failures = records.filter(
    (record) => record.properties.event === "reminder_snapshot:failed",
  );
  expect(failures.map((record) => record.properties.outcome)).toEqual([
    "retrying",
    "retrying",
    "failed",
  ]);
  expect(String(failures[2]?.properties.error_code)).toBe("Error");
});
