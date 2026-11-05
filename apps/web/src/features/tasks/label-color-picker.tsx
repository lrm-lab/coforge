import { useState } from "react";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
} from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";
import { LabelColorSwatches } from "./label-color-swatches";
import { LabelDot } from "./task-label-chip";

/**
 * A label's color as a dot that opens its swatches (Linear: "Edit label name or color by clicking
 * on those properties in a label row", https://linear.app/docs/labels). A click on a swatch, or
 * Enter or Space on the one the arrows moved to, picks it and closes; Escape closes unchanged.
 */
export function LabelColorPicker({
  color,
  name,
  onPick,
  isDisabled,
}: {
  color: string;
  /** The label's name, for the button's label ("Change color of Bug"). */
  name: string;
  onPick: (color: string) => void;
  isDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(color);
  const pick = (next: string) => {
    setOpen(false);
    onPick(next);
  };
  return (
    <AriaDialogTrigger
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setPicked(color);
      }}
    >
      <AriaButton
        aria-label={m.tasks_label_color_change({ name })}
        isDisabled={isDisabled}
        className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md outline-focus-ring hover:bg-primary_hover focus-visible:outline-2 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <LabelDot color={color} className="size-2.5" />
      </AriaButton>
      <Dropdown.Popover placement="bottom start" className="w-auto">
        <AriaDialog aria-label={m.tasks_label_color_change({ name })} className="outline-hidden">
          <div
            className="p-3"
            // Space on a swatch picks it, as Enter does: on the one already selected, a radio
            // hears nothing of it.
            onKeyDownCapture={(event) => {
              const onSwatch =
                event.target instanceof HTMLInputElement && event.target.type === "radio";
              if (event.key !== " " || !onSwatch) return;
              event.preventDefault();
              pick(picked);
            }}
          >
            <LabelColorSwatches
              value={picked}
              onChange={setPicked}
              onPick={pick}
              onSubmit={() => pick(picked)}
            />
          </div>
        </AriaDialog>
      </Dropdown.Popover>
    </AriaDialogTrigger>
  );
}
