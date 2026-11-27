import type { ReactNode } from "react";
import {
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  type RadioGroupProps as AriaRadioGroupProps,
  type RadioProps as AriaRadioProps,
} from "react-aria-components";

import { RadioButtonBase } from "#src/components/base/radio-buttons/radio-buttons";
import { cn } from "#src/lib/utils";

export function OptionCardGroup({
  className,
  children,
  ...props
}: Omit<AriaRadioGroupProps, "className" | "children"> & {
  className?: string;
  children: ReactNode;
}) {
  return (
    <AriaRadioGroup {...props} className={cn("flex flex-col gap-2", className)}>
      {children}
    </AriaRadioGroup>
  );
}

export function OptionCard({
  label,
  description,
  trailing,
  className,
  ...props
}: Omit<AriaRadioProps, "className" | "children"> & {
  label: ReactNode;
  description?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <AriaRadio
      {...props}
      className={({ isSelected, isDisabled, isFocusVisible }) =>
        cn(
          "relative flex min-h-11 w-full cursor-pointer gap-3 rounded-xl border px-3.5 py-3 text-start transition-colors duration-100 ease-out outline-focus-ring",
          description ? "items-start" : "items-center",
          isSelected
            ? "border-brand bg-brand-primary"
            : cn("border-secondary bg-primary", !isDisabled && "hover:bg-primary_hover"),
          isFocusVisible && "outline-2 outline-offset-2",
          isDisabled && "cursor-not-allowed opacity-50",
          className,
        )
      }
    >
      {({ isSelected, isDisabled }) => (
        <>
          <RadioButtonBase
            size="sm"
            isSelected={isSelected}
            isDisabled={isDisabled}
            className={cn(description && "mt-0.5", isDisabled && "opacity-100")}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="min-w-0 text-sm font-medium wrap-anywhere text-primary">{label}</span>
            {description ? (
              <span className="min-w-0 text-sm wrap-anywhere text-tertiary">{description}</span>
            ) : null}
          </span>
          {trailing ? <span className="shrink-0">{trailing}</span> : null}
        </>
      )}
    </AriaRadio>
  );
}
