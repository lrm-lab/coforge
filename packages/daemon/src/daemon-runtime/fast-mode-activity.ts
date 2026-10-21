import {
  AGENT_SERVICE_TIER_OBSERVED,
  type AgentServiceTierObserved,
} from "@lrm/coforge-sdk/internal";

/**
 * The one-line Activity for a launch that asked for Fast mode and did not get it. The runtime is
 * named generically: the readback is Claude Code's today, but the sentence is about the launch,
 * not the provider. `reason` is the runtime's own explanation when it gave one
 * (Claude Code's `fast_mode_disabled_reason`, such as `extra_usage_disabled`), left uninterpreted.
 */
export function fastModeUnavailableDetail(
  observed: AgentServiceTierObserved,
  reason?: string,
): string {
  const because = reason ? ` (${reason})` : "";
  if (observed === AGENT_SERVICE_TIER_OBSERVED.COOLDOWN)
    return `Fast mode was requested for this launch, but the runtime is cooling it down; this launch is running the ordinary tier${because}.`;
  if (observed === AGENT_SERVICE_TIER_OBSERVED.UNREPORTED)
    return `Fast mode was requested for this launch, but the runtime reported no service tier${because}.`;
  return `Fast mode was requested for this launch, but the runtime reports it is off${because}.`;
}
