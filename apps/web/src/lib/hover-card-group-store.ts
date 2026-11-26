import {
  browserHoverClock,
  CARD_CLOSE_DELAY_MS,
  CARD_OPEN_DELAY_MS,
  CARD_SWAP_SLOW_MS,
  createCardGroupController,
  type CardGroupController,
  type CardGroupSnapshot,
  type HoverClock,
} from "./hover-intent";

export interface HoverCardGroupTimingConfig {
  readonly openDelayMs: number;
  readonly closeDelayMs: number;
  readonly swapSlowMs: number;
}

export interface HoverCardGroupOverlaySnapshot<Entry extends { readonly id: string }> {
  readonly snapshot: CardGroupSnapshot;
  readonly activeEntry: Entry | null;
  readonly revision: number;
}

export interface HoverCardGroupStore<Entry extends { readonly id: string }> {
  register(entry: Entry): void;
  unregister(id: string): void;
  isActive(id: string): boolean;
  subscribeActive(id: string, listener: () => void): () => void;
  getOverlaySnapshot(): HoverCardGroupOverlaySnapshot<Entry>;
  subscribeOverlay(listener: () => void): () => void;
  pointerEnterTrigger(id: string, x: number, y: number): void;
  pointerLeaveTrigger(id: string): void;
  pointerMove(x: number, y: number): void;
  pointerEnterCard(): void;
  pointerLeaveCard(): void;
  focusTrigger(id: string): void;
  blurTrigger(id: string): void;
  openImmediate(id: string): void;
  closeImmediate(): void;
  activate(config: HoverCardGroupTimingConfig): void;
  dispose(): void;
}

const INITIAL_SNAPSHOT: CardGroupSnapshot = { activeId: null, swapped: false };

export function createHoverCardGroupStore<Entry extends { readonly id: string }>(
  options: {
    clock?: HoverClock;
    openDelayMs?: number;
    closeDelayMs?: number;
    swapSlowMs?: number;
  } = {},
): HoverCardGroupStore<Entry> {
  const clock = options.clock ?? browserHoverClock;
  let config: HoverCardGroupTimingConfig = {
    openDelayMs: options.openDelayMs ?? CARD_OPEN_DELAY_MS,
    closeDelayMs: options.closeDelayMs ?? CARD_CLOSE_DELAY_MS,
    swapSlowMs: options.swapSlowMs ?? CARD_SWAP_SLOW_MS,
  };

  const entries = new Map<string, Entry>();
  const activeListeners = new Map<string, Set<() => void>>();
  const overlayListeners = new Set<() => void>();

  let focusTimer: number | null = null;
  let disposed = false;
  let overlayState: HoverCardGroupOverlaySnapshot<Entry> = {
    snapshot: INITIAL_SNAPSHOT,
    activeEntry: null,
    revision: 0,
  };

  function clearFocusTimer() {
    if (focusTimer !== null) {
      clock.clearTimeout(focusTimer);
      focusTimer = null;
    }
  }

  function notifyOverlay() {
    for (const listener of overlayListeners) {
      listener();
    }
  }

  function notifyActiveId(id: string) {
    const listeners = activeListeners.get(id);
    if (!listeners) return;
    for (const listener of listeners) {
      listener();
    }
  }

  function handleControllerChange(next: CardGroupSnapshot) {
    const prevActiveId = overlayState.snapshot.activeId;
    overlayState = {
      snapshot: next,
      activeEntry: next.activeId ? (entries.get(next.activeId) ?? null) : null,
      revision: overlayState.revision + 1,
    };
    notifyOverlay();
    if (prevActiveId !== next.activeId) {
      if (prevActiveId !== null) notifyActiveId(prevActiveId);
      if (next.activeId !== null) notifyActiveId(next.activeId);
    }
  }

  function buildController(timing: HoverCardGroupTimingConfig): CardGroupController {
    return createCardGroupController({
      clock,
      openDelayMs: timing.openDelayMs,
      closeDelayMs: timing.closeDelayMs,
      swapSlowMs: timing.swapSlowMs,
      onChange: handleControllerChange,
    });
  }

  let controller: CardGroupController = buildController(config);

  return {
    register(entry) {
      entries.set(entry.id, entry);
      if (overlayState.snapshot.activeId === entry.id) {
        overlayState = {
          snapshot: overlayState.snapshot,
          activeEntry: entry,
          revision: overlayState.revision + 1,
        };
        notifyOverlay();
      }
    },
    unregister(id) {
      entries.delete(id);
      if (overlayState.snapshot.activeId === id) {
        clearFocusTimer();
        controller.closeImmediate();
      }
    },
    isActive(id) {
      return overlayState.snapshot.activeId === id;
    },
    subscribeActive(id, listener) {
      let listeners = activeListeners.get(id);
      if (!listeners) {
        listeners = new Set();
        activeListeners.set(id, listeners);
      }
      listeners.add(listener);
      return () => {
        const current = activeListeners.get(id);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) activeListeners.delete(id);
      };
    },
    getOverlaySnapshot() {
      return overlayState;
    },
    subscribeOverlay(listener) {
      overlayListeners.add(listener);
      return () => {
        overlayListeners.delete(listener);
      };
    },
    pointerEnterTrigger(id, x, y) {
      clearFocusTimer();
      controller.pointerEnterTrigger(id, x, y);
    },
    pointerLeaveTrigger(id) {
      controller.pointerLeaveTrigger(id);
    },
    pointerMove(x, y) {
      controller.pointerMove(x, y);
    },
    pointerEnterCard() {
      controller.pointerEnterCard();
    },
    pointerLeaveCard() {
      controller.pointerLeaveCard();
    },
    focusTrigger(id) {
      clearFocusTimer();
      focusTimer = clock.setTimeout(() => {
        focusTimer = null;
        controller.openImmediate(id);
      }, config.openDelayMs);
    },
    blurTrigger(id) {
      clearFocusTimer();
      controller.pointerLeaveTrigger(id);
    },
    openImmediate(id) {
      clearFocusTimer();
      controller.openImmediate(id);
    },
    closeImmediate() {
      clearFocusTimer();
      controller.closeImmediate();
    },
    activate(nextConfig) {
      const sameConfig =
        nextConfig.openDelayMs === config.openDelayMs &&
        nextConfig.closeDelayMs === config.closeDelayMs &&
        nextConfig.swapSlowMs === config.swapSlowMs;
      if (!disposed && sameConfig) return;
      clearFocusTimer();
      controller.dispose();
      config = nextConfig;
      disposed = false;
      controller = buildController(config);
      if (overlayState.snapshot.activeId !== null || overlayState.snapshot.swapped) {
        handleControllerChange(INITIAL_SNAPSHOT);
      }
    },
    dispose() {
      clearFocusTimer();
      controller.dispose();
      disposed = true;
    },
  };
}
