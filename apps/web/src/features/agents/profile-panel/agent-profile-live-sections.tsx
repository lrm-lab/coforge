import type { ComponentProps } from "react";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import {
  useLiveAgentDisplay,
  useLiveAgentProfileMetrics,
} from "#src/features/agents/workspace-agents-realtime";
import { AgentActivityTab } from "./agent-activity-tab";
import { AgentProfileHeader } from "./agent-profile-header";
import { AgentProfileStatus } from "./agent-profile-status";
import { AgentProfileTab } from "./agent-profile-tab";

export function LiveAgentProfileHeader({
  fallbackDisplay,
  ...props
}: Omit<ComponentProps<typeof AgentProfileHeader>, "display"> & {
  fallbackDisplay?: AgentDisplaySnapshot;
}) {
  const display = useLiveAgentDisplay(props.agent.id) ?? fallbackDisplay;
  return <AgentProfileHeader {...props} display={display} />;
}

export function LiveAgentProfileStatus({
  fallbackDisplay,
  ...props
}: Omit<ComponentProps<typeof AgentProfileStatus>, "display"> & {
  fallbackDisplay?: AgentDisplaySnapshot;
}) {
  const display = useLiveAgentDisplay(props.agent.id) ?? fallbackDisplay;
  return <AgentProfileStatus {...props} display={display} />;
}

export function LiveAgentActivityTab({
  fallbackDisplay,
  ...props
}: Omit<ComponentProps<typeof AgentActivityTab>, "display"> & {
  fallbackDisplay?: AgentDisplaySnapshot;
}) {
  const display = useLiveAgentDisplay(props.agent.id) ?? fallbackDisplay;
  return <AgentActivityTab {...props} display={display} />;
}

export function LiveAgentProfileTab(
  props: Omit<ComponentProps<typeof AgentProfileTab>, "contextUsage" | "fastMode">,
) {
  const metrics = useLiveAgentProfileMetrics(props.profile.id, props.profile.display);
  return (
    <AgentProfileTab {...props} contextUsage={metrics.contextUsage} fastMode={metrics.fastMode} />
  );
}
