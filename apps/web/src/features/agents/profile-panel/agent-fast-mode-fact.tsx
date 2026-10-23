import {
  RUNTIME_PROVIDER_SUPPORTS_FAST_MODE,
  type AgentServiceTierObserved,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { m } from "#src/paraglide/messages";
import { FactRow } from "./agent-fact-row";

/** What the Cloud knows about a launch's Fast service tier: the runtime's own last reading, or
 * nothing yet. Display-only, like the context-window reading. */
export type AgentFastModeReading = {
  requested: boolean;
  observed: AgentServiceTierObserved;
  observedAtMs: number;
};

/**
 * The Agent's Fast service tier row, drawn as a plain-text `Mode` row, the way the reference Computer draws it:
 * the configured value, except that a launch which reported anything other than "on" reads
 * "Not applied" (the Activity feed carries the runtime's own reason).
 */
export function AgentFastModeFact({
  runtime,
  requested,
  reading,
}: {
  runtime: RuntimeProvider;
  requested: boolean;
  reading?: AgentFastModeReading | null;
}) {
  if (!RUNTIME_PROVIDER_SUPPORTS_FAST_MODE[runtime]) return null;
  return (
    <FactRow label={m.agent_form_mode()}>
      {requested
        ? reading && reading.observed !== "on"
          ? m.agent_form_fast_mode_not_applied()
          : m.agent_form_fast_mode()
        : m.agent_form_default_value()}
    </FactRow>
  );
}
