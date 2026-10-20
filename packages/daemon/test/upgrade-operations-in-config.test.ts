import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { UPGRADE_ERROR_CODE } from "@lrm/coforge-sdk/internal";
import { upgradeOperationsInConfig } from "#src/daemon-runtime/upgrade-result-reporter";
import { DaemonConfigStore } from "#src/persistence/daemon-config";
import { workspaceDaemonConfig } from "#src/supervisor/workspace-daemon-config";

const directories: string[] = [];
afterAll(() =>
  Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))),
);

describe("upgradeOperationsInConfig", () => {
  test("keeps terminal operations with their error code, ignores acknowledged ones, and notes a pending one", () => {
    const config = {
      upgradeOperations: [
        {
          requestId: "known-code",
          state: "failed",
          terminal: {
            error: "download failed",
            errorCode: UPGRADE_ERROR_CODE.UPDATE_INTEGRITY_FAILED,
            at: 5_000,
          },
        },
        {
          requestId: "unknown-code",
          state: "failed",
          terminal: { error: "new reason", errorCode: "UPGRADE_SOMETHING_NEW", at: 6_000 },
        },
        {
          requestId: "malformed-code",
          state: "failed",
          terminal: { error: "bad", errorCode: "not a code", at: 7_000 },
        },
        { requestId: "succeeded", state: "succeeded", terminal: { version: "2.0.0" } },
        { requestId: "pending", state: "pending" },
        {
          requestId: "acknowledged",
          state: "acknowledged",
          terminal: { error: "old", at: 1_000 },
        },
        { state: "failed", terminal: { at: 1_000 } },
      ],
    };
    expect(upgradeOperationsInConfig(config, () => 9_000)).toEqual({
      results: [
        {
          requestId: "known-code",
          status: "failed",
          completedAtMs: 5_000,
          error: "download failed",
          errorCode: UPGRADE_ERROR_CODE.UPDATE_INTEGRITY_FAILED,
        },
        {
          requestId: "unknown-code",
          status: "failed",
          completedAtMs: 6_000,
          error: "new reason",
          errorCode: "UPGRADE_SOMETHING_NEW",
        },
        { requestId: "malformed-code", status: "failed", completedAtMs: 7_000, error: "bad" },
        { requestId: "succeeded", status: "succeeded", completedAtMs: 9_000, version: "2.0.0" },
      ],
      pending: true,
    });
  });

  test("reads nothing from a config without upgrade operations", () => {
    expect(upgradeOperationsInConfig(null)).toEqual({ results: [], pending: false });
    expect(upgradeOperationsInConfig({ upgradeOperations: "nope" })).toEqual({
      results: [],
      pending: false,
    });
    expect(
      upgradeOperationsInConfig({
        upgradeOperations: [{ requestId: "done", state: "acknowledged" }],
      }),
    ).toEqual({ results: [], pending: false });
  });

  test("reads what the Coordinator writes into a Workspace's config file", async () => {
    // macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
    const directory = await mkdtemp(join(realpathSync(tmpdir()), "coforge-upgrade-config-"));
    directories.push(directory);
    const store = new DaemonConfigStore(directory);
    await store.save(
      workspaceDaemonConfig({
        workspaceId: "workspace-a",
        computerId: "computer-a",
        workspaceRoot: directory,
        enabled: true,
        upgradeOperations: [
          {
            requestId: "download-failed",
            expectedVersion: "2.0.0",
            state: "failed",
            requestedAt: 1_000,
            terminal: {
              error: "download failed",
              errorCode: UPGRADE_ERROR_CODE.UPDATE_INTEGRITY_FAILED,
              at: 2_000,
            },
          },
          { requestId: "next", expectedVersion: "2.0.1", state: "pending", requestedAt: 3_000 },
        ],
      }),
    );
    expect(upgradeOperationsInConfig(await store.load())).toEqual({
      results: [
        {
          requestId: "download-failed",
          status: "failed",
          completedAtMs: 2_000,
          error: "download failed",
          errorCode: UPGRADE_ERROR_CODE.UPDATE_INTEGRITY_FAILED,
        },
      ],
      pending: true,
    });
  });
});
