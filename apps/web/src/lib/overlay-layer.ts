import { useCallback, useLayoutEffect, useState, type Ref } from "react";

/**
 * The one layer every overlay that covers the screen sits on: the official modal's `z-50`. React
 * Aria portals each overlay to the end of `<body>` as it opens, so among overlays on one layer the
 * one opened last is on top, whichever kind each is (task #519: a profile slideout opened from a
 * Task popup had no layer and showed under it). Popovers and tooltips are React Aria's to place,
 * above all of these (`useOverlayPosition`'s inline `z-index: 100000`).
 */
export const OVERLAY_LAYER = "z-50";

export const OVERLAY_SCRIM_Z = 0;
export const OVERLAY_CONTENT_Z = 10;

export function createOverlayHostElement(): HTMLDivElement {
  const host = document.createElement("div");
  host.setAttribute("data-overlay-host", "");
  host.className = `absolute inset-x-0 top-0 ${OVERLAY_LAYER}`;
  return host;
}

export function composeOverlayRefs<T>(
  externalRef: Ref<T> | undefined,
  internalRef: (node: T | null) => void,
): (node: T | null) => void {
  return (node) => {
    internalRef(node);
    if (typeof externalRef === "function") externalRef(node);
    else if (externalRef) externalRef.current = node;
  };
}

export function useOverlayHost(open: boolean): {
  host: HTMLDivElement | null;
  overlayRef: (node: HTMLElement | null) => void;
} {
  const [host] = useState<HTMLDivElement | null>(() =>
    typeof document === "undefined" ? null : createOverlayHostElement(),
  );
  const [overlayMounted, setOverlayMounted] = useState(false);

  const overlayRef = useCallback((node: HTMLElement | null) => {
    setOverlayMounted(node !== null);
  }, []);

  const active = open || overlayMounted;

  useLayoutEffect(() => {
    if (!host || !active) return;
    if (!host.isConnected) document.body.appendChild(host);
    return () => {
      host.remove();
    };
  }, [host, active]);

  useLayoutEffect(() => {
    if (!host || !open) return;
    if (!host.isConnected || host.nextSibling !== null) document.body.appendChild(host);
  }, [host, open]);

  return { host, overlayRef };
}
