import { launchFailureActivity } from "#src/agent-runtime/launch-failure";
import { AgentProcessCleanupError, scrubRuntimeErrorText } from "@lrm/coforge-anvil";
import { refusalText } from "@lrm/coforge-sdk/internal";
import { runtimeDisplayName } from "#src/daemon-runtime/session-invalidate-activity";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { agentActivityDrafts } from "./agent-activity-drafts";
import type { ActivityDraft } from "./agent-activity-publisher";

/**
 * What a teardown that could not confirm exit says, on either path. It names the way out rather
 * than a dead end, because both are retryable: a Start clears the old tree before it launches
 * anything, and a Stop retries the teardown. The runtime's own words are appended when it had
 * any — a bare sentence leaves a person with nothing to act on (task #704, #705).
 */
export function unconfirmedMessage(error?: unknown): string {
  const detail =
    error instanceof AgentProcessCleanupError && error.detail
      ? `: ${scrubRuntimeErrorText(error.detail)}`
      : "";
  return `Agent runtime did not exit${detail}. Start again to clear it; stop to retry.`;
}

/** A failure that is not one: the runtime was already being torn down, or the launch failed only
 * because cleanup did. Such a failure presents as `unconfirmedMessage`, never a provider error. */
export function cleanupUnconfirmed(
  agentId: string,
  error: unknown,
  isStopping: (agentId: string) => boolean,
): boolean {
  return error instanceof AgentProcessCleanupError || isStopping(agentId);
}

/** What a launch failure's error Activity says: `detail` narrates, `runtimeError` rides the
 * typed launch reason (class `LauncherError`). */
export function launchFailureDraft(
  provider: RuntimeProvider,
  error: unknown,
  unconfirmed: boolean,
): { detail: string; runtimeError?: ReturnType<typeof launchFailureActivity>["runtimeError"] } {
  if (unconfirmed) return { detail: unconfirmedMessage(error) };
  return launchFailureActivity(error, runtimeDisplayName(provider));
}

/**
 * Reachable only for a genuine local Stop failure (the process did not exit); a revoke failure
 * no longer reaches this path (see `#releaseAgentRuntime`).
 */
export function stopFailureMessage(unconfirmed: boolean, error?: unknown): string {
  if (unconfirmed) return unconfirmedMessage(error);
  if (error === undefined) return "Agent runtime could not be stopped.";
  return `Agent runtime could not be stopped: ${scrubRuntimeErrorText(refusalText(error))}`;
}

/** The error Activity for a launch that did not start: its typed reason rides `runtimeError`
 * (class `LauncherError`) beside the sentence that explains it. */
export function buildLaunchFailureActivity(
  agentId: string,
  provider: Parameters<typeof launchFailureDraft>[0],
  error: unknown,
  drafts: ReturnType<typeof agentActivityDrafts>,
  unconfirmedCleanup: (agentId: string, error: unknown) => boolean,
): ActivityDraft {
  const draft = launchFailureDraft(provider, error, unconfirmedCleanup(agentId, error));
  return drafts.runtimeError(agentId, draft.detail, draft.runtimeError);
}
