import { expect, test } from "bun:test";

import {
  applyTopRubberBand,
  computeDetentMetrics,
  computeDetentPose,
  DETENT_EASE_CSS,
  DETENT_ENTER_MS,
  DETENT_EXIT_MS,
  DETENT_FLICK_VELOCITY_PX_MS,
  DETENT_FULL_RATIO,
  DETENT_HALF_RATIO,
  DETENT_REDUCED_MS,
  DETENT_SCRIM_MAX_OPACITY,
  detentTargetY,
  parseTranslateY,
  resolveDetentRelease,
  resolveTransitionDurationMs,
  shouldPromoteDetentOnScroll,
  updateDragVelocity,
} from "#src/features/tasks/task-detent-physics";

test("computeDetentMetrics maps 64% half-peek and 94% full height with closed overshoot", () => {
  const viewportHeight = 800;
  const sheetHeight = viewportHeight * DETENT_FULL_RATIO;
  const metrics = computeDetentMetrics(sheetHeight);

  expect(metrics.sheetHeight).toBe(sheetHeight);
  expect(sheetHeight - metrics.halfY).toBeCloseTo(viewportHeight * DETENT_HALF_RATIO, 0);
  expect(metrics.closedY).toBe(Math.round(sheetHeight + 28));
});

test("computeDetentMetrics guards against zero, negative, and non-finite heights", () => {
  expect(computeDetentMetrics(0)).toEqual({ sheetHeight: 0, halfY: 0, closedY: 0 });
  expect(computeDetentMetrics(-120)).toEqual({ sheetHeight: 0, halfY: 0, closedY: 0 });
  expect(computeDetentMetrics(Number.NaN)).toEqual({ sheetHeight: 0, halfY: 0, closedY: 0 });
  expect(computeDetentMetrics(Number.POSITIVE_INFINITY)).toEqual({
    sheetHeight: 0,
    halfY: 0,
    closedY: 0,
  });
});

test("detentTargetY maps full to 0 and half to halfY", () => {
  const metrics = computeDetentMetrics(740);
  expect(detentTargetY("full", metrics)).toBe(0);
  expect(detentTargetY("half", metrics)).toBe(metrics.halfY);
});

test("applyTopRubberBand tracks 1:1 downward and applies monotonic power-law damping upward", () => {
  expect(applyTopRubberBand(0)).toBe(0);
  expect(applyTopRubberBand(120)).toBe(120);
  expect(applyTopRubberBand(Number.NaN)).toBe(0);

  const tiny = applyTopRubberBand(-1);
  const small = applyTopRubberBand(-20);
  const medium = applyTopRubberBand(-100);
  const large = applyTopRubberBand(-300);

  expect(tiny).toBeLessThan(0);
  expect(Math.abs(tiny)).toBeLessThanOrEqual(1);
  expect(small).toBeLessThan(tiny);
  expect(medium).toBeLessThan(small);
  expect(large).toBeLessThan(medium);
  expect(Math.abs(small)).toBeLessThan(20);
  expect(Math.abs(medium)).toBeLessThan(100);
  expect(Math.abs(large)).toBeLessThan(300);
});

test("computeDetentPose pins composer between full and half and releases it past half", () => {
  const metrics = computeDetentMetrics(740);

  const fullPose = computeDetentPose(0, metrics);
  expect(fullPose.sheetY).toBe(0);
  expect(fullPose.composerPin).toBe(0);
  expect(fullPose.openRatio).toBe(1);
  expect(fullPose.scrimOpacity).toBeCloseTo(DETENT_SCRIM_MAX_OPACITY, 5);

  const midY = Math.round(metrics.halfY / 2);
  const midPose = computeDetentPose(midY, metrics);
  expect(midPose.composerPin).toBe(midY);
  expect(midPose.openRatio).toBeCloseTo(1 - midY / metrics.sheetHeight, 5);
  expect(midPose.scrimOpacity).toBeCloseTo(DETENT_SCRIM_MAX_OPACITY * midPose.openRatio, 5);

  const halfPose = computeDetentPose(metrics.halfY, metrics);
  expect(halfPose.composerPin).toBe(metrics.halfY);

  const dismissingY = metrics.halfY + 140;
  const dismissingPose = computeDetentPose(dismissingY, metrics);
  expect(dismissingPose.composerPin).toBe(metrics.halfY);
  expect(dismissingPose.openRatio).toBeLessThan(halfPose.openRatio);

  const closedPose = computeDetentPose(metrics.closedY, metrics);
  expect(closedPose.composerPin).toBe(metrics.halfY);
  expect(closedPose.openRatio).toBe(0);
  expect(closedPose.scrimOpacity).toBe(0);

  const rubberPose = computeDetentPose(-24, metrics);
  expect(rubberPose.composerPin).toBe(0);
  expect(rubberPose.openRatio).toBe(1);
  expect(rubberPose.scrimOpacity).toBeCloseTo(DETENT_SCRIM_MAX_OPACITY, 5);
});

test("updateDragVelocity smooths velocity and guards against zero elapsed time", () => {
  const v1 = updateDragVelocity(0, 20, 10);
  expect(v1).toBeCloseTo(1.2, 5);

  const v2 = updateDragVelocity(v1, -10, 10);
  expect(v2).toBeCloseTo(1.2 * 0.4 + -1 * 0.6, 5);

  const zeroDt = updateDragVelocity(0, 5, 0);
  expect(Number.isFinite(zeroDt)).toBe(true);
  expect(zeroDt).toBeCloseTo(3, 5);
});

