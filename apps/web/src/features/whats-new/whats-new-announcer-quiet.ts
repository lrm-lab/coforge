export const WHATS_NEW_ANNOUNCED_KEY = "coforge-whats-new-announced";
export const WHATS_NEW_QUIET_MS = 3000;
export const WHATS_NEW_POLL_MS = 1000;

/**
 * User interaction events that defer automatic What's New opening: keyboard, pointer, mouse,
 * touch, wheel, and scroll activity all indicate the user is actively using the page.
 */
export const WHATS_NEW_ACTIVITY_EVENTS = [
  "keydown",
  "pointerdown",
  "pointermove",
  "mousedown",
  "touchstart",
  "click",
  "wheel",
  "scroll",
] as const;

export const WHATS_NEW_BLOCKING_OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

export type CalmMomentEventTarget = {
  addEventListener: (
    type: string,
    listener: () => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  removeEventListener: (
    type: string,
    listener: () => void,
    options?: boolean | EventListenerOptions,
  ) => void;
};

export type CalmMomentWatcherOptions = {
  target: CalmMomentEventTarget;
  isVisible: () => boolean;
  isBlocked: () => boolean;
  onCalm: () => void;
  quietMs?: number;
  pollMs?: number;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
};

/**
 * Waits for a genuine calm moment (visible document, no recent keyboard/pointer/mouse/touch/scroll
 * activity for `quietMs`, and no active draft or blocking overlay) before invoking `onCalm` once.
 * Returning to a visible tab resets the quiet window so the popup never fires immediately on tab
 * switch.
 */
export function startCalmMomentWatcher({
  target,
  isVisible,
  isBlocked,
  onCalm,
  quietMs = WHATS_NEW_QUIET_MS,
  pollMs = WHATS_NEW_POLL_MS,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}: CalmMomentWatcherOptions): () => void {
  let lastActivity = now();
  let stopped = false;

  const markActivity = () => {
    lastActivity = now();
  };
  const onVisibilityChange = () => {
    if (isVisible()) lastActivity = now();
  };

  for (const event of WHATS_NEW_ACTIVITY_EVENTS) {
    target.addEventListener(event, markActivity, { capture: true, passive: true });
  }
  target.addEventListener("visibilitychange", onVisibilityChange, true);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearIntervalFn(timer);
    for (const event of WHATS_NEW_ACTIVITY_EVENTS) {
      target.removeEventListener(event, markActivity, true);
    }
    target.removeEventListener("visibilitychange", onVisibilityChange, true);
  };

  const timer = setIntervalFn(() => {
    if (stopped) return;
    if (!isVisible() || now() - lastActivity < quietMs) return;
    if (isBlocked()) return;
    stop();
    onCalm();
  }, pollMs);

  return stop;
}
