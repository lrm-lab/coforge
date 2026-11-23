import type { PageLevel } from "./artifact-page-levels";
import { clampInlineFrameHeight } from "./artifact-page-theme";

export const INLINE_EMBED_MAX_ACTIVE = 16;
const DEFAULT_HEIGHT_CACHE_LIMIT = 200;

export type InlineSandboxLink = {
  url: string;
  version: number;
  expiresAt: string;
  viewer: { displayName: string; kind: "person" };
  level: PageLevel;
};

export type PooledInlineFrame = {
  readonly cacheKey: string;
  readonly artifactId: string;
  readonly version: number;
  readonly iframe: HTMLIFrameElement;
  readonly link: InlineSandboxLink;
  mountedOnce: boolean;
  ready: boolean;
  blocked: boolean;
};

type AtomicMoveParent = Element & {
  moveBefore?: (node: Node, child: Node | null) => void;
};

function supportsAtomicMove(element?: Element | null): boolean {
  const candidate = (element ??
    (typeof Element !== "undefined" ? Element.prototype : null)) as AtomicMoveParent | null;
  return typeof candidate?.moveBefore === "function";
}

function moveElementPreservingState(parent: Element, node: Element): boolean {
  const atomicParent = parent as AtomicMoveParent;
  if (typeof atomicParent.moveBefore !== "function") return false;
  if (!parent.isConnected || !node.isConnected) return false;
  if (parent.ownerDocument && node.ownerDocument && parent.ownerDocument !== node.ownerDocument)
    return false;
  if (node.parentElement === parent) return true;
  try {
    atomicParent.moveBefore(node, null);
    return true;
  } catch {
    return false;
  }
}

export type InlineEmbedPool = {
  setVisible(slotKey: string, visible: boolean, cacheKey?: string): void;
  release(slotKey: string): void;
  isActive(slotKey: string): boolean;
  rememberHeight(cacheKey: string, height: number): void;
  cachedHeight(cacheKey: string): number | undefined;
  subscribe(listener: () => void): () => void;
  setParkingContainer(container: Element | null): void;
  canParkFrames(): boolean;
  hasParkedFrame(cacheKey: string): boolean;
  claimParkedFrame(slotKey: string, cacheKey: string): PooledInlineFrame | null;
  releaseClaimedIfUnattached(frame: PooledInlineFrame): void;
  attachFrame(slotKey: string, frame: PooledInlineFrame, host: Element): boolean;
  parkFrame(frame: PooledInlineFrame): boolean;
  discardFrame(frame: PooledInlineFrame): void;
  evictArtifact(artifactId: string): void;
  dispose(): void;
};

