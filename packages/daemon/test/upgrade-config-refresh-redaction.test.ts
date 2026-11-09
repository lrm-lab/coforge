import { expect, mock, test } from "bun:test";
import type { DaemonCommandRequest } from "@lrm/coforge-sdk/internal";
import { runWorkspaceLifecycleCommand } from "#src/supervisor/run-supervisor-workspace-lifecycle";
import { captureDaemonLogs } from "./log-capture";

/**
 * What the refresh failure it settled for says never reaches the log (task #706 follow-up): the
 * child's own words may carry a credential, so the warning stores the redactor's version of them.
 * This lives in its own file because the suite's own file is already at the size gate.
 */
const CREDENTIAL = "sk-live-secret-1234567890";

function deps(refresh: (workspaceId: string) => Promise<void>) {
  const pending = {
    requestId: "req",
    expectedVersion: "2",
    state: "pending" as const,
    requestedAt: 7,
  };
  const supervisor = {
    recordUpgrade: mock(async () => true),
    snapshot: mock(async () => [{ workspaceId: "broken", upgradeOperations: [pending] }]),
  };
  return {
    method: "daemon:upgrade",
    request: {
      workspaceId: "broken",
      requestId: "req",
      expectedVersion: "2",
    } as DaemonCommandRequest,
    supervisor: supervisor as never,
    workspaceDirectory: (id: string) => `/ws/${id}`,
    stateDirectory: "/state",
    refreshChildUpgradeConfig: mock(refresh),
    completeUpgrade: mock(async () => {}),
    watchPendingUpgrade: mock(async () => {}),
    launchComputerUpgrade: mock(async () => {}),
    makeSelfClient: () => ({
      detach: async () => ({ ok: true as const, value: "detached" as const }),
    }),
    view: async () => [],
    ownServerUrl: "http://server",
  };
}

test("a refresh failure's credential never reaches the upgrade log", async () => {
  const { result, records } = await captureDaemonLogs(async () => {
    // The child refuses with a message carrying something that must not be written down.
    return runWorkspaceLifecycleCommand(
      deps(async () => {
        throw new Error(`binding save failed with token=${CREDENTIAL} while writing the record`);
      }) as never,
    );
  });
  // The launch still happened: the redaction is what this test is about, not the failure path.
  expect(result).toBeUndefined();
  const failed = records.filter(
    (record) => record.properties.event === "upgrade:config_refresh_failed",
  );
  expect(failed).toHaveLength(1);
  expect(failed[0]!.properties).toMatchObject({
    request_id: "req",
    workspace_id: "broken",
  });
  // The record still says what failed, without the credential it was carrying.
  expect(String(failed[0]!.properties.error_message)).toContain("binding save failed");
  expect(JSON.stringify(records)).not.toContain(CREDENTIAL);
  // And the redactor bounds the length, so a wall of output cannot ride along either.
  expect(String(failed[0]!.properties.error_message).length).toBeLessThanOrEqual(512);
});
