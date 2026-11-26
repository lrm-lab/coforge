import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useFocusVisible } from "react-aria";
import {
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  TooltipTriggerStateContext,
} from "react-aria-components";

import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { TooltipGroup } from "#src/components/ui/tooltip-group";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { LABEL_DOT, LABEL_PALETTE, labelColorName } from "./label-colors";
import {
  createSwatchTooltipState,
  onSwatchFocusChange,
  onSwatchFocusVisibleChange,
  onSwatchHoverChange,
  onSwatchTooltipOpenChange,
  type SwatchTooltipEffect,
  type SwatchTooltipTransition,
} from "./swatch-tooltip-state";

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
  onPick?: (color: string) => void;
  isDisabled?: boolean;
}) {
  const desktop = useBreakpoint("md");
  return (
    <div
      onClickCapture={(event) => {
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
      <TooltipGroup>
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
      </TooltipGroup>
    </div>
  );
}

function Swatch({ color, desktop }: { color: string; desktop: boolean }) {
  const tooltipState = useRef(createSwatchTooltipState());
  const [dismissed, setDismissed] = useState(false);

  const commit = useCallback((transition: SwatchTooltipTransition): SwatchTooltipEffect => {
    tooltipState.current = transition.state;
    setDismissed(transition.state.dismissed);
    return transition.effect;
  }, []);

  const handleHover = useCallback(
    (hovered: boolean) => commit(onSwatchHoverChange(tooltipState.current, hovered)),
    [commit],
  );

  const handleFocus = useCallback(
    (focused: boolean, options: { focusVisible: boolean; activeElementIsSelf: boolean }) =>
      commit(onSwatchFocusChange(tooltipState.current, focused, options)),
    [commit],
  );

  const handlePointerModality = useCallback(
    () => commit(onSwatchFocusVisibleChange(tooltipState.current, false)),
    [commit],
  );

  return (
    <Tooltip
      title={labelColorName(color)}
      // Disable React Aria's own trigger while dismissed so window refocus cannot bypass our guard.
      isDisabled={dismissed}
      onOpenChange={(open) => {
        const next = onSwatchTooltipOpenChange(tooltipState.current, open, {
          documentHasFocus: document.hasFocus(),
        });
        tooltipState.current = next;
        setDismissed(next.dismissed);
      }}
    >
      <SwatchRadio
        color={color}
        desktop={desktop}
        onHover={handleHover}
        onFocus={handleFocus}
        onPointerModality={handlePointerModality}
      />
    </Tooltip>
  );
}

function runTooltipEffect(
  tooltip: React.ContextType<typeof TooltipTriggerStateContext>,
  effect: SwatchTooltipEffect,
) {
  if (effect === "open-immediate") tooltip?.open(true);
  else if (effect === "open-delayed") tooltip?.open(false);
  else if (effect === "close") tooltip?.close();
}

function SwatchRadio({
  color,
  desktop,
  onHover,
  onFocus,
  onPointerModality,
}: {
  color: string;
  desktop: boolean;
  onHover: (hovered: boolean) => SwatchTooltipEffect;
  onFocus: (
    focused: boolean,
    options: { focusVisible: boolean; activeElementIsSelf: boolean },
  ) => SwatchTooltipEffect;
  onPointerModality: () => SwatchTooltipEffect;
}) {
  const tooltip = useContext(TooltipTriggerStateContext);
  const { isFocusVisible: keyboard } = useFocusVisible();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!keyboard) runTooltipEffect(tooltip, onPointerModality());
  }, [keyboard, onPointerModality, tooltip]);

  return (
    <AriaRadio
      value={color}
      aria-label={labelColorName(color)}
      inputRef={inputRef}
      onHoverChange={(next) => runTooltipEffect(tooltip, onHover(next))}
      onFocusChange={(next) =>
        runTooltipEffect(
          tooltip,
          onFocus(next, {
            focusVisible: keyboard,
            activeElementIsSelf: document.activeElement === inputRef.current,
          }),
        )
      }
      className={({ isSelected, isFocusVisible: ringed }) =>
        cn(
          "relative flex cursor-pointer items-center justify-center rounded-full outline-hidden",
          desktop ? "size-7" : "size-10",
          "ring-offset-bg-primary",
          "[&>span:has(>input)]:overflow-clip!",
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
  );
}
