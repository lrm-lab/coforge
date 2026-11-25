export type TaskDetent = "half" | "full";

export type DetentResolution = TaskDetent | "dismiss";

export type DetentTransitionPhase = "enter" | "snap" | "exit";

export type DetentMetrics = {
  sheetHeight: number;
  halfY: number;
  closedY: number;
};

export type DetentPose = {
  sheetY: number;
  composerPin: number;
  openRatio: number;
  scrimOpacity: number;
};

export const DETENT_HALF_RATIO = 0.64;
export const DETENT_FULL_RATIO = 0.94;
export const DETENT_CLOSED_OVERSHOOT_PX = 28;
export const DETENT_EASE_CSS = "cubic-bezier(0.32, 0.72, 0, 1)";
export const DETENT_ENTER_MS = 460;
export const DETENT_EXIT_MS = 260;
export const DETENT_REDUCED_MS = 150;
export const DETENT_SCRIM_MAX_OPACITY = 0.36;
export const DETENT_FLICK_VELOCITY_PX_MS = 0.38;
export const DETENT_FAST_FLICK_VELOCITY_PX_MS = 0.95;

const DETENT_VELOCITY_EMA_ALPHA = 0.6;
const DETENT_RUBBER_BAND_EXPONENT = 0.72;
const DETENT_RUBBER_BAND_SCALE = 1.15;
const DETENT_HALF_DISMISS_RATIO = 0.16;
const DETENT_FULL_DISMISS_RATIO = 0.2;
const DETENT_FULL_FAST_FLICK_HALF_FRACTION = 0.6;
const DETENT_EXPAND_HALF_FRACTION = 0.48;
const DETENT_SCROLL_PROMOTE_THRESHOLD_PX = 8;

export function computeDetentMetrics(sheetHeight: number): DetentMetrics {
  if (!Number.isFinite(sheetHeight) || sheetHeight <= 0) {
    return { sheetHeight: 0, halfY: 0, closedY: 0 };
  }
  const halfY = Math.round(sheetHeight * (1 - DETENT_HALF_RATIO / DETENT_FULL_RATIO));
  const closedY = Math.round(sheetHeight + DETENT_CLOSED_OVERSHOOT_PX);
  return { sheetHeight, halfY, closedY };
}

export function detentTargetY(detent: TaskDetent, metrics: DetentMetrics): number {
  return detent === "full" ? 0 : metrics.halfY;
}

export function applyTopRubberBand(rawY: number): number {
  if (!Number.isFinite(rawY)) return 0;
  if (rawY >= 0) return rawY;
  const pull = -rawY;
  return -Math.min(pull, Math.pow(pull, DETENT_RUBBER_BAND_EXPONENT) * DETENT_RUBBER_BAND_SCALE);
}

export function computeDetentPose(yPx: number, metrics: DetentMetrics): DetentPose {
  const sheetY = Number.isFinite(yPx) ? yPx : 0;
  const openRatio =
    metrics.sheetHeight > 0
      ? Math.max(0, Math.min(1, 1 - Math.max(0, sheetY) / metrics.sheetHeight))
      : 0;
  const composerPin = Math.max(0, Math.min(sheetY, metrics.halfY));
  return {
    sheetY,
    composerPin,
    openRatio,
    scrimOpacity: DETENT_SCRIM_MAX_OPACITY * openRatio,
  };
}

export function updateDragVelocity(
  previousVelocity: number,
  deltaY: number,
  deltaTimeMs: number,
): number {
  const dt = Math.max(1, deltaTimeMs);
  const instantVelocity = deltaY / dt;
  return (
    previousVelocity * (1 - DETENT_VELOCITY_EMA_ALPHA) + instantVelocity * DETENT_VELOCITY_EMA_ALPHA
  );
}

export function resolveDetentRelease({
  startDetent,
  currentY,
  velocity,
  metrics,
  cancelled = false,
}: {
  startDetent: TaskDetent;
  currentY: number;
  velocity: number;
  metrics: DetentMetrics;
  cancelled?: boolean;
}): DetentResolution {
  if (cancelled) return startDetent;

  const flickDown = velocity > DETENT_FLICK_VELOCITY_PX_MS;
  const fastFlickDown = velocity > DETENT_FAST_FLICK_VELOCITY_PX_MS;
  const flickUp = velocity < -DETENT_FLICK_VELOCITY_PX_MS;

  if (
    startDetent === "half" &&
    (flickDown || currentY > metrics.halfY + metrics.sheetHeight * DETENT_HALF_DISMISS_RATIO)
  ) {
    return "dismiss";
  }

  if (
    startDetent === "full" &&
    (currentY > metrics.halfY + metrics.sheetHeight * DETENT_FULL_DISMISS_RATIO ||
      (fastFlickDown && currentY > metrics.halfY * DETENT_FULL_FAST_FLICK_HALF_FRACTION))
  ) {
    return "dismiss";
  }

  if (startDetent === "full" && flickDown) {
    return "half";
  }

  if (flickUp || currentY < metrics.halfY * DETENT_EXPAND_HALF_FRACTION) {
    return "full";
  }

  return "half";
}

export function shouldPromoteDetentOnScroll({
  detent,
  previousScrollTop,
  currentScrollTop,
}: {
  detent: TaskDetent;
  previousScrollTop: number;
  currentScrollTop: number;
}): boolean {
  return (
    detent === "half" &&
    currentScrollTop > previousScrollTop &&
    currentScrollTop >= DETENT_SCROLL_PROMOTE_THRESHOLD_PX
  );
}

export function parseTranslateY(transformValue: string): number {
  if (!transformValue || transformValue === "none") return 0;
  const matrix3dMatch = /^matrix3d\((.+)\)$/.exec(transformValue.trim());
  if (matrix3dMatch?.[1]) {
    const parts = matrix3dMatch[1].split(",").map((part) => Number.parseFloat(part.trim()));
    const ty = parts[13];
    return ty !== undefined && Number.isFinite(ty) ? ty : 0;
  }
  const matrixMatch = /^matrix\((.+)\)$/.exec(transformValue.trim());
  if (matrixMatch?.[1]) {
    const parts = matrixMatch[1].split(",").map((part) => Number.parseFloat(part.trim()));
    const ty = parts[5];
    return ty !== undefined && Number.isFinite(ty) ? ty : 0;
  }
  return 0;
}

export function resolveTransitionDurationMs(
  phase: DetentTransitionPhase,
  reducedMotion: boolean,
): number {
  if (reducedMotion) return DETENT_REDUCED_MS;
  return phase === "exit" ? DETENT_EXIT_MS : DETENT_ENTER_MS;
}
