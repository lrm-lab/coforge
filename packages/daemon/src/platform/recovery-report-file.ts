import { join } from "node:path";
import {
  InstallerRecoveryReportSchema,
  RECOVERY_REPORT_MAX_BYTES,
  type InstallerRecoveryReport,
} from "@lrm/coforge-sdk/internal/upgrade-receipt";

import { resolveComputerInstallDirectory } from "./computer-install-directory";

/**
 * The single reader of the installer's automatic-recovery report, `<install root>/
 * recovery-report.json`. The installer writes it once a recovery run ends - the machine
 * recovered, or it gave up - and keeps it until the next unfinished upgrade replaces it, so a
 * Daemon that was stopped while recovery ran reads it on its next start.
 */

/** `<install root>/recovery-report.json`. */
export function recoveryReportPath(installRoot = resolveComputerInstallDirectory()): string {
  return join(installRoot, "recovery-report.json");
}

/**
 * Reads the recovery report the installer left. Resolves to undefined while the file does not
 * exist. A file that exists but cannot be read as a report (over `RECOVERY_REPORT_MAX_BYTES`,
 * not JSON, or no known shape) throws, so each caller decides whether that is evidence.
 */
export async function readRecoveryReport(
  installRoot = resolveComputerInstallDirectory(),
): Promise<InstallerRecoveryReport | undefined> {
  const reportPath = recoveryReportPath(installRoot);
  const file = Bun.file(reportPath);
  if (!(await file.exists())) return undefined;
  if (file.size > RECOVERY_REPORT_MAX_BYTES)
    throw new Error(
      `recovery report is larger than ${RECOVERY_REPORT_MAX_BYTES} bytes: ${reportPath}`,
    );
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new Error(`recovery report is not valid JSON: ${reportPath}`);
  }
  const report = InstallerRecoveryReportSchema.safeParse(value);
  if (!report.success) throw new Error(`recovery report matches no known shape: ${reportPath}`);
  return report.data;
}
