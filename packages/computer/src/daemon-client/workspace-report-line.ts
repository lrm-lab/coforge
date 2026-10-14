import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import { terminalText } from "#src/terminal-output";

/**
 * The terminal line for one Workspace a `start` or `restart` left unsettled: still under way,
 * still connecting (with its latest failed attempt), or not connected (with why). `failed` marks
 * the one that did not connect, which the command then fails for. `name` is already safe to print.
 */
export function unsettledWorkspaceLine(
  operation: "start" | "restart",
  name: string,
  runtime: ManagedRuntimeIdentity,
): { line: string; failed: boolean } {
  if (runtime.lifecycleUnderWay) {
    const under = operation === "start" ? "still starting" : "still restarting";
    return {
      line: `  ${name}: ${under}. Run 'coforge-computer status' to follow it.`,
      failed: false,
    };
  }
  if (runtime.cloudConnection === "connecting") {
    const retrying = runtime.cloudConnectionError
      ? `, retrying after ${terminalText(runtime.cloudConnectionError)}`
      : "";
    return {
      line: `  ${name}: still connecting${retrying}. Run 'coforge-computer status' to follow it.`,
      failed: false,
    };
  }
  return {
    line: `  ${name}: not connected (${terminalText(runtime.cloudConnectionError ?? "unknown error")}).`,
    failed: true,
  };
}
