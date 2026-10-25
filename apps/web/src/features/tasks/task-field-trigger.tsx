import type { ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";
import { Edit05 } from "@untitledui/icons";

/** A value that opens its menu when pressed; hover shows a light fill and a pencil. */
export function TaskFieldTrigger({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <AriaButton
      aria-label={label}
      isDisabled={disabled}
      className="group -mx-2 inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-primary outline-focus-ring transition-colors focus-visible:outline-2 enabled:hover:bg-primary_hover disabled:cursor-not-allowed"
    >
      {children}
      <Edit05
        aria-hidden="true"
        className="size-3.5 shrink-0 text-fg-quaternary opacity-0 transition-opacity group-focus-visible:opacity-100 group-enabled:group-hover:opacity-100"
      />
    </AriaButton>
  );
}
