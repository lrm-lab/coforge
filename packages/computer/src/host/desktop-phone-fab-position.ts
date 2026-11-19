/** Keep the phone desktop FAB inside the iframe viewport (fake landscape resizes it). */

export type PhoneFabPoint = { left: number; top: number };

/** Clamp a dragged or restored FAB into the current viewport. */
export function clampPhoneFabPosition(
  left: number,
  top: number,
  viewportWidth: number,
  viewportHeight: number,
  fabWidth: number,
  fabHeight: number,
): PhoneFabPoint {
  const maxLeft = Math.max(0, viewportWidth - fabWidth);
  const maxTop = Math.max(0, viewportHeight - fabHeight);
  return {
    left: Math.min(maxLeft, Math.max(0, left)),
    top: Math.min(maxTop, Math.max(0, top)),
  };
}

/** Bottom-right resting place for the current viewport, with the same margins as the CSS defaults. */
export function defaultPhoneFabPosition(
  viewportWidth: number,
  viewportHeight: number,
  fabWidth: number,
  fabHeight: number,
  marginRight = 14,
  marginBottom = 18,
): PhoneFabPoint {
  return clampPhoneFabPosition(
    viewportWidth - fabWidth - marginRight,
    viewportHeight - fabHeight - marginBottom,
    viewportWidth,
    viewportHeight,
    fabWidth,
    fabHeight,
  );
}
