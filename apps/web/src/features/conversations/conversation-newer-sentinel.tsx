import type { RefObject } from "react";

/**
 * An empty sentinel below the newest row: coming into view asks for the page that restores the
 * evicted tail. Nothing is shown for it — the reader reached the bottom and the tail is on its way.
 */
export function NewerSentinel({ sentinelRef }: { sentinelRef: RefObject<HTMLDivElement | null> }) {
  return <div ref={sentinelRef} aria-hidden="true" className="h-8" />;
}
