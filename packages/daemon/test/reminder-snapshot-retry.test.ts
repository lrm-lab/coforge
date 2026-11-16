import { expect, test } from "bun:test";
import type { LogRecord } from "@logtape/logtape";
import type { ReminderSync } from "@lrm/coforge-sdk/internal";
import {
  requestReminderSnapshot,
  snapshotRetryDelayMs,
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

const portsWith = (
  transport: () => unknown,
  applied: string[],
  signal?: AbortSignal,
): RuntimeAppInboxSyncPorts =>
  ({
    transport,
    reminders: {
      apply: async (sync: ReminderSync) => {
        applied.push(sync.agentId);
      },
    },
    env: () => ({ workspaceId: "workspace-1", computerId: "computer-1", protocolMajor: 1 }),
    signal,
  }) as unknown as RuntimeAppInboxSyncPorts;

const event = (records: readonly LogRecord[], name: string) =>
  records.filter((record) => record.properties.event === name);

const until = async (ready: () => boolean) => {
  for (let waited = 0; waited < 200 && !ready(); waited++)
    await new Promise((resolve) => setTimeout(resolve, 1));
};

/** The outcome of `promise`, or what it is still doing after `ms`. */
const within = (promise: Promise<string>, ms = 500) =>
  Promise.race([
    promise,
    new Promise<string>((resolve) => setTimeout(() => resolve("still asking"), ms)),
  ]);

test("the retry schedule doubles from a second to five minutes and then stays there", () => {
  expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12].map(snapshotRetryDelayMs)).toEqual([
    1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000,
  ]);
});

/** Raft's requirement: a failed ask is retried instead of only logged, and the snapshot it finally
 * gets still installs. */
test("an ask that fails is retried and the snapshot it then gets is applied", async () => {
  const applied: string[] = [];
  let attempts = 0;
  const transport = {
    requestSnapshot: async ({ agentId }: { agentId: string }) => {
      attempts++;
      if (attempts === 1) throw new Error("connection reset");
      return snapshotFor(agentId);
    },
  };
  const { records } = await captureDaemonLogs(async () => {
    expect(
      await requestReminderSnapshot(
        portsWith(() => transport, applied),
        "agent-1",
        {
          retryDelaysMs: [1],
        },
      ),
    ).toBe("applied");
  });
  expect(attempts).toBe(2);
  expect(applied).toEqual(["agent-1"]);
  const failures = event(records, "reminder_snapshot:failed");
  expect(failures).toHaveLength(1);
  expect(failures[0]?.level).toBe("warning");
  expect(failures[0]?.properties.attempts).toBe(1);
  expect(String(failures[0]?.properties.error_code)).toBe("Error");
});

test("a success after failures is reported once, with how long it took", async () => {
  const applied: string[] = [];
  let now = 0;
  const transport = {
    requestSnapshot: async ({ agentId }: { agentId: string }) => {
      now += 1_500;
      if (now < 4_500) throw new Error("connection reset");
      return snapshotFor(agentId);
    },
  };
  const { records } = await captureDaemonLogs(async () => {
    await requestReminderSnapshot(
      portsWith(() => transport, applied),
      "agent-1",
      {
        retryDelaysMs: [0, 0, 0],
        now: () => now,
      },
    );
  });
  expect(applied).toEqual(["agent-1"]);
  const recovered = event(records, "reminder_snapshot:recovered");
  expect(recovered).toHaveLength(1);
  expect(recovered[0]?.level).toBe("info");
  expect(recovered[0]?.properties.attempts).toBe(3);
  expect(typeof recovered[0]?.properties.elapsed_ms).toBe("number");
});

test("an outage warns once an hour rather than once an attempt", async () => {
  const applied: string[] = [];
  const stop = new AbortController();
  let now = 0;
  let attempts = 0;
  const transport = {
    requestSnapshot: async () => {
      attempts++;
      if (attempts === 3) now += 60 * 60_000;
      if (attempts === 5) stop.abort();
      throw new Error("reminder snapshot is not authorized");
    },
  };
  const { records } = await captureDaemonLogs(async () => {
    const outcome = await requestReminderSnapshot(
      portsWith(() => transport, applied, stop.signal),
      "agent-1",
      {
        retryDelaysMs: [0, 0, 0, 0, 0],
        now: () => now,
      },
    );
    expect(outcome).toBe("stopped");
  });
  expect(attempts).toBe(5);
  const failures = event(records, "reminder_snapshot:failed");
  expect(failures.map((record) => record.properties.attempts)).toEqual([1, 3]);
  expect(failures.every((record) => record.level === "warning")).toBe(true);
});

test("a retry pending when the daemon stops asks and logs nothing more", async () => {
  const applied: string[] = [];
  const stop = new AbortController();
  let attempts = 0;
  const transport = {
    requestSnapshot: async () => {
      attempts++;
      throw new Error("connection reset");
    },
  };
  const { records } = await captureDaemonLogs(async (logged) => {
    const asking = requestReminderSnapshot(
      portsWith(() => transport, applied, stop.signal),
      "agent-1",
      {
        retryDelaysMs: [20, 20, 20, 20],
      },
    );
    await until(() => event(logged, "reminder_snapshot:failed").length === 1);
    stop.abort();
    expect(await within(asking)).toBe("stopped");
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  expect(attempts).toBe(1);
  expect(event(records, "reminder_snapshot:failed")).toHaveLength(1);
  expect(event(records, "reminder_snapshot:recovered")).toHaveLength(0);
});
