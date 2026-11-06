import type { RefObject } from "react";

import { useStateWithRef } from "#src/hooks/use-state-with-ref";
import { captureScrollAnchor, type ScrollAnchor } from "./conversation-scroll-anchor";
import type { OlderLoad } from "./older-messages-row";

/** Loads the page before a main stream's first row, holding the reading position's anchor for the
 * commit that adds it. A thread pane, and one with nothing older, loads nothing. */
export function useLoadOlder({
  historyRef,
  anchorRef,
  enabled,
  onLoadOlder,
}: {
  historyRef: RefObject<HTMLDivElement | null>;
  anchorRef: RefObject<ScrollAnchor | undefined>;
  enabled: boolean | undefined;
  onLoadOlder: (() => Promise<unknown>) | undefined;
}) {
  const [load, loadRef, setLoad] = useStateWithRef<OlderLoad>("idle");
  async function loadOlder() {
    const history = historyRef.current;
    if (!enabled || !history || !onLoadOlder || loadRef.current === "loading") return;
    setLoad("loading");
    anchorRef.current = captureScrollAnchor(history);
    try {
      await onLoadOlder();
      setLoad("idle");
    } catch {
      anchorRef.current = undefined;
      setLoad("failed");
    }
  }
  return { olderLoad: load, loadOlder };
}
