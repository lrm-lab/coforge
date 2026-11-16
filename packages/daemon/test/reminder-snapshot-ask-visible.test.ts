import { expect, test } from "bun:test";
import {
  requestReminderSnapshot,
  type RuntimeAppInboxSyncPorts,
} from "#src/daemon-runtime/runtime-app-inbox-sync";
import { captureDaemonLogs } from "./log-capture";

const portsWith = (transport: unknown) =>
  ({
    transport: () => transport,
    env: () => ({ workspaceId: "workspace-1", computerId: "computer-1", protocolMajor: 1 }),
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
  const { records } = await captureDaemonLogs(async () => {
    await requestReminderSnapshot(
      portsWith({
        requestSnapshot: async () => {
          throw new Error("reminder snapshot is not authorized");
        },
      }),
      "agent-1",
    );
  });
  const warn = records.find((record) => record.properties.event === "reminder_snapshot:failed");
  expect(warn?.level).toBe("warning");
  expect(warn?.properties.agent_id).toBe("agent-1");
  expect(String(warn?.properties.error_code)).toBe("Error");
});
