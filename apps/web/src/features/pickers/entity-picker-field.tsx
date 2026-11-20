import { Button as AriaButton } from "react-aria-components";
import { ChevronDown } from "@untitledui/icons";

import { FIELD_STATES } from "#src/components/base/input/field-states";
import { HintText } from "#src/components/base/input/hint-text";
import { Label } from "#src/components/base/input/label";
import { cn } from "#src/lib/utils";
import { Face, PickerMenu, PickerSurface, type PickerSingleProps } from "./entity-picker";

/** A picker as a form field: its label, a box showing the chosen row's face and name, and a hint. */
export function EntityPickerField({
  fieldLabel,
  hint,
  placeholder,
  isDisabled,
  ...menu
}: PickerSingleProps & {
  /** The field's visible label; `label` names the list. Absent where the form labels it. */
  fieldLabel?: string;
  hint?: string;
  placeholder?: string;
  isDisabled?: boolean;
}) {
  const chosen = menu.options?.find((option) => option.id === menu.selectedKey);
  return (
    <div className="flex flex-col gap-1.5">
      {fieldLabel && <Label>{fieldLabel}</Label>}
      <PickerSurface
        label={menu.label}
        placement="bottom start"
        className="w-(--trigger-width)"
        trigger={
          <AriaButton
            isDisabled={isDisabled}
            aria-label={chosen ? `${menu.label}: ${chosen.label}` : menu.label}
            className={({ isFocusVisible, isPressed, isDisabled }) =>
              cn(
                "flex h-10 w-full cursor-pointer items-center gap-2 px-3 text-left outline-hidden",
                FIELD_STATES.box,
                (isFocusVisible || isPressed) && FIELD_STATES.typing,
                isDisabled && FIELD_STATES.disabled,
              )
            }
          >
            {chosen?.face && <Face face={chosen.face} />}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-md",
                chosen ? "font-medium text-field-text" : "text-field-placeholder",
              )}
            >
              {chosen?.label ?? placeholder}
            </span>
            {chosen?.addon && (
              <span className="max-w-1/2 shrink-0 truncate text-sm text-quaternary">
                {chosen.addon}
              </span>
            )}
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 stroke-[2.25px] text-fg-quaternary"
            />
          </AriaButton>
        }
      >
        {({ phone, close }) => <PickerMenu {...menu} autoFocus={!phone} onClose={close} />}
      </PickerSurface>
      {hint && <HintText>{hint}</HintText>}
    </div>
  );
}
