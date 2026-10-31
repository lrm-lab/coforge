import { useEffect, useRef, type RefObject } from "react";

/**
 * Calls `onReach` when `end` (the element after a list's last row) comes into view while
 * `waiting`, and again whenever `waiting` turns true with it still in view, so a list that does not
 * yet fill its viewport keeps reading. The caller stops waiting while a page is being read and once
 * one has failed, so a broken request is never repeated in a loop.
 */
export function useEndOfList(
  end: RefObject<HTMLElement | null>,
  waiting: boolean,
  onReach: () => void,
) {
  const reach = useRef(onReach);
  reach.current = onReach;
  useEffect(() => {
    const element = end.current;
    if (!element || !waiting) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) reach.current();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [end, waiting]);
}
