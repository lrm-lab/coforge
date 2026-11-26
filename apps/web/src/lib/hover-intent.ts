export const POINTER_SPEED_WINDOW_MS = 90;
export const POINTER_FAST_THRESHOLD_PX_PER_MS = 0.1;

export const LABEL_OPEN_DELAY_MS = 500;
export const LABEL_COOLDOWN_MS = 400;

export const CARD_OPEN_DELAY_MS = 700;
export const CARD_CLOSE_DELAY_MS = 300;
export const CARD_SWAP_SLOW_MS = 60;

export const PREVIEW_OPEN_DELAY_MS = 900;
export const PREVIEW_CLOSE_DELAY_MS = 400;

export const SUBMENU_OPEN_DELAY_MS = 250;
export const SUBMENU_CLOSE_DELAY_MS = 300;

export const MESSAGE_TOOLBAR_OPEN_DELAY_MS = 150;
export const MESSAGE_TOOLBAR_CLOSE_DELAY_MS = 200;

export const CHART_TOOLTIP_OPEN_DELAY_MS = 200;

export interface VelocitySample {
  readonly x: number;
  readonly y: number;
  readonly t: number;
}

export interface HoverClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export const browserHoverClock: HoverClock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => globalThis.clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
};

export function pushVelocitySample(
  samples: readonly VelocitySample[],
  next: VelocitySample,
  windowMs: number = POINTER_SPEED_WINDOW_MS,
): readonly VelocitySample[] {
  const cutoff = next.t - windowMs;
  const kept = samples.filter((sample) => sample.t >= cutoff);
  return [...kept, next];
}

export function computePointerSpeed(samples: readonly VelocitySample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return Math.hypot(last.x - first.x, last.y - first.y) / dt;
}

export function isPointerFast(
  speedPxPerMs: number,
  threshold: number = POINTER_FAST_THRESHOLD_PX_PER_MS,
): boolean {
  return speedPxPerMs > threshold;
}

export interface LabelGroupSnapshot {
  readonly activeId: string | null;
  readonly instant: boolean;
}

export interface LabelGroupController {
  getSnapshot(): LabelGroupSnapshot;
  pointerEnterTrigger(id: string): void;
  pointerLeaveTrigger(id: string): void;
  pointerLeaveGroup(): void;
  focusTrigger(id: string): void;
  blurTrigger(id: string): void;
  pressTrigger(id: string): void;
  escape(): void;
  dispose(): void;
}

export function createLabelGroupController(options: {
  clock?: HoverClock;
  openDelayMs?: number;
  cooldownMs?: number;
  onChange: (snapshot: LabelGroupSnapshot) => void;
}): LabelGroupController {
  const clock = options.clock ?? browserHoverClock;
  const openDelayMs = options.openDelayMs ?? LABEL_OPEN_DELAY_MS;
  const cooldownMs = options.cooldownMs ?? LABEL_COOLDOWN_MS;

  let snapshot: LabelGroupSnapshot = { activeId: null, instant: false };
  let openTimer: number | null = null;
  let warmUntil = -Infinity;
  let suppressedId: string | null = null;

  function clearOpenTimer() {
    if (openTimer !== null) {
      clock.clearTimeout(openTimer);
      openTimer = null;
    }
  }

  function emit(next: LabelGroupSnapshot) {
    if (next.activeId === snapshot.activeId && next.instant === snapshot.instant) return;
    snapshot = next;
    options.onChange(snapshot);
  }

  return {
    getSnapshot: () => snapshot,
    pointerEnterTrigger(id) {
      if (suppressedId === id) return;
      clearOpenTimer();
      if (snapshot.activeId === id) return;
      if (snapshot.activeId !== null || clock.now() <= warmUntil) {
        emit({ activeId: id, instant: true });
        return;
      }
      openTimer = clock.setTimeout(() => {
        openTimer = null;
        emit({ activeId: id, instant: false });
      }, openDelayMs);
    },
    pointerLeaveTrigger(id) {
      if (suppressedId === id) {
        suppressedId = null;
      }
      clearOpenTimer();
    },
    pointerLeaveGroup() {
      clearOpenTimer();
      suppressedId = null;
      if (snapshot.activeId !== null) {
        warmUntil = clock.now() + cooldownMs;
        emit({ activeId: null, instant: false });
      }
    },
    focusTrigger(id) {
      clearOpenTimer();
      suppressedId = null;
      emit({ activeId: id, instant: true });
    },
    blurTrigger(id) {
      clearOpenTimer();
      if (snapshot.activeId === id) {
        emit({ activeId: null, instant: false });
      }
    },
    pressTrigger(id) {
      clearOpenTimer();
      suppressedId = id;
      if (snapshot.activeId === id) {
        emit({ activeId: null, instant: false });
      }
    },
    escape() {
      clearOpenTimer();
      if (snapshot.activeId !== null) {
        emit({ activeId: null, instant: false });
      }
    },
    dispose() {
      clearOpenTimer();
    },
  };
}

