import { m } from "#src/paraglide/messages";
import { AgentOptionCard } from "./agent-option-card";

/** The runtime form's Fast mode choice, offered for the runtimes that apply a service tier. */
export function AgentFastModeField({
  isSelected,
  onChange,
}: {
  isSelected: boolean;
  onChange: (selected: boolean) => void;
}) {
  return (
    <AgentOptionCard
      label={m.agent_form_fast_mode()}
      hint={m.agent_form_fast_mode_help()}
      isSelected={isSelected}
      onChange={onChange}
    />
  );
}
