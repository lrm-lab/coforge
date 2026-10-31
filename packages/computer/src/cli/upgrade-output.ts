import { UPGRADE_ERROR_CODE } from "@lrm/coforge-sdk/internal";

import { UpgradeFailedError } from "#src/release/upgrade-receipt";

/*
 * Human output for `coforge-computer upgrade`, `install`, and their failure hints. The commands
 * are thin adapters in cli.ts; the wording lives here.
 */

/** Prints one line per Workspace binding an upgrade left stopped, so a caller who only
 * had a disabled binding does not mistake a healthy switch for a broken connection. */
export function reportStoppedWorkspaces(
  io: { stdout: (line: string) => void },
  result: { supervisorRunning?: boolean; runtimes?: { bindingId: string; running: boolean }[] },
): void {
  const runtimes = result.runtimes ?? [];
  if (!runtimes.length) return;
  if (result.supervisorRunning === false) {
    io.stdout(
      "Computer supervisor is not running; run 'coforge-computer start' to bring your Workspaces online.",
    );
    return;
  }
  for (const runtime of runtimes) {
    if (!runtime.running)
      io.stdout(
        `Workspace ${runtime.bindingId} was already stopped and stays stopped; run 'coforge-computer start' to bring it online.`,
      );
  }
}

/**
 * The next command a caller should run after `coforge-computer upgrade` itself fails - `runCli`'s
 * catch already prints the reason (an `UpdateError`'s `code: message`, an
 * `UpgradeFailedError`'s receipt `errorCode: message` or bare message, or a bare Error's
 * message); this only names what to run
 * next, and never changes what is thrown or its exit code.
 */
export function nextUpgradeCommandHint(error: unknown): string {
  if (error instanceof UpgradeFailedError) {
    if (error.result.restoredVersion)
      return "The previous version was restored. Check 'coforge-computer logs' for detail, then retry with 'coforge-computer upgrade'.";
    if (error.result.errorCode === UPGRADE_ERROR_CODE.ROLLBACK_FAILED)
      return "The upgrade did not finish. Run the same command again, then check 'coforge-computer status'.";
    return "Check 'coforge-computer status' and 'coforge-computer logs', then retry with 'coforge-computer upgrade'.";
  }
  return "Check 'coforge-computer status', then retry with 'coforge-computer upgrade'.";
}
