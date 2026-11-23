import { useEffect, useEffectEvent, useLayoutEffect, useRef, type RefObject } from "react";

import type { InlineEmbedPool, InlineSandboxLink, PooledInlineFrame } from "./inline-embed-pool";

export function useManagedInlineFrame({
  enabled,
  unavailable,
  pool,
  slotId,
  heightKey,
  artifactId,
  title,
  link,
  frameRef,
  pooledEntryRef,
  onLoad,
  onReload,
  shouldDiscard,
}: {
  enabled: boolean;
  unavailable: boolean;
  pool: InlineEmbedPool;
  slotId: string;
  heightKey: string;
  artifactId: string;
  title: string;
  link: InlineSandboxLink;
  frameRef: RefObject<HTMLIFrameElement | null>;
  pooledEntryRef: RefObject<PooledInlineFrame | null>;
  onLoad: () => void;
  onReload: () => void;
  shouldDiscard?: () => boolean;
}) {
  const frameSlotRef = useRef<HTMLDivElement>(null);
  const readTitle = useEffectEvent(() => title);
  const triggerReload = useEffectEvent(() => onReload());
  const checkDiscard = useEffectEvent(() => shouldDiscard?.() ?? false);

  useLayoutEffect(() => {
    if (!enabled || unavailable) return;
    const host = frameSlotRef.current;
    if (!host) return;
    const currentTitle = readTitle();
    let entry = pooledEntryRef.current;
    if (!entry) {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("aria-label", currentTitle);
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
      iframe.setAttribute("allow", "clipboard-read 'none'; clipboard-write 'none'");
      iframe.referrerPolicy = "no-referrer";
      iframe.className = "block h-full w-full border-0 bg-transparent";
      entry = {
        cacheKey: heightKey,
        artifactId,
        version: link.version,
        iframe,
        link,
        mountedOnce: false,
        ready: false,
        blocked: false,
      };
      pooledEntryRef.current = entry;
      iframe.addEventListener("load", onLoad);
      iframe.src = link.url;
    } else {
      entry.iframe.setAttribute("aria-label", currentTitle);
      if (!entry.ready) {
        entry.iframe.addEventListener("load", onLoad);
      }
    }
    frameRef.current = entry.iframe;
    if (!pool.attachFrame(slotId, entry, host)) {
      pool.discardFrame(entry);
      pooledEntryRef.current = null;
      frameRef.current = null;
      triggerReload();
      return;
    }
    const attachedEntry = entry;
    return () => {
      attachedEntry.iframe.removeEventListener("load", onLoad);
      frameRef.current = null;
      if (checkDiscard()) {
        pool.discardFrame(attachedEntry);
      } else {
        pool.parkFrame(attachedEntry);
      }
    };
  }, [
    enabled,
    unavailable,
    pool,
    slotId,
    heightKey,
    artifactId,
    link,
    frameRef,
    pooledEntryRef,
    onLoad,
  ]);

  useEffect(() => {
    if (!enabled || !frameRef.current) return;
    frameRef.current.setAttribute("aria-label", title);
  }, [enabled, frameRef, title]);

  return frameSlotRef;
}
