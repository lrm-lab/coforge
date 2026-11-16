import { expect, test } from "bun:test";
import {
  requestReminderSnapshot,
  type RuntimeAppInboxSyncPorts,
} from "#src/daemon-runtime/runtime-app-inbox-sync";
import { captureDaemonLogs } from "./log-capture";

const portsWith = (transport: unknown, signal?: AbortSignal) =>
  ({
    transport: () => transport,
    env: () => ({ workspaceId: "workspace-1", computerId: "computer-1", protocolMajor: 1 }),
    signal,
  }) as unknown as RuntimeAppInboxSyncPorts;

/** 2026-11-16: an Agent's reminders never arrived and nothing said why — neither a connection that
 * cannot ask nor an ask that fails may end without a line. */
test("a connection that cannot ask for reminders says so", async () => {
  const { records } = await captureDaemonLogs(async () => {
    await requestReminderSnapshot(portsWith({}), "agent-1");
  });
  const warn = records.find(
    (record) => record.properties.event === "reminder_snapshot:unavailable",
  );
  expect(warn?.level).toBe("warning");
  expect(warn?.properties.agent_id).toBe("agent-1");
});

test("an ask the server refuses says so, with the error", async () => {
  // A failed ask is retried for as long as the daemon runs, so a test ends it the way the daemon
  // stops one: nothing more is asked, and the first line stays.
  const stop = new AbortController();
  let attempts = 0;
  const transport = {
    requestSnapshot: async () => {
      attempts++;
      if (attempts > 1) stop.abort();
      throw new Error("reminder snapshot is not authorized");
    },
  };
  const { records } = await captureDaemonLogs(async () => {
    await requestReminderSnapshot(portsWith(transport, stop.signal), "agent-1", {
      retryDelaysMs: [1],
    });
  });
  const warn = records.find((record) => record.properties.event === "reminder_snapshot:failed");
  expect(warn?.level).toBe("warning");
  expect(warn?.properties.agent_id).toBe("agent-1");
  expect(String(warn?.properties.error_code)).toBe("Error");
});
