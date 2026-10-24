import { expect, test } from "bun:test";

import { runRemoteUpgrade, type RemoteUpgradeHooks } from "#src/release/remote-upgrade";
import type { UpgradeOperation } from "#src/release/upgrade-operation";

function operation(): UpgradeOperation {
  return {
    requestId: "0b7d2c9e-3a1f-4c8e-9d2b-5f6a7b8c9d0e",
    selection: "9.9.9",
    origin: "remote",
  };
}

test("remote upgrades keep a redacted per-request launch log", async () => {
  const log: string[] = [];
  const hooks: RemoteUpgradeHooks = {
    now: () => "2026-10-24T00:00:00.000Z",
    writeLog: (line) => {
      log.push(line);
    },
    runUpgrade: async (_operation, overrides) => {
      overrides.writeStderr?.(
        "==> downloading https://user:password@example.test/?access_token=secret\n",
      );
      throw new Error("installer failed: token=private");
    },
    cleanup: async () => undefined,
  };

  await expect(runRemoteUpgrade(operation(), hooks)).rejects.toThrow("installer failed");

  expect(log).toEqual([
    "[2026-10-24T00:00:00.000Z] remote upgrade started (0b7d2c9e-3a1f-4c8e-9d2b-5f6a7b8c9d0e)",
    "==> downloading https://%5BREDACTED_USER%5D:%5BREDACTED_PASSWORD%5D@example.test/?[REDACTED_QUERY]",
    "[2026-10-24T00:00:00.000Z] remote upgrade failed: installer failed: token=[redacted]",
  ]);
});

test("remote upgrade logs a successful completion", async () => {
  const log: string[] = [];
  const hooks: RemoteUpgradeHooks = {
    now: () => "2026-10-24T00:00:00.000Z",
    writeLog: (line) => {
      log.push(line);
    },
    runUpgrade: async () => undefined,
    cleanup: async () => undefined,
  };

  await runRemoteUpgrade(operation(), hooks);

  expect(log).toEqual([
    "[2026-10-24T00:00:00.000Z] remote upgrade started (0b7d2c9e-3a1f-4c8e-9d2b-5f6a7b8c9d0e)",
    "[2026-10-24T00:00:00.000Z] remote upgrade finished",
  ]);
});

test("a failing log sink does not affect cleanup", async () => {
  const cleanup: string[] = [];
  const hooks: RemoteUpgradeHooks = {
    writeLog: async () => {
      throw new Error("log sink unavailable");
    },
    runUpgrade: async () => undefined,
    cleanup: async (requestId, stateDirectory) => {
      cleanup.push(`${requestId}:${stateDirectory}`);
    },
  };

  await runRemoteUpgrade(operation(), hooks);

  expect(cleanup).toHaveLength(1);
  expect(cleanup[0]).toContain(operation().requestId);
});
