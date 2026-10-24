import { homedir } from "node:os";

import { cleanupComputerUpgradeJob } from "@lrm/coforge-daemon";

import { redactDiagnosticText } from "#src/errors";
import { resolveComputerStateDirectory } from "#src/paths";

import { runUpgradeOperation, type UpgradeRunnerOptions } from "./upgrade-runner";
import type { UpgradeOperation } from "./upgrade-operation";

export type RemoteUpgradeHooks = {
  now?: () => string;
  writeLog?: (line: string) => Promise<void> | void;
  runUpgrade?: (
    operation: UpgradeOperation,
    overrides: Partial<UpgradeRunnerOptions>,
  ) => Promise<unknown>;
  cleanup?: (requestId: string, stateDirectory: string) => Promise<void>;
};

/** Runs one server-triggered operation. The Daemon observes it only through its durable
 * receipt, so this entry point produces no terminal output and never relies on the parent process
 * remaining alive. Its launch log is best-effort evidence for failures that leave no receipt. */
export async function runRemoteUpgrade(
  operation: UpgradeOperation,
  hooks: RemoteUpgradeHooks = {},
): Promise<void> {
  const now = hooks.now ?? (() => new Date().toISOString());
  const writeLog = hooks.writeLog ?? (() => undefined);
  const output: string[] = [];
  let failure: unknown;
  await writeRemoteUpgradeLog(
    writeLog,
    `[${now()}] remote upgrade started (${operation.requestId})`,
  );
  try {
    await (hooks.runUpgrade ?? runUpgradeOperation)(operation, {
      writeStderr: (text) => output.push(text),
    });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (output.length > 0) {
      await writeRemoteUpgradeLog(
        writeLog,
        redactDiagnosticText(output.join("")).replace(/\s+$/, ""),
      );
    }
    if (failure instanceof Error) {
      await writeRemoteUpgradeLog(
        writeLog,
        `[${now()}] remote upgrade failed: ${redactDiagnosticText(failure.message)}`,
      );
    } else if (!failure) {
      await writeRemoteUpgradeLog(writeLog, `[${now()}] remote upgrade finished`);
    }
    // The job has no KeepAlive, so leaving it in place cannot make it respawn; this only clears
    // the now-idle `launchctl list` entry and its plist once the result file above is durable, so
    // a retried upgrade never collides with a stale label. Best-effort: `launchctl bootout`
    // targeting your own still-running job is unreliable on some macOS versions, and the
    // Coordinator's startup sweep is the backstop if this does not complete.
    const stateDirectory = resolveComputerStateDirectory({
      platform: process.platform,
      homeDirectory: homedir(),
      environment: Bun.env,
    });
    const cleanup =
      hooks.cleanup ??
      ((requestId: string, directory: string) =>
        cleanupComputerUpgradeJob(requestId, { stateDirectory: directory }));
    await cleanup(operation.requestId, stateDirectory).catch(() => {});
  }
}

async function writeRemoteUpgradeLog(
  writeLog: (line: string) => Promise<void> | void,
  line: string,
): Promise<void> {
  try {
    await writeLog(line);
  } catch {
    // Diagnostic logging must never change the installer transaction or its receipt semantics.
  }
}
