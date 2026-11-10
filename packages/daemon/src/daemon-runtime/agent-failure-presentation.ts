import { launchFailureActivity } from "#src/agent-runtime/launch-failure";
import { runtimeDisplayName } from "#src/daemon-runtime/session-invalidate-activity";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { agentActivityDrafts } from "./agent-activity-drafts";
import type { ActivityDraft } from "./agent-activity-publisher";

/** The error Activity for a launch that did not start: its typed reason rides `runtimeError`
 * (class `LauncherError`) beside the sentence that explains it. */
export function buildLaunchFailureActivity(
  agentId: string,
  provider: RuntimeProvider,
  error: unknown,
  drafts: ReturnType<typeof agentActivityDrafts>,
): ActivityDraft {
  const draft = launchFailureActivity(error, runtimeDisplayName(provider));
  return drafts.runtimeError(agentId, draft.detail, draft.runtimeError);
}
