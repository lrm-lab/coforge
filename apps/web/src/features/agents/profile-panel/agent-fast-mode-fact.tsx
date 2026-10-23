import {
  RUNTIME_PROVIDER_SUPPORTS_FAST_MODE,
  type AgentServiceTierObserved,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { Badge } from "#src/components/base/badges/badges";
import { m } from "#src/paraglide/messages";
import { SUBFIELD_LABEL_CLASS } from "./inline-edit-field";

/** What the Cloud knows about a launch's Fast service tier: the runtime's own last reading, or
 * nothing yet. Display-only, like the context-window reading. */
export type AgentFastModeReading = {
  requested: boolean;
  observed: AgentServiceTierObserved;
  observedAtMs: number;
};

/**
 * The Agent's Fast service tier row, drawn the way the reference Computer draws its `Mode` row:
 * the configured value, except that a launch which reported anything other than "on" reads
 * "Not applied" (the Activity feed carries the runtime's own reason). Hidden while Fast is off —
 * a lone "Default" says nothing.
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
  if (!requested || !RUNTIME_PROVIDER_SUPPORTS_FAST_MODE[runtime]) return null;
  return (
    <div>
      <p className={SUBFIELD_LABEL_CLASS}>{m.agent_form_mode()}</p>
      <p className="mt-1">
        <Badge color="gray" size="md" className="gap-1.5 font-medium">
          {reading && reading.observed !== "on"
            ? m.agent_form_fast_mode_not_applied()
            : m.agent_form_fast_mode()}
        </Badge>
      </p>
    </div>
  );
}
