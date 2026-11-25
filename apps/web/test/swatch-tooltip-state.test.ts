import { expect, test } from "bun:test";
import {
  createSwatchTooltipState,
  onSwatchFocusChange,
  onSwatchFocusVisibleChange,
  onSwatchHoverChange,
  onSwatchTooltipOpenChange,
} from "#src/features/tasks/swatch-tooltip-state";

test("Escape on keyboard-focused swatch stays closed through hover-over and hover-off until focus leaves", () => {
  let state = createSwatchTooltipState();

  let step = onSwatchFocusChange(state, true, { focusVisible: true, activeElementIsSelf: true });
  state = step.state;
  expect(step.effect).toBe("open-immediate");

  // Escape closes tooltip while the swatch keeps keyboard focus.
  state = onSwatchTooltipOpenChange(state, false, { documentHasFocus: true });
  expect(state.dismissed).toBe(true);

  // Moving the pointer over the focused swatch and off again must not reopen or clear dismissed.
  step = onSwatchHoverChange(state, true);
  state = step.state;
  expect(step.effect).toBe("none");
  expect(state.dismissed).toBe(true);

  step = onSwatchHoverChange(state, false);
  state = step.state;
  expect(step.effect).toBe("none");
  expect(state.dismissed).toBe(true);

  // Moving focus to another swatch clears dismissed, so focusing back opens again.
  step = onSwatchFocusChange(state, false, { focusVisible: true, activeElementIsSelf: false });
  state = step.state;
  expect(step.effect).toBe("close");
  expect(state.dismissed).toBe(false);

  step = onSwatchFocusChange(state, true, { focusVisible: true, activeElementIsSelf: true });
  expect(step.effect).toBe("open-immediate");
});

test("window blur without prior Escape reopens on refocus, while prior Escape stays dismissed across window blur", () => {
  let state = createSwatchTooltipState();

  state = onSwatchFocusChange(state, true, { focusVisible: true, activeElementIsSelf: true }).state;
  // Window loses focus: activeElement stays on this input and documentHasFocus is false.
  let step = onSwatchFocusChange(state, false, { focusVisible: true, activeElementIsSelf: true });
  state = step.state;
  expect(step.effect).toBe("close");
  state = onSwatchTooltipOpenChange(state, false, { documentHasFocus: false });
  expect(state.dismissed).toBe(false);

  step = onSwatchFocusChange(state, true, { focusVisible: true, activeElementIsSelf: true });
  state = step.state;
  expect(step.effect).toBe("open-immediate");

  // Now dismiss via Escape, then simulate window blur/refocus (`browser("tab", "t1")`).
  state = onSwatchTooltipOpenChange(state, false, { documentHasFocus: true });
  expect(state.dismissed).toBe(true);

  step = onSwatchFocusChange(state, false, { focusVisible: true, activeElementIsSelf: true });
  state = step.state;
  expect(state.dismissed).toBe(true);

  step = onSwatchFocusChange(state, true, { focusVisible: true, activeElementIsSelf: true });
  expect(step.effect).toBe("none");
  expect(step.state.dismissed).toBe(true);
});

test("Escape on a hovered swatch stays closed until hover leaves and re-enters", () => {
  let state = createSwatchTooltipState();

  let step = onSwatchHoverChange(state, true);
  state = step.state;
  expect(step.effect).toBe("open-delayed");

  state = onSwatchTooltipOpenChange(state, false, { documentHasFocus: true });
  expect(state.dismissed).toBe(true);

  // Focusing by click while hovered does not reopen either.
  step = onSwatchFocusChange(state, true, { focusVisible: false, activeElementIsSelf: true });
  state = step.state;
  expect(step.effect).toBe("none");

  // Pointer leaving clears dismissed and closes.
  step = onSwatchHoverChange(state, false);
  state = step.state;
  expect(step.effect).toBe("close");
  expect(state.dismissed).toBe(false);

  // Hovering back reopens via shared tooltip warmup.
  step = onSwatchHoverChange(state, true);
  expect(step.effect).toBe("open-delayed");
});

test("keyboard focus dismissed by another tooltip opening stays closed until focus and hover leave", () => {
  let state = createSwatchTooltipState();

  state = onSwatchFocusChange(state, true, { focusVisible: true, activeElementIsSelf: true }).state;
  state = onSwatchTooltipOpenChange(state, false, { documentHasFocus: true });
  expect(state.dismissed).toBe(true);

  // Blur while hovered keeps dismissed until hover also leaves.
  let step = onSwatchHoverChange(state, true);
  state = step.state;
  step = onSwatchFocusChange(state, false, { focusVisible: true, activeElementIsSelf: false });
  state = step.state;
  expect(step.effect).toBe("none");
  expect(state.dismissed).toBe(true);

  step = onSwatchHoverChange(state, false);
  state = step.state;
  expect(step.effect).toBe("close");
  expect(state.dismissed).toBe(false);
});

test("pointer click focus never opens tooltip and closes cleanly on hover-off", () => {
  let state = createSwatchTooltipState();

  let step = onSwatchHoverChange(state, true);
  state = step.state;
  expect(step.effect).toBe("open-delayed");

  step = onSwatchFocusChange(state, true, { focusVisible: false, activeElementIsSelf: true });
  state = step.state;
  expect(step.effect).toBe("none");

  // Pressing the swatch closes an open tooltip on pointerdown.
  state = onSwatchTooltipOpenChange(state, false, { documentHasFocus: true });
  expect(state.dismissed).toBe(true);

  // Leaving hover clears dismissed and keeps tooltip closed even though input stays focused.
  step = onSwatchHoverChange(state, false);
  state = step.state;
  expect(step.effect).toBe("close");
  expect(state.dismissed).toBe(false);

  // Pressing Escape afterwards restores global keyboard modality without opening this pointer-focused swatch.
  step = onSwatchFocusVisibleChange(state, true);
  expect(step.effect).toBe("none");
});

test("switching to pointer modality drops keyboard focus and clears dismissed once pointer leaves", () => {
  let state = createSwatchTooltipState();

  state = onSwatchFocusChange(state, true, { focusVisible: true, activeElementIsSelf: true }).state;
  state = onSwatchTooltipOpenChange(state, false, { documentHasFocus: true });
  expect(state.dismissed).toBe(true);

  let step = onSwatchFocusVisibleChange(state, false);
  state = step.state;
  expect(step.effect).toBe("close");
  expect(state.keyboardFocus).toBe(false);
  expect(state.dismissed).toBe(false);

  // If hovered while switching to pointer modality, clearing happens once hover leaves.
  state = createSwatchTooltipState();
  state = onSwatchFocusChange(state, true, { focusVisible: true, activeElementIsSelf: true }).state;
  state = onSwatchHoverChange(state, true).state;
  state = onSwatchTooltipOpenChange(state, false, { documentHasFocus: true });
  step = onSwatchFocusVisibleChange(state, false);
  state = step.state;
  expect(step.effect).toBe("none");
  expect(state.keyboardFocus).toBe(false);
  expect(state.dismissed).toBe(true);

  step = onSwatchHoverChange(state, false);
  expect(step.effect).toBe("close");
  expect(step.state.dismissed).toBe(false);
});
