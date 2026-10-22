import type { ReactNode } from "react";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { cx } from "#src/utils/cx";

/**
 * A yes/no choice in the Agent forms, drawn as the reference's option card: a bordered checkbox
 * whose description wraps inside the border, so a long hint never widens the dialog.
 */
export function AgentOptionCard({
  label,
  hint,
  isSelected,
  isDisabled,
  onChange,
}: {
  label: string;
  hint: ReactNode;
  isSelected: boolean;
  isDisabled?: boolean;
  onChange: (selected: boolean) => void;
}) {
  return (
    <Checkbox
      label={label}
      hint={hint}
      isSelected={isSelected}
      isDisabled={isDisabled}
      onChange={onChange}
      className={({ isSelected: selected, isDisabled: disabled }) =>
        cx(
          "min-w-0 cursor-pointer rounded-lg p-3 ring-1 ring-secondary ring-inset",
          selected && "ring-2 ring-brand",
          disabled && "cursor-not-allowed",
        )
      }
    />
  );
}
