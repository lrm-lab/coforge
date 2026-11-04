import { useState } from "react";
import { useFocusVisible } from "react-aria";
import { Radio as AriaRadio, RadioGroup as AriaRadioGroup } from "react-aria-components";

import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { LABEL_DOT, LABEL_PALETTE, labelColorName } from "./label-colors";

/**
 * The colors a label may take, as a grid of round swatches. A radio group, so the arrow keys move
 * the pick and a screen reader reads each swatch as "<name>, selected". Enter inside the group
 * calls `onSubmit` (a radio has no use for it); a phone gets larger swatches to touch.
 */
export function LabelColorSwatches({
  value,
  onChange,
  onSubmit,
  onPick,
  isDisabled,
}: {
  value: string;
  onChange: (color: string) => void;
  onSubmit?: () => void;
  /** A swatch clicked or tapped (not one the arrow keys moved to): for a menu that applies it. */
  onPick?: (color: string) => void;
  isDisabled?: boolean;
}) {
  const desktop = useBreakpoint("md");
  return (
    // The group takes no key or click handlers of its own, so a wrapper hears them.
    <div
      // Captured: a swatch's press handling stops its click from bubbling up.
      onClickCapture={(event) => {
        // A press lands on a swatch's label or dot (the label then clicks its input again, which
        // is not heard twice).
        if (!(event.target instanceof Element) || event.target instanceof HTMLInputElement) return;
        const input = event.target.closest("label")?.querySelector("input");
        if (input) onPick?.(input.value);
      }}
      onKeyDownCapture={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        onSubmit?.();
      }}
    >
      <AriaRadioGroup
        aria-label={m.tasks_label_color()}
        value={value}
        onChange={onChange}
        isDisabled={isDisabled}
        orientation="horizontal"
        className="grid grid-cols-5 justify-items-center gap-2"
      >
        {LABEL_PALETTE.map((color) => (
          <Swatch key={color} color={color} desktop={desktop} />
        ))}
      </AriaRadioGroup>
    </div>
  );
}

/**
 * One swatch. Its tooltip is opened by hand, from the swatch's hover and keyboard focus: a radio's
 * input is visually hidden, so the pointer never reaches the element the tooltip trigger listens on.
 */
function Swatch({ color, desktop }: { color: string; desktop: boolean }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const { isFocusVisible: keyboard } = useFocusVisible();
  return (
    <Tooltip title={labelColorName(color)} isOpen={hovered || (focused && keyboard)} delay={0}>
      <AriaRadio
        value={color}
        aria-label={labelColorName(color)}
        onHoverChange={setHovered}
        onFocusChange={setFocused}
        className={({ isSelected, isFocusVisible: ringed }) =>
          cn(
            "relative flex cursor-pointer items-center justify-center rounded-full outline-hidden",
            desktop ? "size-7" : "size-10",
            "ring-offset-bg-primary",
            isSelected && "ring-2 ring-text-primary ring-offset-2",
            ringed && "outline-2 outline-offset-4 outline-focus-ring",
          )
        }
      >
        <span
          aria-hidden="true"
          className={cn("rounded-full", desktop ? "size-3.5" : "size-5.5", LABEL_DOT[color])}
        />
      </AriaRadio>
    </Tooltip>
  );
}
