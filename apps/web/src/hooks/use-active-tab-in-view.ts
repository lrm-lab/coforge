import { useEffect, type RefObject } from "react";

/**
 * Keeps the selected tab of a tab strip that scrolls sideways in view, as Raft's tab list does:
 * when the strip opens, when the selection changes or tabs arrive (a collection renders its tabs
 * after the first pass, so the selected one can appear later), and when the strip is resized. The
 * first reveal jumps; later ones glide unless the person asked for reduced motion. A vertical
 * wheel over the strip scrolls it sideways while it can still move that way, and otherwise
 * scrolls whatever is around it as usual. `tabs` holds the `role="tab"` elements; `strip` is the
 * element that scrolls them.
 */
export function useActiveTabInView(
  tabs: RefObject<HTMLElement | null>,
  strip: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const list = tabs.current;
    const scroller = strip.current;
    if (!list || !scroller) return;
    let revealed = false;
    const reveal = () => {
      const tab = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!tab) return;
      const glide = revealed;
      revealed = true;
      if (scroller.scrollWidth <= scroller.clientWidth) return;
      const inset = parseFloat(getComputedStyle(scroller).paddingLeft) || 0;
      const origin = scroller.getBoundingClientRect().left - scroller.scrollLeft;
      const box = tab.getBoundingClientRect();
      const start = box.left - origin - inset;
      const end = box.right - origin + inset - scroller.clientWidth;
      const left =
        start < scroller.scrollLeft ? start : end > scroller.scrollLeft ? end : undefined;
      if (left === undefined) return;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      scroller.scrollTo({ left, behavior: glide && !reduced ? "smooth" : "auto" });
    };
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const room = scroller.scrollWidth - scroller.clientWidth;
      const canMove = event.deltaY > 0 ? scroller.scrollLeft < room - 1 : scroller.scrollLeft > 1;
      if (!canMove) return;
      scroller.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    reveal();
    // After a change, React Aria brings the focused tab just inside the edge in the same commit;
    // revealing on the next frame moves it clear of the strip's padding instead of racing that.
    let frame = 0;
    const revealNextFrame = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reveal);
    };
    const changes = new MutationObserver(revealNextFrame);
    changes.observe(list, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected"],
    });
    // A ResizeObserver reports once as it starts; that size is the one just revealed for.
    let measured = false;
    const resizes = new ResizeObserver(() => {
      if (measured) revealNextFrame();
      measured = true;
    });
    resizes.observe(scroller);
    scroller.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      changes.disconnect();
      resizes.disconnect();
      scroller.removeEventListener("wheel", wheel);
    };
  }, [tabs, strip]);
}