export function createInlineEmbedPool(
  maxActive = INLINE_EMBED_MAX_ACTIVE,
  heightCacheLimit = DEFAULT_HEIGHT_CACHE_LIMIT,
): InlineEmbedPool {
  const limit = Math.max(1, Math.floor(maxActive));
  const cacheLimit = Math.max(1, Math.floor(heightCacheLimit));
  const visible = new Set<string>();
  const active: string[] = [];
  const pendingSlotKeys = new Map<string, string>();
  const parked: PooledInlineFrame[] = [];
  const transientParked = new Set<PooledInlineFrame>();
  const heights = new Map<string, number>();
  const listeners = new Set<() => void>();
  let parkingContainer: Element | null = null;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const canPark = () =>
    Boolean(
      parkingContainer && parkingContainer.isConnected && supportsAtomicMove(parkingContainer),
    );

  const isReusableParkedFrame = (frame: PooledInlineFrame) =>
    frame.ready && !frame.blocked && frame.iframe.isConnected;

  const removeParkedAt = (index: number, destroy: boolean) => {
    const [removed] = parked.splice(index, 1);
    if (removed && destroy) removed.iframe.remove();
    return removed;
  };

  const clearParked = () => {
    while (parked.length > 0) {
      parked.shift()?.iframe.remove();
    }
    for (const frame of transientParked) {
      frame.iframe.remove();
    }
    transientParked.clear();
    parkingContainer?.replaceChildren?.();
  };

  const touchActive = (slotKey: string) => {
    const index = active.indexOf(slotKey);
    if (index >= 0) active.splice(index, 1);
    active.push(slotKey);
  };

  const reservedParkedIndices = () => {
    const reserved = new Set<number>();
    if (!canPark() || parked.length === 0 || pendingSlotKeys.size === 0) return reserved;
    for (const [slotKey, cacheKey] of pendingSlotKeys) {
      if (!active.includes(slotKey)) continue;
      for (let index = parked.length - 1; index >= 0; index -= 1) {
        if (reserved.has(index)) continue;
        const candidate = parked[index];
        if (candidate && candidate.cacheKey === cacheKey && isReusableParkedFrame(candidate)) {
          reserved.add(index);
          break;
        }
      }
    }
    return reserved;
  };

  const evictParkedToFit = () => {
    while (parked.length > 0) {
      const reserved = reservedParkedIndices();
      if (active.length + parked.length - reserved.size <= limit) break;
      let evictIndex = -1;
      for (let index = 0; index < parked.length; index += 1) {
        if (!reserved.has(index)) {
          evictIndex = index;
          break;
        }
      }
      if (evictIndex === -1) evictIndex = 0;
      removeParkedAt(evictIndex, true);
    }
  };

  const evictIfNeeded = () => {
    evictParkedToFit();
    let changed = false;
    while (active.length > limit) {
      const offscreenIndex = active.findIndex((key) => !visible.has(key));
      const removeIndex = offscreenIndex >= 0 ? offscreenIndex : 0;
      const [evictedKey] = active.splice(removeIndex, 1);
      if (evictedKey !== undefined) pendingSlotKeys.delete(evictedKey);
      changed = true;
    }
    return changed;
  };

  const scheduleTransientPrune = (frame: PooledInlineFrame) => {
    queueMicrotask(() => {
      if (!transientParked.delete(frame)) return;
      if (parked.includes(frame)) return;
      if (!parkingContainer || frame.iframe.parentElement === parkingContainer) {
        frame.iframe.remove();
      }
    });
  };

  const parkFrameInternal = (frame: PooledInlineFrame): boolean => {
    const existingIndex = parked.indexOf(frame);
    if (existingIndex >= 0) parked.splice(existingIndex, 1);
    transientParked.delete(frame);
    if (
      !canPark() ||
      frame.blocked ||
      !frame.iframe.isConnected ||
      !parkingContainer ||
      !moveElementPreservingState(parkingContainer, frame.iframe)
    ) {
      frame.iframe.remove();
      return false;
    }
    if (!frame.ready || active.length >= limit) {
      transientParked.add(frame);
      scheduleTransientPrune(frame);
      return false;
    }
    parked.push(frame);
    evictParkedToFit();
    return parked.includes(frame);
  };

  return {
    setVisible(slotKey, isVisible, cacheKey) {
      if (isVisible) {
        visible.add(slotKey);
        const wasActive = active.includes(slotKey);
        if (!wasActive && cacheKey !== undefined) {
          pendingSlotKeys.set(slotKey, cacheKey);
        }
        touchActive(slotKey);
        const evicted = evictIfNeeded();
        if (!wasActive || evicted) notify();
        return;
      }
      visible.delete(slotKey);
    },
    release(slotKey) {
      visible.delete(slotKey);
      pendingSlotKeys.delete(slotKey);
      const index = active.indexOf(slotKey);
      if (index === -1) return;
      active.splice(index, 1);
      notify();
    },
    isActive(slotKey) {
      return active.includes(slotKey);
    },
    rememberHeight(cacheKey, height) {
      const clamped = clampInlineFrameHeight(height);
      if (heights.has(cacheKey)) heights.delete(cacheKey);
      heights.set(cacheKey, clamped);
      while (heights.size > cacheLimit) {
        const oldest = heights.keys().next().value;
        if (oldest === undefined) break;
        heights.delete(oldest);
      }
    },
    cachedHeight(cacheKey) {
      return heights.get(cacheKey);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setParkingContainer(container) {
      if (parkingContainer === container) return;
      if (!container) clearParked();
      parkingContainer = container;
    },
    canParkFrames() {
      return canPark();
    },
    hasParkedFrame(cacheKey) {
      if (!canPark()) return false;
      return parked.some((frame) => frame.cacheKey === cacheKey && isReusableParkedFrame(frame));
    },
    claimParkedFrame(slotKey, cacheKey) {
      if (!canPark()) return null;
      for (let index = parked.length - 1; index >= 0; index -= 1) {
        const candidate = parked[index];
        if (!candidate || candidate.cacheKey !== cacheKey) continue;
        if (!isReusableParkedFrame(candidate)) {
          removeParkedAt(index, true);
          continue;
        }
        parked.splice(index, 1);
        pendingSlotKeys.delete(slotKey);
        if (active.includes(slotKey)) touchActive(slotKey);
        return candidate;
      }
      return null;
    },
    releaseClaimedIfUnattached(frame) {
      if (!parkingContainer || frame.iframe.parentElement !== parkingContainer) return;
      if (parked.includes(frame) || transientParked.has(frame)) return;
      parkFrameInternal(frame);
    },
    attachFrame(slotKey, frame, host) {
      const parkedIndex = parked.indexOf(frame);
      if (parkedIndex >= 0) parked.splice(parkedIndex, 1);
      transientParked.delete(frame);
      pendingSlotKeys.delete(slotKey);
      if (active.includes(slotKey)) touchActive(slotKey);
      evictParkedToFit();
      if (frame.iframe.parentElement === host) {
        frame.mountedOnce = true;
        return true;
      }
      if (frame.iframe.isConnected) {
        const moved = moveElementPreservingState(host, frame.iframe);
        if (moved) frame.mountedOnce = true;
        return moved;
      }
      if (frame.mountedOnce) return false;
      host.appendChild(frame.iframe);
      frame.mountedOnce = true;
      return true;
    },
    parkFrame(frame) {
      return parkFrameInternal(frame);
    },
    discardFrame(frame) {
      const existingIndex = parked.indexOf(frame);
      if (existingIndex >= 0) parked.splice(existingIndex, 1);
      transientParked.delete(frame);
      frame.iframe.remove();
    },
    evictArtifact(artifactId) {
      for (let index = parked.length - 1; index >= 0; index -= 1) {
        if (parked[index]?.artifactId === artifactId) {
          removeParkedAt(index, true);
        }
      }
      for (const frame of transientParked) {
        if (frame.artifactId === artifactId) {
          transientParked.delete(frame);
          frame.iframe.remove();
        }
      }
    },
    dispose() {
      clearParked();
      visible.clear();
      pendingSlotKeys.clear();
      active.length = 0;
    },
  };
}