test("resolveDetentRelease resolves flicks and distance thresholds from half detent", () => {
  const metrics = computeDetentMetrics(740);

  expect(
    resolveDetentRelease({
      startDetent: "half",
      currentY: metrics.halfY + 15,
      velocity: DETENT_FLICK_VELOCITY_PX_MS + 0.05,
      metrics,
    }),
  ).toBe("dismiss");

  expect(
    resolveDetentRelease({
      startDetent: "half",
      currentY: metrics.halfY + metrics.sheetHeight * 0.17,
      velocity: 0.05,
      metrics,
    }),
  ).toBe("dismiss");

  expect(
    resolveDetentRelease({
      startDetent: "half",
      currentY: metrics.halfY - 15,
      velocity: -(DETENT_FLICK_VELOCITY_PX_MS + 0.05),
      metrics,
    }),
  ).toBe("full");

  expect(
    resolveDetentRelease({
      startDetent: "half",
      currentY: metrics.halfY * 0.4,
      velocity: -0.05,
      metrics,
    }),
  ).toBe("full");

  expect(
    resolveDetentRelease({
      startDetent: "half",
      currentY: metrics.halfY + 30,
      velocity: 0.1,
      metrics,
    }),
  ).toBe("half");
});

test("resolveDetentRelease resolves flicks and distance thresholds from full detent", () => {
  const metrics = computeDetentMetrics(740);

  expect(
    resolveDetentRelease({
      startDetent: "full",
      currentY: 36,
      velocity: 0.55,
      metrics,
    }),
  ).toBe("half");

  expect(
    resolveDetentRelease({
      startDetent: "full",
      currentY: metrics.halfY * 0.7,
      velocity: 1.1,
      metrics,
    }),
  ).toBe("dismiss");

  expect(
    resolveDetentRelease({
      startDetent: "full",
      currentY: metrics.halfY * 0.3,
      velocity: 1.1,
      metrics,
    }),
  ).toBe("half");

  expect(
    resolveDetentRelease({
      startDetent: "full",
      currentY: metrics.halfY + metrics.sheetHeight * 0.22,
      velocity: 0.05,
      metrics,
    }),
  ).toBe("dismiss");

  expect(
    resolveDetentRelease({
      startDetent: "full",
      currentY: metrics.halfY * 0.6,
      velocity: 0.05,
      metrics,
    }),
  ).toBe("half");

  expect(
    resolveDetentRelease({
      startDetent: "full",
      currentY: 28,
      velocity: 0.05,
      metrics,
    }),
  ).toBe("full");

  expect(
    resolveDetentRelease({
      startDetent: "full",
      currentY: -22,
      velocity: -0.2,
      metrics,
    }),
  ).toBe("full");
});

test("resolveDetentRelease restores starting detent when gesture is cancelled", () => {
  const metrics = computeDetentMetrics(740);

  expect(
    resolveDetentRelease({
      startDetent: "half",
      currentY: metrics.closedY,
      velocity: 2,
      metrics,
      cancelled: true,
    }),
  ).toBe("half");

  expect(
    resolveDetentRelease({
      startDetent: "full",
      currentY: metrics.halfY + 200,
      velocity: 1.5,
      metrics,
      cancelled: true,
    }),
  ).toBe("full");
});

test("shouldPromoteDetentOnScroll promotes only on downward scroll past threshold while half", () => {
  expect(
    shouldPromoteDetentOnScroll({ detent: "half", previousScrollTop: 0, currentScrollTop: 14 }),
  ).toBe(true);
  expect(
    shouldPromoteDetentOnScroll({ detent: "half", previousScrollTop: 0, currentScrollTop: 4 }),
  ).toBe(false);
  expect(
    shouldPromoteDetentOnScroll({ detent: "half", previousScrollTop: 40, currentScrollTop: 20 }),
  ).toBe(false);
  expect(
    shouldPromoteDetentOnScroll({ detent: "full", previousScrollTop: 0, currentScrollTop: 80 }),
  ).toBe(false);
});

test("parseTranslateY extracts vertical offset from none, matrix, and matrix3d transforms", () => {
  expect(parseTranslateY("none")).toBe(0);
  expect(parseTranslateY("")).toBe(0);
  expect(parseTranslateY("matrix(1, 0, 0, 1, 0, 234.5)")).toBe(234.5);
  expect(parseTranslateY("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -18.25, 0, 1)")).toBe(
    -18.25,
  );
  expect(parseTranslateY("invalid")).toBe(0);
});

test("transition constants and reduced-motion durations match Vaul / iOS asymmetric timings", () => {
  expect(DETENT_EASE_CSS).toBe("cubic-bezier(0.32, 0.72, 0, 1)");
  expect(DETENT_ENTER_MS).toBe(460);
  expect(DETENT_EXIT_MS).toBe(260);
  expect(DETENT_REDUCED_MS).toBe(150);

  expect(resolveTransitionDurationMs("enter", false)).toBe(460);
  expect(resolveTransitionDurationMs("snap", false)).toBe(460);
  expect(resolveTransitionDurationMs("exit", false)).toBe(260);

  expect(resolveTransitionDurationMs("enter", true)).toBe(150);
  expect(resolveTransitionDurationMs("snap", true)).toBe(150);
  expect(resolveTransitionDurationMs("exit", true)).toBe(150);
});
