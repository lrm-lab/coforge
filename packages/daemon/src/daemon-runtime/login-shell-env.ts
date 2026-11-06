import { getLogger } from "@logtape/logtape";
import { probeLoginShellPath } from "#src/platform/login-shell-path";
import { isLoginShellEnvAllowed } from "#src/platform/login-shell-env";

const logger = getLogger(["coforge", "daemon", "agent-runtime", "login-shell-env"]);

export type LoginShellEnvCapture = {
  /** Allowlisted variables the login shell had that this process did not. */
  imported: number;
  /** Allowlisted variables this process already had; its own value wins. */
  kept: number;
};

/**
 * Runs the same login-shell probe the Coordinator uses for PATH, then fills this Workspace
 * Daemon's own environment with the allowlisted variables the shell had (`login-shell-env.ts`).
 * Variables already set — CoForge's injected `COFORGE_*`, launchd/systemd defaults, anything the
 * spawn environment carried — always win, so the import can only add what the service manager
 * never had: provider credentials referenced as `$NAME` in configs like `~/.pi/agent/models.json`.
 *
 * The env lives only in this process's memory: agent sessions and catalog discovery inherit it
 * through `Bun.env`, and nothing writes it to disk. Best effort — a failed or empty probe leaves
 * the environment exactly as the service manager spawned it.
 */
export async function captureLoginShellEnvironment(
  options: { probe?: typeof probeLoginShellPath } = {},
): Promise<LoginShellEnvCapture | undefined> {
  const probe = options.probe ?? probeLoginShellPath;
  let result: Awaited<ReturnType<typeof probe>>;
  try {
    result = await probe();
  } catch {
    return undefined;
  }
  if (!result.ok) {
    if (result.reason !== "disabled" && result.reason !== "skipped" && result.reason !== "aborted")
      logger.info("Login shell environment was not imported", {
        event: "login_shell_env:skipped",
        reason: result.reason,
        shell: result.shell,
        duration_ms: result.durationMs,
      });
    return undefined;
  }
  let imported = 0;
  let kept = 0;
  for (const [name, value] of Object.entries(result.env ?? {})) {
    // Double guard: the probe already filtered, but a hand-built result must not smuggle a
    // CoForge-internal variable into the child environment either.
    if (!isLoginShellEnvAllowed(name)) continue;
    if (process.env[name] !== undefined) {
      kept += 1;
      continue;
    }
    process.env[name] = value;
    imported += 1;
  }
  logger.info("Imported environment from the login shell", {
    event: "login_shell_env:imported",
    shell: result.shell,
    imported,
    kept,
    duration_ms: result.durationMs,
  });
  return { imported, kept };
}
