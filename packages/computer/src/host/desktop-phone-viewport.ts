/** Local phone viewport zoom for the cloud desktop (fit ≤ scale ≤ 1). */

export function phoneFitScale(
  containerWidth: number,
  containerHeight: number,
  frameWidth: number,
  frameHeight: number,
): number {
  if (containerWidth <= 0 || containerHeight <= 0 || frameWidth <= 0 || frameHeight <= 0) return 1;
  return Math.min(containerWidth / frameWidth, containerHeight / frameHeight, 1);
}

/** Clamp a zoom factor between fit-to-screen and native 1:1. */
export function clampPhoneScale(scale: number, fitScale: number, maxScale = 1): number {
  const min = Math.min(fitScale, maxScale);
  const max = Math.max(fitScale, maxScale);
  if (!Number.isFinite(scale)) return min;
  return Math.min(max, Math.max(min, scale));
}

/** Pinch: new scale from the scale and finger distance at pinch start. */
export function phoneScaleFromPinch(
  startScale: number,
  startDistance: number,
  distance: number,
  fitScale: number,
  maxScale = 1,
): number {
  if (!(startDistance > 0) || !(distance > 0)) {
    return clampPhoneScale(startScale, fitScale, maxScale);
  }
  return clampPhoneScale(startScale * (distance / startDistance), fitScale, maxScale);
}

/** True when the scaled frame is larger than the container in at least one axis. */
export function phoneViewportCanPan(scale: number, fitScale: number, epsilon = 0.02): boolean {
  return scale > fitScale + epsilon;
}

/**
 * noVNC clip viewport size in framebuffer pixels for a continuous CSS scale.
 * Always pair with clipViewport=true and display.scale = scale.
 */
export function phoneViewportSize(
  containerWidth: number,
  containerHeight: number,
  scale: number,
): { width: number; height: number } {
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  return {
    width: containerWidth / s,
    height: containerHeight / s,
  };
}

/**
 * Canvas-local CSS pixels for RFB._handleMouseButton / _sendMouse.
 * Do not pre-apply display.absX/absY — those run inside _sendMouse.
 */
export function phoneCanvasLocalPoint(
  clientX: number,
  clientY: number,
  canvasLeft: number,
  canvasTop: number,
): { x: number; y: number } {
  return { x: clientX - canvasLeft, y: clientY - canvasTop };
}

/** Finger travel that still counts as a tap (not a pan) when zoomed. */
export function phoneGestureIsTap(totalDx: number, totalDy: number, slop = 20): boolean {
  return Math.hypot(totalDx, totalDy) <= slop;
}
