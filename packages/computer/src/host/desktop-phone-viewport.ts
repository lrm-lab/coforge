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
