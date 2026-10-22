import { getLogger } from "@logtape/logtape";
import { thrownMessage } from "@lrm/coforge-sdk/internal";
import { probeLoginShellPath, type LoginShellPathResult } from "#src/platform/login-shell-path";
import { writeLoginShellPath } from "#src/platform/login-shell-path-state";

export type LoginShellPathImport = {
  /** Settles when the probe finished and its result was recorded; never rejects. */
  done: Promise<void>;
  /** Abandons a probe still running (the Coordinator is shutting down) and resolves once its
   * process group is killed and its temp dir removed. */
  stop(): Promise<void>;
};

/**
 * Starts the one login-shell PATH import of this Coordinator process and returns at once, so
 * startup (and an operator `start` answering within its budget) never waits for the user's rc
 * files. The Coordinator calls it once; a rescan or restart of a Workspace does not.
 */
export function startLoginShellPathImport(
  stateDirectory: string,
  probe: (options: { signal: AbortSignal }) => Promise<LoginShellPathResult> = probeLoginShellPath,
): LoginShellPathImport {
  const logger = getLogger(["coforge", "daemon", "supervisor"]);
  const abort = new AbortController();
  const run = async () => {
    const result = await probe({ signal: abort.signal });
    if (!result.ok && result.reason === "aborted") return;
    await writeLoginShellPath(stateDirectory, result);
    if (result.ok)
      logger.info("Imported PATH from the login shell", {
        event: "login_shell_path:imported",
        shell: result.shell,
        entry_count: result.path.length,
        duration_ms: result.durationMs,
      });
    else
      logger[result.reason === "disabled" || result.reason === "skipped" ? "info" : "warn"](
        "Login shell PATH was not imported",
        {
          event: "login_shell_path:skipped",
          reason: result.reason,
          shell: result.shell,
          duration_ms: result.durationMs,
        },
      );
  };
  const done = run().catch(async (error) => {
    logger.warn("Login shell PATH import failed", {
      event: "login_shell_path:failed",
      error_message: thrownMessage(error),
    });
    // Never leave an earlier success standing after a probe that could not finish.
    await writeLoginShellPath(stateDirectory, {
      ok: false,
      reason: "internal_error",
      durationMs: 0,
    }).catch(() => {});
  });
  return {
    done,
    stop() {
      abort.abort();
      return done;
    },
  };
}
