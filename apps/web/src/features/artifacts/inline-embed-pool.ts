import { clampInlineFrameHeight } from "./artifact-page-theme";

export const INLINE_EMBED_MAX_ACTIVE = 16;
const DEFAULT_HEIGHT_CACHE_LIMIT = 200;

export type InlineEmbedPool = {
  setVisible(slotKey: string, visible: boolean): void;
  release(slotKey: string): void;
  isActive(slotKey: string): boolean;
  rememberHeight(cacheKey: string, height: number): void;
  cachedHeight(cacheKey: string): number | undefined;
  subscribe(listener: () => void): () => void;
};

export function createInlineEmbedPool(
  maxActive = INLINE_EMBED_MAX_ACTIVE,
  heightCacheLimit = DEFAULT_HEIGHT_CACHE_LIMIT,
): InlineEmbedPool {
  const limit = Math.max(1, Math.floor(maxActive));
  const cacheLimit = Math.max(1, Math.floor(heightCacheLimit));
  const visible = new Set<string>();
  const active: string[] = [];
  const heights = new Map<string, number>();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const touchActive = (slotKey: string) => {
    const index = active.indexOf(slotKey);
    if (index >= 0) active.splice(index, 1);
    active.push(slotKey);
  };

  const evictIfNeeded = () => {
    let changed = false;
    while (active.length > limit) {
      const offscreenIndex = active.findIndex((key) => !visible.has(key));
      const removeIndex = offscreenIndex >= 0 ? offscreenIndex : 0;
      active.splice(removeIndex, 1);
      changed = true;
    }
    return changed;
  };

  return {
    setVisible(slotKey, isVisible) {
      if (isVisible) {
        visible.add(slotKey);
        const wasActive = active.includes(slotKey);
        touchActive(slotKey);
        const evicted = evictIfNeeded();
        if (!wasActive || evicted) notify();
        return;
      }
      visible.delete(slotKey);
    },
    release(slotKey) {
      visible.delete(slotKey);
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
  };
}
