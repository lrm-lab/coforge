import { describe, expect, test } from "bun:test";
import type { ManagedBinding, UpgradeOperation } from "#src/supervisor/machine-supervisor";
import { workspaceDaemonConfig } from "#src/supervisor/workspace-daemon-config";

const binding = (overrides: Partial<ManagedBinding> = {}): ManagedBinding => ({
  workspaceId: "w",
  computerId: "c",
  workspaceRoot: "/w",
  enabled: true,
  ...overrides,
});

const operation = (
  requestId: string,
  state: UpgradeOperation["state"],
  expectedVersion = `${requestId}-version`,
): UpgradeOperation => ({ requestId, expectedVersion, state, requestedAt: 1 });

describe("workspaceDaemonConfig", () => {
  test("keeps the daemon config and drops the Coordinator-only binding fields", () => {
    const config = workspaceDaemonConfig(
      binding({
        enabled: false,
        restart: { requestId: "r", phase: "stopping", previousInstanceId: null },
        restartResults: [],
        restartRequestIds: ["legacy-restart"],
        upgradeRequestIds: ["legacy-upgrade"],
        upgradeRequests: [{ requestId: "legacy", expectedVersion: "1.0.0" }],
        lastFailure: { operation: "start", message: "boom", at: 1 },
      }),
    );

    expect(config).toEqual({
      workspaceId: "w",
      computerId: "c",
      workspaceRoot: "/w",
      // A command failure is not removed: the child reads the binding's config as is.
      lastFailure: { operation: "start", message: "boom", at: 1 },
      restartRequestIds: [],
      upgradeRequestIds: [],
      upgradeExpectedVersions: {},
      upgradeOperations: [],
    });
  });

  test("hints completed restarts and the one now starting, never a cancelled or stopping one", () => {
    const results: ManagedBinding["restartResults"] = [
      { requestId: "done", status: "completed", instanceId: "i" },
      { requestId: "cancelled", status: "cancelled", by: "stop" },
    ];
    expect(
      workspaceDaemonConfig(
        binding({
          restartResults: results,
          restart: { requestId: "starting", phase: "starting", previousInstanceId: "i" },
        }),
      ).restartRequestIds,
    ).toEqual(["done", "starting"]);
    expect(
      workspaceDaemonConfig(
        binding({
          restartResults: results,
          restart: { requestId: "stopping", phase: "stopping", previousInstanceId: "i" },
        }),
      ).restartRequestIds,
    ).toEqual(["done"]);
  });

  test("passes on every upgrade operation the server has not acknowledged, with its version", () => {
    const pending = operation("pending", "pending", "2.0.0");
    const failed = operation("failed", "failed", "2.0.1");
    const config = workspaceDaemonConfig(
      binding({ upgradeOperations: [operation("acked", "acknowledged"), pending, failed] }),
    );

    expect(config.upgradeOperations).toEqual([pending, failed]);
    expect(config.upgradeRequestIds).toEqual(["pending", "failed"]);
    expect(config.upgradeExpectedVersions).toEqual({ pending: "2.0.0", failed: "2.0.1" });
  });

  test("keeps only the newest 128 restart hints and upgrade operations", () => {
    const ids = Array.from({ length: 130 }, (_, index) => `id-${index}`);
    const config = workspaceDaemonConfig(
      binding({
        restartResults: ids.map((requestId) => ({
          requestId,
          status: "completed" as const,
          instanceId: "i",
        })),
        upgradeOperations: ids.map((requestId) => operation(requestId, "succeeded")),
      }),
    );

    expect(config.restartRequestIds).toEqual(ids.slice(2));
    expect(config.upgradeRequestIds).toEqual(ids.slice(2));
    expect(config.upgradeOperations).toHaveLength(128);
    expect(Object.keys(config.upgradeExpectedVersions)).toEqual(ids.slice(2));
  });
});
