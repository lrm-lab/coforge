import { launchFailureActivity } from "#src/agent-runtime/launch-failure";
import { AgentProcessCleanupError } from "@lrm/coforge-anvil";
import { runtimeDisplayName } from "#src/daemon-runtime/session-invalidate-activity";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { agentActivityDrafts } from "./agent-activity-drafts";
import type { ActivityDraft } from "./agent-activity-publisher";

/** The failure text every deliberate teardown presents instead of a provider error. */
export const CLEANUP_UNCONFIRMED =
  "Agent process cleanup could not be confirmed. Replacement launch is blocked.";

/** A failure that is not one: the runtime was already being torn down, or the launch failed only
 * because cleanup did. Such a failure presents as `CLEANUP_UNCONFIRMED`, never a provider error. */
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
  if (unconfirmed) return { detail: CLEANUP_UNCONFIRMED };
  return launchFailureActivity(error, runtimeDisplayName(provider));
}

/**
 * Reachable only for a genuine local Stop failure (the process did not exit); a revoke failure
 * no longer reaches this path (see `#releaseAgentRuntime`).
 */
export function stopFailureMessage(unconfirmed: boolean): string {
  if (unconfirmed) return CLEANUP_UNCONFIRMED;
  return "Agent runtime could not be stopped.";
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
