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
    measure();
    box.addEventListener("scroll", measure, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(box);
    for (const element of box.querySelectorAll(observe)) resize.observe(element);
    return () => {
      box.removeEventListener("scroll", measure);
      resize.disconnect();
    };
  }, [axis, observe, key]);
  return { ref, ...edges };
}

/** A mask fading a horizontal scroller's edges past which content is scrolled out of view. */
export function edgeFadeStyle({
  start,
  end,
}: {
  start: boolean;
  end: boolean;
}): CSSProperties | undefined {
  if (!start && !end) return undefined;
  const mask = `linear-gradient(to right, ${start ? "transparent, black 2rem" : "black"}, ${
    end ? "black calc(100% - 2rem), transparent" : "black"
  })`;
  return { maskImage: mask, WebkitMaskImage: mask };
}
