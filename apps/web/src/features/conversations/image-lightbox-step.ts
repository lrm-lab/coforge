/** The image a step of `delta` from `index` lands on, or undefined at either end (the lightbox
 * stops there rather than wrapping). */
export function lightboxStepTarget(index: number, delta: -1 | 1, count: number) {
  const next = index + delta;
  return next >= 0 && next < count ? next : undefined;
}
