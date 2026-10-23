import { getLogger } from "@logtape/logtape";
import { thrownMessage } from "@lrm/coforge-sdk/internal";
import {
  probeLoginShellPath,
  type LoginShellPathFailureReason,
  type LoginShellPathResult,
} from "#src/platform/login-shell-path";
import { writeLoginShellPath } from "#src/platform/login-shell-path-state";

export type LoginShellPathImport = {
  /** Settles when the last attempt finished (success, a failure that is not worth retrying,
   * retries exhausted, or stopped); never rejects. With retries this can take minutes, so
   * startup must not await it. */
  done: Promise<void>;
  /** Abandons a probe still running or a pending retry wait (the Coordinator is shutting down)
   * and resolves once its process group is killed and its temp dir removed. */
  stop(): Promise<void>;
};

/** Waits before retry 1, 2, 3 of a transient probe failure: the machine is usually saturated
 * right after an upgrade restart, and the probe itself only takes about a second when idle. */
export const LOGIN_SHELL_PATH_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];

/** Failures that may pass on their own; every other reason would repeat. */
const TRANSIENT_REASONS: ReadonlySet<LoginShellPathFailureReason> = new Set([
  "timeout",
  "spawn_failed",
  "temp_dir_failed",
]);

export type LoginShellPathImportOptions = {
  probe?: (options: { signal: AbortSignal }) => Promise<LoginShellPathResult>;
  /** Delay before each retry; its length is the number of retries. */
  retryDelaysMs?: readonly number[];
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Starts the login-shell PATH import of this Coordinator process and returns at once, so
 * startup (and an operator `start` answering within its budget) never waits for the user's rc
 * files. The Coordinator calls it once; a rescan or restart of a Workspace does not. A probe
 * that timed out or could not be spawned (typically on a machine still saturated by a restart)
 * is retried after 30 s, 2 min and 10 min; each attempt's result is recorded, so a later
 * success replaces an earlier failure.
 */
export function startLoginShellPathImport(
  stateDirectory: string,
  options: LoginShellPathImportOptions = {},
): LoginShellPathImport {
  const {
    probe = probeLoginShellPath,
    retryDelaysMs = LOGIN_SHELL_PATH_RETRY_DELAYS_MS,
    sleep = abortableSleep,
  } = options;
  const logger = getLogger(["coforge", "daemon", "supervisor"]);
  const abort = new AbortController();
  const attemptOnce = async (attempt: number): Promise<LoginShellPathResult | undefined> => {
    const result = await probe({ signal: abort.signal });
    if (!result.ok && result.reason === "aborted") return undefined;
    await writeLoginShellPath(stateDirectory, result);
    if (result.ok)
      logger.info("Imported PATH from the login shell", {
        event: "login_shell_path:imported",
        shell: result.shell,
        entry_count: result.path.length,
        duration_ms: result.durationMs,
        attempt,
      });
    else
      logger[result.reason === "disabled" || result.reason === "skipped" ? "info" : "warn"](
        "Login shell PATH was not imported",
        {
          event: "login_shell_path:skipped",
          reason: result.reason,
          shell: result.shell,
          duration_ms: result.durationMs,
          attempt,
        },
      );
    return result;
  };
  const run = async () => {
    for (let attempt = 1; ; attempt++) {
      const result = await attemptOnce(attempt);
      if (!result || result.ok || !TRANSIENT_REASONS.has(result.reason)) return;
      const delayMs = retryDelaysMs[attempt - 1];
      if (delayMs === undefined) {
        logger.warn("Login shell PATH import gave up after its last retry", {
          event: "login_shell_path:gave_up",
          reason: result.reason,
          attempts: attempt,
        });
        return;
      }
      await sleep(delayMs, abort.signal);
      if (abort.signal.aborted) return;
    }
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
