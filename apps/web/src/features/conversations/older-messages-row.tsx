import { useEffect, useRef, type RefObject } from "react";
import { Button } from "#src/components/base/buttons/button";
import { Spinner } from "#src/components/ui/spinner";
import { m } from "#src/paraglide/messages";
import { TASK_TITLE_SCROLL_EVENT } from "./conversation-scroll-anchor";

/** Where paging older history stands: nothing in flight, a page being read, or the last read failed. */
export type OlderLoad = "idle" | "loading" | "failed";

/**
 * The row above the oldest loaded message while older history remains, and the sentinel that asks
 * for the next page when it comes into view. It keeps one height in every state: the scroll anchor
 * that holds the reader's place when a page lands assumes nothing above it moved. Loading is the
 * spinner alone, its words for screen readers; a failed read says so with a retry.
 */
export function OlderMessagesRow({
  rootRef,
  loadedCount,
  load,
  onLoad,
}: {
  /** The scrolling history the row sits at the top of. */
  rootRef: RefObject<HTMLElement | null>;
  /** How many messages are loaded; a change re-checks whether the row is still in view. */
  loadedCount: number;
  load: OlderLoad;
  onLoad: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const returnPosition = useRef<number | null>(null);
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;

  useEffect(() => {
    const row = ref.current;
    const root = rootRef.current;
    if (!row || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadRef.current();
      },
      { root, rootMargin: "600px 0px 0px 0px" },
    );
    const resumeOnUpwardScroll = () => {
      const previous = returnPosition.current;
      const top = root.scrollTop;
      if (previous !== null && top < previous) {
        returnPosition.current = null;
        root.removeEventListener("scroll", resumeOnUpwardScroll);
        observer.unobserve(row);
        observer.observe(row);
      } else {
        returnPosition.current = top;
      }
    };
    const returningToTitle = () => {
      returnPosition.current = 0;
      root.addEventListener("scroll", resumeOnUpwardScroll, { passive: true });
    };
    row.addEventListener(TASK_TITLE_SCROLL_EVENT, returningToTitle);
    observerRef.current = observer;
    observer.observe(row);
    return () => {
      row.removeEventListener(TASK_TITLE_SCROLL_EVENT, returningToTitle);
      root.removeEventListener("scroll", resumeOnUpwardScroll);
      returnPosition.current = null;
      observer.disconnect();
      observerRef.current = null;
    };
  }, [rootRef]);

  useEffect(() => {
    const root = rootRef.current;
    const row = ref.current;
    const observer = observerRef.current;
    if (!row || !root || !observer) return;
    if (returnPosition.current !== null) return;
    observer.unobserve(row);
    observer.observe(row);
  }, [rootRef, loadedCount]);

  return (
    <div
      ref={ref}
      data-scroll-older
      aria-live="polite"
      className="flex h-8 items-center justify-center gap-2 px-4 pt-4 text-xs text-tertiary md:px-6"
    >
      {load === "loading" && (
        <>
          <Spinner className="size-3.5 text-fg-quaternary" />
          <span className="sr-only">{m.conversation_loading_older()}</span>
        </>
      )}
      {load === "failed" && (
        <>
          {m.conversation_load_older_failed()}
          <Button size="sm" color="link-color" className="text-xs" onPress={onLoad}>
            {m.controls_retry()}
          </Button>
        </>
      )}
    </div>
  );
}
