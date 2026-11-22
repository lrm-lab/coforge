import { useCallback, useEffect, useState } from "react";

const failedImageUrls = new Set<string>();
const avatarUrlListeners = new Map<string, Set<() => void>>();
const observedAvatarElements = new WeakSet<HTMLImageElement>();
let avatarScanQueued = false;

function recordFailedImageUrl(url: string) {
  if (failedImageUrls.has(url)) return;
  failedImageUrls.add(url);
  const listeners = avatarUrlListeners.get(url);
  if (!listeners) return;
  avatarUrlListeners.delete(url);
  for (const listener of listeners) listener();
}

function flushAvatarScan() {
  avatarScanQueued = false;
  if (typeof document === "undefined" || avatarUrlListeners.size === 0) return;
  for (const img of document.querySelectorAll<HTMLImageElement>("img[data-avatar-img]")) {
    const src = img.getAttribute("src");
    if (!src) continue;
    if (img.complete && img.naturalWidth === 0) {
      recordFailedImageUrl(src);
      continue;
    }
    if (!observedAvatarElements.has(img)) {
      observedAvatarElements.add(img);
      img.addEventListener("error", () => recordFailedImageUrl(src), { once: true });
    }
  }
}

function subscribeAvatarUrlFailure(url: string, onFailed: () => void) {
  let listeners = avatarUrlListeners.get(url);
  if (!listeners) {
    listeners = new Set();
    avatarUrlListeners.set(url, listeners);
  }
  listeners.add(onFailed);
  if (!avatarScanQueued && typeof document !== "undefined") {
    avatarScanQueued = true;
    queueMicrotask(flushAvatarScan);
  }
  return () => {
    const active = avatarUrlListeners.get(url);
    if (!active) return;
    active.delete(onFailed);
    if (active.size === 0) avatarUrlListeners.delete(url);
  };
}

export function useImageFallback(src: string | null | undefined) {
  const [failedSrc, setFailedSrc] = useState<string | null>(() =>
    src && failedImageUrls.has(src) ? src : null,
  );

  const markFailed = useCallback(() => {
    if (!src) return;
    recordFailedImageUrl(src);
    setFailedSrc(src);
  }, [src]);

  const ref = useCallback(
    (node: HTMLImageElement | null) => {
      if (node && src && node.complete && node.naturalWidth === 0) {
        recordFailedImageUrl(src);
        setFailedSrc(src);
      }
    },
    [src],
  );

  const activeSrc = src && failedSrc !== src && !failedImageUrls.has(src) ? src : undefined;

  return {
    src: activeSrc,
    ref,
    onError: markFailed,
  };
}

export function useAvatarImageFallback(src: string | null | undefined, skip = false) {
  const [failedSrc, setFailedSrc] = useState<string | null>(() =>
    src && !skip && failedImageUrls.has(src) ? src : null,
  );

  useEffect(() => {
    if (!src || skip) return;
    if (failedImageUrls.has(src)) {
      setFailedSrc(src);
      return;
    }
    return subscribeAvatarUrlFailure(src, () => setFailedSrc(src));
  }, [src, skip]);

  return src && (skip || (failedSrc !== src && !failedImageUrls.has(src))) ? src : undefined;
}

export function hasFailedImageUrl(url: string): boolean {
  return failedImageUrls.has(url);
}

export function markFailedImageUrl(url: string): void {
  recordFailedImageUrl(url);
}

export function resetFailedImageUrlsForTest(): void {
  failedImageUrls.clear();
  avatarUrlListeners.clear();
}
