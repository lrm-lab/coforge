/**
 * Per-swatch state for `LabelColorSwatches` tooltips.
 *
 * A swatch radio's `<input>` is visually hidden, so `SwatchRadio` drives the surrounding
 * `<Tooltip>` via `TooltipTriggerStateContext` on label hover and keyboard focus. React Aria's
 * `useFocusVisible()` stays `true` across `pointermove`, so after `Escape` dismisses a
 * keyboard-focused swatch's tooltip, a subsequent hover-on / hover-off would otherwise see
 * `focused && keyboard` still true and leave the dismissed tooltip stuck open. Tracking
 * `dismissed` until both pointer hover and keyboard focus leave keeps the tooltip closed.
 */
export interface SwatchTooltipState {
  hovered: boolean;
  focused: boolean;
  keyboardFocus: boolean;
  dismissed: boolean;
}

export type SwatchTooltipEffect = "none" | "open-delayed" | "open-immediate" | "close";

export interface SwatchTooltipTransition {
  state: SwatchTooltipState;
  effect: SwatchTooltipEffect;
}

export function createSwatchTooltipState(): SwatchTooltipState {
  return { hovered: false, focused: false, keyboardFocus: false, dismissed: false };
}

export function swatchKeepsTooltip(state: SwatchTooltipState): boolean {
  return state.hovered || state.keyboardFocus;
}

export function onSwatchHoverChange(
  state: SwatchTooltipState,
  hovered: boolean,
): SwatchTooltipTransition {
  if (hovered) {
    const next: SwatchTooltipState = { ...state, hovered: true };
    if (next.dismissed) return { state: next, effect: "none" };
    return {
      state: next,
      effect: next.keyboardFocus ? "open-immediate" : "open-delayed",
    };
  }
  const nextBase: SwatchTooltipState = { ...state, hovered: false };
  if (swatchKeepsTooltip(nextBase)) {
    return { state: nextBase, effect: "none" };
  }
  return { state: { ...nextBase, dismissed: false }, effect: "close" };
}

export function onSwatchFocusChange(
  state: SwatchTooltipState,
  focused: boolean,
  options: { focusVisible: boolean; activeElementIsSelf: boolean },
): SwatchTooltipTransition {
  if (focused) {
    const keyboardFocus = options.focusVisible;
    const next: SwatchTooltipState = { ...state, focused: true, keyboardFocus };
    if (next.dismissed || !keyboardFocus) return { state: next, effect: "none" };
    return { state: next, effect: "open-immediate" };
  }
  const nextBase: SwatchTooltipState = { ...state, focused: false, keyboardFocus: false };
  if (nextBase.hovered) {
    return { state: nextBase, effect: "none" };
  }
  // Keep `dismissed` across a window blur (activeElement stays on this swatch) so refocusing the
  // tab does not reopen an already-dismissed tooltip; clear it when focus moved elsewhere.
  const next: SwatchTooltipState = options.activeElementIsSelf
    ? nextBase
    : { ...nextBase, dismissed: false };
  return { state: next, effect: "close" };
}

export function onSwatchFocusVisibleChange(
  state: SwatchTooltipState,
  focusVisible: boolean,
): SwatchTooltipTransition {
  if (focusVisible || !state.keyboardFocus) {
    return { state, effect: "none" };
  }
  const nextBase: SwatchTooltipState = { ...state, keyboardFocus: false };
  if (swatchKeepsTooltip(nextBase)) {
    return { state: nextBase, effect: "none" };
  }
  return { state: { ...nextBase, dismissed: false }, effect: "close" };
}

export function onSwatchTooltipOpenChange(
  state: SwatchTooltipState,
  open: boolean,
  options: { documentHasFocus: boolean },
): SwatchTooltipState {
  if (!open && options.documentHasFocus && swatchKeepsTooltip(state)) {
    return { ...state, dismissed: true };
  }
  return state;
}
