import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Whether a scroll box has content past its start and end edges along `axis`, kept current as it
 * scrolls or as it or its content changes size. `observe` names the elements whose size moves the
 * edges (by default the box's children); `key` re-reads them when they change.
 */
export function useScrollEdges<T extends HTMLElement = HTMLDivElement>(
  axis: "x" | "y",
  { observe = ":scope > *", key }: { observe?: string; key?: string } = {},
) {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const measure = () => {
      const position = axis === "x" ? box.scrollLeft : box.scrollTop;
      const hidden =
        axis === "x" ? box.scrollWidth - box.clientWidth : box.scrollHeight - box.clientHeight;
      const start = position > 0;
      const end = position < hidden - 1;
      setEdges((current) =>
        current.start === start && current.end === end ? current : { start, end },
      );
    };
    box.addEventListener("scroll", measure, { passive: true });
    const resize = new ResizeObserver(measure);
    // Content a collection renders after this effect (a tab strip's tabs) is observed once it
    // appears, so its width moves the edges too.
    const watch = () => {
      resize.disconnect();
      resize.observe(box);
      for (const element of box.querySelectorAll(observe)) resize.observe(element);
      measure();
    };
    const added = new MutationObserver(watch);
    added.observe(box, { childList: true, subtree: true });
    watch();
    return () => {
      box.removeEventListener("scroll", measure);
      resize.disconnect();
      added.disconnect();
    };
  }, [axis, observe, key]);
  return { ref, ...edges };
}

export const TAB_BAR_END_FADE_WIDTH = "3.5rem";

const DEFAULT_EDGE_FADE_WIDTH = "1.25rem";

export function edgeFadeStyle(
  { start, end }: { start: boolean; end: boolean },
  width: string | { start?: string; end?: string } = DEFAULT_EDGE_FADE_WIDTH,
): CSSProperties | undefined {
  if (!start && !end) return undefined;
  const startWidth = typeof width === "string" ? width : (width.start ?? DEFAULT_EDGE_FADE_WIDTH);
  const endWidth = typeof width === "string" ? width : (width.end ?? DEFAULT_EDGE_FADE_WIDTH);
  const mask = `linear-gradient(to right, ${start ? `transparent, black ${startWidth}` : "black"}, ${
    end ? `black calc(100% - ${endWidth}), transparent` : "black"
  })`;
  return { maskImage: mask, WebkitMaskImage: mask };
}
