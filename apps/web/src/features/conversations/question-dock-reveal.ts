/** Scrolls `box` by the least that shows `element` whole (clear of `margin`, such as a fade at its
 * edge), along one axis, and nothing else: `scrollIntoView` would also move every scrolling
 * ancestor, the stream among them, cutting short its own scroll that keeps the card in view. */
export function reveal(
  box: HTMLElement | null,
  element: Element | null | undefined,
  axis: "x" | "y",
  margin = 0,
) {
  if (!box || !element) return;
  const outer = box.getBoundingClientRect();
  const inner = element.getBoundingClientRect();
  const [low, high, boxLow, boxHigh] =
    axis === "x"
      ? [inner.left, inner.right, outer.left, outer.right]
      : [inner.top, inner.bottom, outer.top, outer.bottom];
  const by =
    low < boxLow + margin
      ? low - boxLow - margin
      : high > boxHigh - margin
        ? high - boxHigh + margin
        : 0;
  if (!by) return;
  if (axis === "x") box.scrollLeft += by;
  else box.scrollTop += by;
}
