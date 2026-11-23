import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installerRecoveryRequired } from "#src/platform/installer-recovery-observation";
import {
  readUpgradeReceipt,
  upgradeReceiptPath,
  upgradeResultsDirectory,
} from "#src/platform/upgrade-receipt-file";
import { installerJournalPath } from "#src/platform/installer-journal";
import { acquireProcessLock } from "#src/platform/process-lock";

const requestId = "0f8b6d5e-2a41-4c3b-9e7d-1a2b3c4d5e6f";

async function withInstallerFixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "coforge-installer-recovery-"));
  try {
    await mkdir(upgradeResultsDirectory(root));
    await Bun.write(
      installerJournalPath(root),
      JSON.stringify({
        schema_version: 1,
        request_id: requestId,
        from: "0.1.0",
        to: "0.2.0",
        supervisor_running: true,
      }),
    );
    await Bun.write(
      upgradeReceiptPath(root, requestId),
      Bun.file(
        join(import.meta.dir, "../../../crates/installer/contract/rust/receipt.unresolved.json"),
      ),
    );
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("only current readable native unresolved evidence recommends manual recovery", () =>
  withInstallerFixture(async (root) => {
    expect(await installerRecoveryRequired(root)).toBe(true);

    await rm(upgradeReceiptPath(root, requestId));
    const lock = acquireProcessLock(join(root, "machine-mutation-lock.sqlite"));
    try {
      expect(await installerRecoveryRequired(root)).toBe(false);
    } finally {
      lock.release();
    }
  }));

test("recovery that clears the journal while a previous unresolved receipt is read clears advice", () =>
  withInstallerFixture(async (root) => {
    const sample = await installerRecoveryRequired(root, async (installRoot, id) => {
      await rm(installerJournalPath(root));
      return readUpgradeReceipt(installRoot, id);
    });
    expect(sample).toBe(false);
    expect(await installerRecoveryRequired(root)).toBe(false);

    await mkdir(installerJournalPath(root));
    expect(await installerRecoveryRequired(root)).toBe(false);
  }));
