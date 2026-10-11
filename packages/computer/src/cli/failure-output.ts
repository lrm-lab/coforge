import { CliError, loginError, safeErrorDetail, setupError } from "#src/errors";
import { UpdateError } from "#src/updater";

/**
 * Reports a command failure that is not a Commander parse outcome. A `CliError`, or any failure
 * of `login` or `setup` (wrapped in their own error), prints its code, message and hint, as one
 * JSON result on stdout when `--json` was given. Any other `UpdateError` prints its code and
 * message, and anything else only its message.
 */
export function writeCliFailure(
  io: { stdout: (line: string) => void; stderr: (line: string) => void },
  error: unknown,
  selected: { json: boolean; login: boolean; setup: boolean },
): void {
  // The login branch carries the underlying cause. Without it every unmapped login failure - a
  // server with no device endpoint, a DNS failure, a malformed discovery document - collapses
  // into one indistinguishable "Login failed." under a fixed hint about server configuration
  // that is unrelated to most of them, leaving nothing to diagnose from.
  // safeErrorDetail strips anything token-shaped out of the message.
  const failure =
    error instanceof CliError
      ? error
      : selected.login
        ? loginError("AUTH_FAILED", `Login failed: ${safeErrorDetail(error)}`)
        : selected.setup
          ? setupError("SETUP_FAILED", "Workspace setup failed.", "computer-registration", error)
          : null;
  if (failure && selected.json) {
    io.stdout(
      JSON.stringify({
        ok: false,
        error: { code: failure.code, message: failure.message, hint: failure.hint },
      }),
    );
  } else if (failure) {
    io.stderr(`${failure.code}: ${failure.message}\nHint: ${failure.hint}`);
  } else if (error instanceof UpdateError) {
    io.stderr(`${error.code}: ${error.message}`);
  } else {
    io.stderr(error instanceof Error ? error.message : "coforge-computer failed");
  }
}
