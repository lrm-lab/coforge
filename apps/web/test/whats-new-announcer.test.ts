import { describe, expect, test } from "bun:test";
import {
  startCalmMomentWatcher,
  WHATS_NEW_ACTIVITY_EVENTS,
  WHATS_NEW_QUIET_MS,
  type CalmMomentEventTarget,
} from "#src/features/whats-new/whats-new-announcer-quiet";

function createFakeEnvironment() {
  let currentTime = 10_000;
  let visible = true;
  let blocked = false;
  const listeners = new Map<string, Set<() => void>>();
  let tickCallback: (() => void) | null = null;
  let cleared = false;

  const target: CalmMomentEventTarget = {
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };

  return {
    target,
    advance(ms: number) {
      currentTime += ms;
      tickCallback?.();
    },
    emit(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    setVisible(next: boolean) {
      visible = next;
    },
    setBlocked(next: boolean) {
      blocked = next;
    },
    isCleared: () => cleared,
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    watcherOptions(onCalm: () => void) {
      return {
        target,
        isVisible: () => visible,
        isBlocked: () => blocked,
        onCalm,
        now: () => currentTime,
        setIntervalFn: (fn: () => void) => {
          tickCallback = fn;
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearIntervalFn: () => {
          cleared = true;
          tickCallback = null;
        },
      };
    },
  };
}

describe("startCalmMomentWatcher", () => {
  test("auto-opens once after the quiet window when the user is idle", () => {
    const env = createFakeEnvironment();
    let opened = 0;
    startCalmMomentWatcher(env.watcherOptions(() => (opened += 1)));

    env.advance(WHATS_NEW_QUIET_MS - 1);
    expect(opened).toBe(0);

    env.advance(1);
    expect(opened).toBe(1);
    expect(env.isCleared()).toBe(true);
    expect(env.listenerCount()).toBe(0);

    env.advance(WHATS_NEW_QUIET_MS * 2);
    expect(opened).toBe(1);
  });

  test("defers auto-open during pointer, mouse, touch, click, wheel, scroll, and keyboard activity", () => {
    for (const event of WHATS_NEW_ACTIVITY_EVENTS) {
      const env = createFakeEnvironment();
      let opened = 0;
      startCalmMomentWatcher(env.watcherOptions(() => (opened += 1)));

      env.advance(WHATS_NEW_QUIET_MS - 500);
      expect(opened).toBe(0);

      env.emit(event);
      env.advance(WHATS_NEW_QUIET_MS - 1);
      expect(opened).toBe(0);

      env.advance(1);
      expect(opened).toBe(1);
    }
  });

  test("waits while hidden, blocked by a draft/overlay, or right after switching back to the tab", () => {
    const env = createFakeEnvironment();
    let opened = 0;
    startCalmMomentWatcher(env.watcherOptions(() => (opened += 1)));

    env.setBlocked(true);
    env.advance(WHATS_NEW_QUIET_MS + 1000);
    expect(opened).toBe(0);

    env.setVisible(false);
    env.setBlocked(false);
    env.advance(WHATS_NEW_QUIET_MS + 1000);
    expect(opened).toBe(0);

    // Switching back to the tab resets the quiet window so the popup never interrupts arrival.
    env.setVisible(true);
    env.emit("visibilitychange");
    env.advance(WHATS_NEW_QUIET_MS - 1);
    expect(opened).toBe(0);

    env.advance(1);
    expect(opened).toBe(1);
  });
});
