import { TOOL_ALIASES } from "@lrm/coforge-sdk/internal";
import { isReplyIntentTarget } from "@lrm/coforge-sdk/internal/reply-intent";
import type { AgentRuntimeEvent } from "./contract";
import { flagValue, resolveCoforgeInvocation } from "./tool-activity";

/** Whether a provider's tool name is its shell tool, the one a command runs through. */
export function isShellToolName(name: string): boolean {
  return TOOL_ALIASES[name.toLowerCase()] === "bash";
}

/**
 * The `--target` of a `coforge message send` in a shell command, as the shell passes it: not the
 * activity row's sanitized copy. A help request, a send with no target and one whose target cannot
 * travel as a reply intent post nothing, so they have none. A `partial` command is still being
 * written: its last token, which may still grow (`--target @bo`), is never read.
 */
export function sendCommandTarget(
  command: string,
  completeness: "complete" | "partial",
): string | undefined {
  const invocation = resolveCoforgeInvocation(command, completeness === "partial");
  if (invocation?.tool !== "send_message") return undefined;
  if (invocation.args.some((arg) => arg === "--help" || arg === "-h")) return undefined;
  const target = flagValue(invocation.args, "--target");
  return target && isReplyIntentTarget(target) ? target : undefined;
}

/**
 * The target a finished tool call is sending a message to. A subagent's call is not the Agent's
 * own, so it has none.
 */
export function sendMessageTarget(
  event: Extract<AgentRuntimeEvent, { type: "tool-start" }>,
): string | undefined {
  if (event.subagent || !isShellToolName(event.name)) return undefined;
  const input = event.input;
  const command = input !== null && typeof input === "object" ? Reflect.get(input, "command") : "";
  return typeof command === "string" ? sendCommandTarget(command, "complete") : undefined;
}