export interface CardGroupSnapshot {
  readonly activeId: string | null;
  readonly swapped: boolean;
}

export interface CardGroupController {
  getSnapshot(): CardGroupSnapshot;
  pointerEnterTrigger(id: string, x: number, y: number): void;
  pointerMove(x: number, y: number): void;
  pointerLeaveTrigger(id: string): void;
  pointerEnterCard(): void;
  pointerLeaveCard(): void;
  openImmediate(id: string): void;
  closeImmediate(): void;
  dispose(): void;
}

export function createCardGroupController(options: {
  clock?: HoverClock;
  openDelayMs?: number;
  closeDelayMs?: number;
  swapSlowMs?: number;
  onChange: (snapshot: CardGroupSnapshot) => void;
}): CardGroupController {
  const clock = options.clock ?? browserHoverClock;
  const openDelayMs = options.openDelayMs ?? CARD_OPEN_DELAY_MS;
  const closeDelayMs = options.closeDelayMs ?? CARD_CLOSE_DELAY_MS;
  const swapSlowMs = options.swapSlowMs ?? CARD_SWAP_SLOW_MS;

  let snapshot: CardGroupSnapshot = { activeId: null, swapped: false };
  let samples: readonly VelocitySample[] = [];
  let openTimer: number | null = null;
  let swapTimer: number | null = null;
  let closeTimer: number | null = null;
  let pendingId: string | null = null;
  let insideCard = false;

  function clearOpenTimer() {
    if (openTimer !== null) {
      clock.clearTimeout(openTimer);
      openTimer = null;
    }
  }

  function clearSwapTimer() {
    if (swapTimer !== null) {
      clock.clearTimeout(swapTimer);
      swapTimer = null;
    }
  }

  function clearCloseTimer() {
    if (closeTimer !== null) {
      clock.clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function clearAllTimers() {
    clearOpenTimer();
    clearSwapTimer();
    clearCloseTimer();
  }

  function emit(next: CardGroupSnapshot) {
    if (next.activeId === snapshot.activeId && next.swapped === snapshot.swapped) return;
    snapshot = next;
    options.onChange(snapshot);
  }

  function scheduleSwap(id: string, delayMs: number = swapSlowMs) {
    clearSwapTimer();
    swapTimer = clock.setTimeout(() => {
      swapTimer = null;
      if (pendingId !== id) return;
      pendingId = null;
      emit({ activeId: id, swapped: true });
    }, delayMs);
  }

  function scheduleClose() {
    if (snapshot.activeId === null || insideCard || pendingId !== null) return;
    clearCloseTimer();
    closeTimer = clock.setTimeout(() => {
      closeTimer = null;
      emit({ activeId: null, swapped: false });
    }, closeDelayMs);
  }

  return {
    getSnapshot: () => snapshot,
    pointerEnterTrigger(id, x, y) {
      samples = pushVelocitySample(samples, { x, y, t: clock.now() });
      clearCloseTimer();
      clearOpenTimer();
      clearSwapTimer();

      if (snapshot.activeId === id) {
        pendingId = null;
        return;
      }

      pendingId = id;
      if (snapshot.activeId === null) {
        openTimer = clock.setTimeout(() => {
          openTimer = null;
          if (pendingId !== id) return;
          pendingId = null;
          emit({ activeId: id, swapped: false });
        }, openDelayMs);
        return;
      }

      const delay = isPointerFast(computePointerSpeed(samples))
        ? POINTER_SPEED_WINDOW_MS + swapSlowMs
        : swapSlowMs;
      scheduleSwap(id, delay);
    },
    pointerMove(x, y) {
      samples = pushVelocitySample(samples, { x, y, t: clock.now() });
      if (pendingId === null || snapshot.activeId === null) return;
      if (isPointerFast(computePointerSpeed(samples))) {
        scheduleSwap(pendingId, POINTER_SPEED_WINDOW_MS + swapSlowMs);
        return;
      }
      if (swapTimer === null) {
        scheduleSwap(pendingId, swapSlowMs);
      }
    },
    pointerLeaveTrigger(id) {
      if (pendingId === id) {
        pendingId = null;
        clearOpenTimer();
        clearSwapTimer();
      }
      scheduleClose();
    },
    pointerEnterCard() {
      insideCard = true;
      clearCloseTimer();
    },
    pointerLeaveCard() {
      insideCard = false;
      scheduleClose();
    },
    openImmediate(id) {
      clearAllTimers();
      pendingId = null;
      emit({ activeId: id, swapped: snapshot.activeId !== null && snapshot.activeId !== id });
    },
    closeImmediate() {
      clearAllTimers();
      pendingId = null;
      insideCard = false;
      emit({ activeId: null, swapped: false });
    },
    dispose() {
      clearAllTimers();
      pendingId = null;
    },
  };
}

export interface MessageToolbarController {
  isOpen(): boolean;
  pointerEnter(x: number, y: number): void;
  pointerMove(x: number, y: number): void;
  pointerLeave(): void;
  setPinned(pinned: boolean): void;
  dispose(): void;
}

export function createMessageToolbarController(options: {
  clock?: HoverClock;
  openDelayMs?: number;
  closeDelayMs?: number;
  onChange: (open: boolean) => void;
}): MessageToolbarController {
  const clock = options.clock ?? browserHoverClock;
  const openDelayMs = options.openDelayMs ?? MESSAGE_TOOLBAR_OPEN_DELAY_MS;
  const closeDelayMs = options.closeDelayMs ?? MESSAGE_TOOLBAR_CLOSE_DELAY_MS;

  let open = false;
  let inside = false;
  let pinned = false;
  let samples: readonly VelocitySample[] = [];
  let openTimer: number | null = null;
  let closeTimer: number | null = null;

  function clearOpenTimer() {
    if (openTimer !== null) {
      clock.clearTimeout(openTimer);
      openTimer = null;
    }
  }

  function clearCloseTimer() {
    if (closeTimer !== null) {
      clock.clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function emit(next: boolean) {
    if (next === open) return;
    open = next;
    options.onChange(open);
  }

  function scheduleOpen() {
    clearOpenTimer();
    openTimer = clock.setTimeout(() => {
      openTimer = null;
      if (inside) emit(true);
    }, openDelayMs);
  }

  function scheduleClose() {
    if (!open || inside || pinned) return;
    clearCloseTimer();
    closeTimer = clock.setTimeout(() => {
      closeTimer = null;
      if (!inside && !pinned) emit(false);
    }, closeDelayMs);
  }

  return {
    isOpen: () => open,
    pointerEnter(x, y) {
      inside = true;
      samples = pushVelocitySample(samples, { x, y, t: clock.now() });
      clearCloseTimer();
      if (open) return;
      scheduleOpen();
    },
    pointerMove(x, y) {
      if (!inside || open) return;
      samples = pushVelocitySample(samples, { x, y, t: clock.now() });
      if (isPointerFast(computePointerSpeed(samples))) {
        scheduleOpen();
      }
    },
    pointerLeave() {
      inside = false;
      clearOpenTimer();
      scheduleClose();
    },
    setPinned(nextPinned) {
      pinned = nextPinned;
      if (pinned) {
        clearOpenTimer();
        clearCloseTimer();
        emit(true);
      } else {
        scheduleClose();
      }
    },
    dispose() {
      clearOpenTimer();
      clearCloseTimer();
    },
  };
}

export interface ChartHoverController {
  isVisible(): boolean;
  pointerEnter(): void;
  pointerLeave(): void;
  dispose(): void;
}

export function createChartHoverController(options: {
  clock?: HoverClock;
  openDelayMs?: number;
  cooldownMs?: number;
  onChange: (visible: boolean) => void;
}): ChartHoverController {
  const clock = options.clock ?? browserHoverClock;
  const openDelayMs = options.openDelayMs ?? CHART_TOOLTIP_OPEN_DELAY_MS;
  const cooldownMs = options.cooldownMs ?? LABEL_COOLDOWN_MS;

  let visible = false;
  let warmUntil = -Infinity;
  let openTimer: number | null = null;

  function clearOpenTimer() {
    if (openTimer !== null) {
      clock.clearTimeout(openTimer);
      openTimer = null;
    }
  }

  function emit(next: boolean) {
    if (next === visible) return;
    visible = next;
    options.onChange(visible);
  }

  return {
    isVisible: () => visible,
    pointerEnter() {
      clearOpenTimer();
      if (visible) return;
      if (clock.now() <= warmUntil) {
        emit(true);
        return;
      }
      openTimer = clock.setTimeout(() => {
        openTimer = null;
        emit(true);
      }, openDelayMs);
    },
    pointerLeave() {
      clearOpenTimer();
      if (visible) {
        warmUntil = clock.now() + cooldownMs;
        emit(false);
      }
    },
    dispose() {
      clearOpenTimer();
    },
  };
}
