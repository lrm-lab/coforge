import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECOVERY_REPORT_MAX_BYTES } from "@lrm/coforge-sdk/internal/upgrade-receipt";
import { readRecoveryReport, recoveryReportPath } from "#src/platform/recovery-report-file";
import { resolveComputerInstallDirectory } from "#src/platform/computer-install-directory";

async function home() {
  return await mkdtemp(join(realpathSync(tmpdir()), "coforge-recovery-report-"));
}

function installRootOf(homeDirectory: string): string {
  return resolveComputerInstallDirectory({ platform: process.platform, homeDirectory });
}

const REQUEST = "0f8b6d5e-2a41-4c3b-9e7d-1a2b3c4d5e6f";

async function writeReport(homeDirectory: string, value: unknown) {
  const path = recoveryReportPath(installRootOf(homeDirectory));
  await Bun.write(path, typeof value === "string" ? value : JSON.stringify(value));
}

describe("readRecoveryReport", () => {
  test("a machine without a report resolves to undefined", async () => {
    const homeDirectory = await home();
    try {
      expect(await readRecoveryReport(installRootOf(homeDirectory))).toBeUndefined();
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  test("a recovered report parses with its request id and restored version", async () => {
    const homeDirectory = await home();
    try {
      await writeReport(homeDirectory, {
        schemaVersion: 1,
        requestId: REQUEST,
        outcome: "recovered",
        restoredVersion: "0.1.0",
        attempts: 3,
        finishedAt: 1_759_200_000,
      });
      expect(await readRecoveryReport(installRootOf(homeDirectory))).toEqual({
        schemaVersion: 1,
        requestId: REQUEST,
        outcome: "recovered",
        restoredVersion: "0.1.0",
        attempts: 3,
        finishedAt: 1_759_200_000,
      });
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  test("a failed report parses with its message; one without a request id parses too", async () => {
    const homeDirectory = await home();
    try {
      await writeReport(homeDirectory, {
        schemaVersion: 1,
        outcome: "failed",
        attempts: 8,
        finishedAt: 1_759_200_000,
        message: "0.1.0 could not be verified",
      });
      expect(await readRecoveryReport(installRootOf(homeDirectory))).toEqual({
        schemaVersion: 1,
        outcome: "failed",
        attempts: 8,
        finishedAt: 1_759_200_000,
        message: "0.1.0 could not be verified",
      });
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  test("an unreadable file - oversized, not JSON, or no known shape - throws", async () => {
    const homeDirectory = await home();
    try {
      const installRoot = installRootOf(homeDirectory);
      await writeReport(homeDirectory, "x".repeat(RECOVERY_REPORT_MAX_BYTES + 1));
      await expect(readRecoveryReport(installRoot)).rejects.toThrow("larger");
      await writeReport(homeDirectory, "{not json");
      await expect(readRecoveryReport(installRoot)).rejects.toThrow("not valid JSON");
      await writeReport(homeDirectory, { schemaVersion: 2, outcome: "recovered" });
      await expect(readRecoveryReport(installRoot)).rejects.toThrow("no known shape");
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });
});
