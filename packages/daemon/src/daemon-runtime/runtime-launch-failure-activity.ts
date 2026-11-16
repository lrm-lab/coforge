import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { ActivityDraft } from "./agent-activity-publisher";
import { buildLaunchFailureActivity } from "./agent-failure-presentation";

export function launchFailureActivity(
  agentId: string,
  provider: RuntimeProvider,
  error: unknown,
  drafts: Parameters<typeof buildLaunchFailureActivity>[3],
): ActivityDraft {
  return buildLaunchFailureActivity(agentId, provider, error, drafts);
}
