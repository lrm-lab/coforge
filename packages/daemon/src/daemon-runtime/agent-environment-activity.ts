import {
  AGENT_ACTIVITY_DETAIL_KIND,
  launchUnsafeAgentEnvironmentNames,
} from "@lrm/coforge-sdk/internal";
import type { ActivityDraft } from "./agent-activity-publisher";
import { activityDraft } from "./activity-draft";

/**
 * The launch's Activity for the Agent environment variables it had to skip: one row naming every
 * variable the shared rule refuses. The daemon skips them at spawn rather than deleting them, so
 * the person still sees what is stored and can remove it; a launch with nothing to skip has no row.
 */
export function ignoredAgentEnvironmentActivity(
  scope: { workspaceId: string; agentId: string },
  environment: Readonly<Record<string, string>> | undefined,
): ActivityDraft | undefined {
  const names = environment ? launchUnsafeAgentEnvironmentNames(environment) : [];
  if (names.length === 0) return undefined;
  const listed = names.join(", ");
  const plural = names.length > 1;
  return activityDraft(
    scope.workspaceId,
    scope.agentId,
    AGENT_ACTIVITY_DETAIL_KIND.AGENT_ENVIRONMENT_IGNORED,
    "warning",
    `Skipped ${listed}: CoForge never passes ${plural ? "them" : "it"} to an Agent runtime.`,
    {
      entries: [
        {
          kind: "text",
          text:
            `The Agent's stored environment sets ${listed}, which would change how the runtime ` +
            `or its toolchain executes or where it looks for its own files. The Agent started ` +
            `without ${plural ? "them" : "it"}; remove ${plural ? "them" : "it"} in the Agent's ` +
            "environment settings.",
        },
      ],
    },
  );
}
