import { describe, expect, it } from "bun:test";
import {
  SWIPE_CLICK_SUPPRESS_MS,
  armSwipeClickSuppression,
  clearSwipeClickSuppression,
  createSwipeClickSuppressorState,
  evaluateSwipeClickSuppression,
  shouldCompleteSwipeBack,
} from "./use-edge-swipe-back";

describe("shouldCompleteSwipeBack", () => {
  it("completes when dragged past the distance threshold", () => {
    expect(shouldCompleteSwipeBack(0.35, 0)).toBe(true);
    expect(shouldCompleteSwipeBack(0.2, 0.1)).toBe(false);
  });

  it("completes on fast release velocity even before the distance threshold", () => {
    expect(shouldCompleteSwipeBack(0.12, 0.6)).toBe(true);
  });
});

describe("evaluateSwipeClickSuppression", () => {
  it("does not suppress clicks when unarmed", () => {
    const initial = createSwipeClickSuppressorState();
    const res = evaluateSwipeClickSuppression(initial, { detail: 1, nowMs: 100 });
    expect(res.suppress).toBe(false);
    expect(res.nextState.armedUntil).toBeNull();
  });

  it("suppresses a single residual pointer click within the window and disarms afterward", () => {
    const armed = armSwipeClickSuppression(1000);
    expect(armed.armedUntil).toBe(1000 + SWIPE_CLICK_SUPPRESS_MS);

    const first = evaluateSwipeClickSuppression(armed, { detail: 1, nowMs: 1050 });
    expect(first.suppress).toBe(true);
    expect(first.nextState.armedUntil).toBeNull();

    const second = evaluateSwipeClickSuppression(first.nextState, { detail: 1, nowMs: 1060 });
    expect(second.suppress).toBe(false);
  });

  it("allows keyboard-triggered clicks (detail === 0) and clears suppression", () => {
    const armed = armSwipeClickSuppression(1000);
    const res = evaluateSwipeClickSuppression(armed, { detail: 0, nowMs: 1030 });
    expect(res.suppress).toBe(false);
    expect(res.nextState.armedUntil).toBeNull();
  });

  it("allows clicks after the suppression window expires", () => {
    const armed = armSwipeClickSuppression(1000);
    const res = evaluateSwipeClickSuppression(armed, {
      detail: 1,
      nowMs: 1000 + SWIPE_CLICK_SUPPRESS_MS + 1,
    });
    expect(res.suppress).toBe(false);
    expect(res.nextState.armedUntil).toBeNull();
  });

  it("allows clicks once explicitly cleared by a new pointerdown or keydown", () => {
    const cleared = clearSwipeClickSuppression();
    const res = evaluateSwipeClickSuppression(cleared, { detail: 1, nowMs: 1040 });
    expect(res.suppress).toBe(false);
  });
});
