import { expect, test } from "bun:test";
import { MachineSupervisor, type ManagedBinding } from "#src/supervisor/machine-supervisor";
import { captureDaemonLogs } from "./log-capture";

const NOW = 1_700_000_000_000;

/** A binding whose pending upgrade the next request finds settled as failed, with `errorCode`. */
function supervisorSettlingAsFailed(errorCode?: string) {
  let saved: ManagedBinding[] = [
    { workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true },
  ];
  return new MachineSupervisor(
    {
      load: async () => structuredClone(saved),
      save: async (next) => {
        saved = structuredClone(next);
      },
    },
    { start: async () => "a", stop: async () => {}, instance: async () => "a" },
    () => NOW,
    {},
    async () => ({
      status: "failed",
      error: "feed reset",
      ...(errorCode ? { errorCode } : {}),
      at: NOW,
    }),
  );
}

async function settledLog(errorCode?: string) {
  const supervisor = supervisorSettlingAsFailed(errorCode);
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3");
  const { records } = await captureDaemonLogs(() =>
    supervisor.recordUpgrade("a", "request-b", "1.2.4"),
  );
  return records.find((record) => record.properties.event === "upgrade:operation_settled");
}

test("a settled upgrade operation logs its terminal error code, so the machine's log names it", async () => {
  expect(await settledLog("UPDATE_DOWNLOAD_FAILED")).toMatchObject({
    properties: {
      request_id: "request-a",
      workspace_id: "a",
      status: "failed",
      error_code: "UPDATE_DOWNLOAD_FAILED",
    },
  });
});

test("a settled upgrade operation without a code logs no error code", async () => {
  const record = await settledLog();
  expect(record?.properties.status).toBe("failed");
  expect(record?.properties).not.toHaveProperty("error_code");
});
