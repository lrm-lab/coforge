import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

type ParentChainNode = {
  parentElement: ParentChainNode | null;
};

type LeadIntersectionEntry = {
  isIntersecting: boolean;
  boundingClientRect: { bottom: number };
  rootBounds: { top: number } | null;
};

type ScrollableTarget = {
  scrollTo: (options: ScrollToOptions) => void;
};

const SCROLLABLE_OVERFLOW = /^(auto|scroll|overlay)$/;

export function findScrollContainer<T extends ParentChainNode>(
  element: T,
  boundary: T | null,
  getOverflowY: (node: T) => string,
): T | null {
  let node = element.parentElement as T | null;
  while (node && node !== boundary) {
    if (SCROLLABLE_OVERFLOW.test(getOverflowY(node))) return node;
    node = node.parentElement as T | null;
  }
  return null;
}

export function isLeadScrolledOut(entry: LeadIntersectionEntry, scrollTop: number): boolean {
  if (entry.isIntersecting || scrollTop <= 0) return false;
  return entry.rootBounds === null || entry.boundingClientRect.bottom <= entry.rootBounds.top;
}

export function scrollContainerToTop(container: ScrollableTarget, reducedMotion: boolean) {
  container.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
}

export function useTaskLeadScroll({
  boundaryRef,
  reducedMotion,
}: {
  boundaryRef: RefObject<HTMLElement | null>;
  reducedMotion: boolean;
}) {
  const [titleElement, setTitleElement] = useState<HTMLElement | null>(null);
  const [scrolledOut, setScrolledOut] = useState(false);
  const [canScrollToTop, setCanScrollToTop] = useState(false);
  const scrollerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!titleElement) {
      scrollerRef.current = null;
      setCanScrollToTop(false);
      setScrolledOut(false);
      return;
    }
    const scroller = findScrollContainer(
      titleElement,
      boundaryRef.current,
      (node) => getComputedStyle(node).overflowY,
    );
    scrollerRef.current = scroller;
    setCanScrollToTop(Boolean(scroller && scroller.scrollTop > 0));
    if (!scroller) {
      setScrolledOut(false);
      return;
    }
    const updateScrollPosition = () => setCanScrollToTop(scroller.scrollTop > 0);
    scroller.addEventListener("scroll", updateScrollPosition, { passive: true });
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              const entry = entries.at(-1);
              if (!entry) return;
              setScrolledOut(isLeadScrolledOut(entry, scroller.scrollTop));
            },
            { root: scroller },
          );
    observer?.observe(titleElement);
    return () => {
      observer?.disconnect();
      scroller.removeEventListener("scroll", updateScrollPosition);
    };
  }, [titleElement, boundaryRef]);

  const scrollToTop = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scrollContainerToTop(scroller, reducedMotion);
  }, [reducedMotion]);

  return { setTitleElement, scrolledOut, canScrollToTop, scrollToTop };
}
