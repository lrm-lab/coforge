import {
  CliError,
  loginError,
  redactDiagnosticText,
  safeErrorDetail,
  setupError,
} from "#src/errors";
import { UpgradeFailedError } from "#src/release/upgrade-receipt";
import { UpdateError } from "#src/updater";

/**
 * Reports a command failure that is not a Commander parse outcome. JSON keeps its existing
 * stable shape; human output follows the reference Computer's actionable three-line contract.
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
  // safeErrorDetail strips credential-shaped material out of the message.
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
        error: {
          code: failure.code,
          message: redactDiagnosticText(failure.message),
          hint: redactDiagnosticText(failure.hint),
        },
      }),
    );
  } else {
    const code = failure?.code ?? failureCode(error);
    const message = failure?.message ?? failureMessage(error);
    const hint = failure?.hint;
    io.stderr(formatHumanFailure(code, message, hint));
  }
}

/** Formats one stable, actionable human failure. Keep this independent of Commander so the same
 * contract can be reused by commands that report errors from application modules. */
export function formatHumanFailure(code: string, message: string, hint?: string): string {
  const safeMessage = redactDiagnosticText(message).replace(/\s+/g, " ").trim();
  const next = nextCommand(code, hint ?? message);
  return [
    `What happened (${code}): ${safeMessage}`,
    `Next: ${next}`,
    `State: ${stateGuarantee(code)}`,
  ].join("\n");
}

function failureCode(error: unknown): string {
  if (error instanceof UpdateError) return error.code;
  if (error instanceof UpgradeFailedError) return error.result.errorCode ?? "UPGRADE_FAILED";
  return "COMPUTER_FAILED";
}

function failureMessage(error: unknown): string {
  if (error instanceof UpdateError || error instanceof UpgradeFailedError) return error.message;
  return error instanceof Error ? error.message : "coforge-computer failed";
}

function nextCommand(code: string, text: string): string {
  const command = text.match(/`(coforge-computer\s+[^`]+)`/)?.[1];
  if (command) return command.replace(/[.!?]+$/, "");
  if (code.startsWith("UPGRADE_") || code.startsWith("UPDATE_")) return "coforge-computer upgrade";
  if (code.startsWith("AUTH_")) return "coforge-computer login";
  if (code.startsWith("SETUP_")) return "coforge-computer setup";
  if (code.startsWith("STATUS_")) return "coforge-computer status";
  if (code.startsWith("RESTART_")) return "coforge-computer restart";
  if (code === "CONCURRENT_OPERATION") return "coforge-computer status";
  if (code === "MUTATION_LOCK_COMPROMISED") return "coforge-computer doctor";
  return "coforge-computer doctor";
}

function stateGuarantee(code: string): string {
  if (code.startsWith("UPGRADE_") || code.startsWith("UPDATE_"))
    return "No completed upgrade was confirmed by this command.";
  if (code.startsWith("STATUS_") || code.startsWith("DOCTOR_"))
    return "This read-only command did not change local Computer state.";
  if (code === "CONCURRENT_OPERATION")
    return "This command did not start because another Computer operation is already running.";
  return "No local Computer state change was confirmed by this command.";
}
