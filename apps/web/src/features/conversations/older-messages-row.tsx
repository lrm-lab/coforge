import { useEffect, useRef, type RefObject } from "react";
import { Button } from "#src/components/base/buttons/button";
import { Spinner } from "#src/components/ui/spinner";
import { m } from "#src/paraglide/messages";

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
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;

  // An IntersectionObserver rather than a scroll handler: it also fires when the pane is laid out
  // already showing the top, which a scroll handler never sees. The margin starts the load a
  // screenful early. It only fires on a crossing, so it is observed afresh whenever a page lands:
  // a page shorter than the margin leaves the row in range, and the reader at the top would
  // otherwise wait for a crossing that never comes.
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
    observer.observe(row);
    return () => observer.disconnect();
  }, [rootRef, loadedCount]);

  return (
    <div
      ref={ref}
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
