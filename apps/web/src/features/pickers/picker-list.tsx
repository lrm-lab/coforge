import type { ReactNode } from "react";
import { Checkbox as AriaCheckbox } from "react-aria-components";

import { CheckboxBase } from "#src/components/base/checkbox/checkbox";
import { cn } from "#src/lib/utils";

/**
 * One ticked row of an inline pick list, laid out as the entity picker's menu rows are: a face, the
 * name, something faint after it (an Agent's `@handle`, a "not joined" tag), the tick at the end.
 * React Aria's checkbox around the official box, so the row can hold an avatar: the official
 * `Checkbox` puts its label in a `<p>`, which cannot contain the avatar's `<div>`. The accessible
 * name is the label and addon unless `aria-label` says otherwise.
 */
export function PickerListRow({
  label,
  description,
  leading,
  addon,
  addonError,
  isSelected,
  isDisabled,
  onChange,
  className,
  "aria-label": ariaLabel,
}: {
  label: string;
  /** A second, quieter line under the name. */
  description?: string;
  /** The face, drawn 20px square. */
  leading?: ReactNode;
  addon?: string;
  /** The addon says what went wrong, in the error colour. */
  addonError?: boolean;
  isSelected: boolean;
  isDisabled?: boolean;
  onChange: (on: boolean) => void;
  /** Merged over the row's own classes: the inset of the list it sits in. */
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <li>
      <AriaCheckbox
        isSelected={isSelected}
        isDisabled={isDisabled}
        onChange={onChange}
        // The addon is part of the name: it tells a person from an Agent who shares their name.
        aria-label={ariaLabel ?? (addon ? `${label} ${addon}` : label)}
        // `relative` keeps React Aria's visually hidden input inside the row. Without it the input
        // is placed against the dialog, whose scroll area then grows past the list and scrolls the
        // whole dialog when a lower row is ticked (task #331).
        className={cn(
          "relative flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 outline-focus-ring hover:bg-primary_hover disabled:cursor-not-allowed",
          className,
        )}
      >
        {({ isSelected: on, isDisabled: disabled, isFocusVisible }) => (
          <>
            {leading && (
              <span className="flex size-5 shrink-0 items-center justify-center">{leading}</span>
            )}
            <span className="min-w-0 grow">
              <span
                className={cn(
                  "block truncate text-sm font-medium text-primary",
                  disabled && "text-tertiary",
                )}
              >
                {label}
              </span>
              {description && (
                <span className="block truncate text-xs text-tertiary">{description}</span>
              )}
            </span>
            {addon && (
              <span
                className={cn(
                  "ml-1 max-w-1/2 shrink-0 truncate text-xs font-medium text-quaternary",
                  addonError && "text-error-primary",
                )}
              >
                {addon}
              </span>
            )}
            <CheckboxBase isSelected={on} isDisabled={disabled} isFocusVisible={isFocusVisible} />
          </>
        )}
      </AriaCheckbox>
    </li>
  );
}
