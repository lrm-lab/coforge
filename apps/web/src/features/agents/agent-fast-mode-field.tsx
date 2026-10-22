import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

/**
 * The runtime form's Fast mode choice: an option card, as the reference's runtime dialog has it,
 * so the description wraps inside the border rather than widening the dialog.
 */
export function AgentFastModeField({
  isSelected,
  onChange,
}: {
  isSelected: boolean;
  onChange: (selected: boolean) => void;
}) {
  return (
    <Checkbox
      label={m.agent_form_fast_mode()}
      hint={m.agent_form_fast_mode_help()}
      isSelected={isSelected}
      onChange={onChange}
      className={({ isSelected: selected }) =>
        cx(
          "min-w-0 cursor-pointer rounded-lg p-3 ring-1 ring-secondary ring-inset",
          selected && "ring-2 ring-brand",
        )
      }
    />
  );
}
