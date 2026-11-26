import { describe, expect, test } from "bun:test";
import { createHoverCardGroupStore } from "./hover-card-group-store";
import {
  CARD_CLOSE_DELAY_MS,
  CARD_OPEN_DELAY_MS,
  CARD_SWAP_SLOW_MS,
  type HoverClock,
} from "./hover-intent";

function createFakeClock(start = 1000) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();

  const clock: HoverClock = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };

  function advance(ms: number) {
    const target = now + ms;
    while (true) {
      let earliestId: number | null = null;
      let earliestAt = Infinity;
      for (const [id, entry] of timers) {
        if (entry.at <= target && entry.at < earliestAt) {
          earliestAt = entry.at;
          earliestId = id;
        }
      }
      if (earliestId === null) break;
      const entry = timers.get(earliestId)!;
      timers.delete(earliestId);
      now = entry.at;
      entry.fn();
    }
    now = target;
  }

  return { clock, advance, pendingCount: () => timers.size };
}

describe("createHoverCardGroupStore", () => {
  test("notifies only affected trigger ids on open, swap, and close across 100 siblings", () => {
    const { clock, advance } = createFakeClock();
    const store = createHoverCardGroupStore<{ id: string; label: string }>({ clock });
    const notifications = new Map<string, number>();
    let overlayNotifications = 0;
    store.subscribeOverlay(() => {
      overlayNotifications += 1;
    });

    for (let i = 0; i < 100; i += 1) {
      const id = `card-${i}`;
      store.register({ id, label: `Card ${i}` });
      store.subscribeActive(id, () => {
        notifications.set(id, (notifications.get(id) ?? 0) + 1);
      });
    }

    store.pointerEnterTrigger("card-7", 10, 10);
    advance(CARD_OPEN_DELAY_MS);

    expect(store.isActive("card-7")).toBe(true);
    expect(store.isActive("card-42")).toBe(false);
    expect(overlayNotifications).toBe(1);
    expect([...notifications.entries()]).toEqual([["card-7", 1]]);

    notifications.clear();
    store.pointerEnterTrigger("card-42", 12, 12);
    advance(CARD_SWAP_SLOW_MS);

    expect(store.isActive("card-7")).toBe(false);
    expect(store.isActive("card-42")).toBe(true);
    expect(overlayNotifications).toBe(2);
    expect([...notifications.entries()].sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ["card-42", 1],
      ["card-7", 1],
    ]);

    notifications.clear();
    store.pointerLeaveTrigger("card-42");
    advance(CARD_CLOSE_DELAY_MS);

    expect(store.isActive("card-42")).toBe(false);
    expect(overlayNotifications).toBe(3);
    expect([...notifications.entries()]).toEqual([["card-42", 1]]);
  });

  test("keeps getOverlaySnapshot referentially stable and only refreshes overlay when active entry updates", () => {
    const { clock } = createFakeClock();
    const store = createHoverCardGroupStore<{ id: string; label: string }>({ clock });
    let overlayNotifications = 0;
    let activeTriggerNotifications = 0;
    store.subscribeOverlay(() => {
      overlayNotifications += 1;
    });
    store.subscribeActive("a", () => {
      activeTriggerNotifications += 1;
    });

    store.register({ id: "a", label: "v1" });
    store.register({ id: "b", label: "v1" });
    const initial = store.getOverlaySnapshot();
    expect(store.getOverlaySnapshot()).toBe(initial);

    store.openImmediate("a");
    expect(overlayNotifications).toBe(1);
    expect(activeTriggerNotifications).toBe(1);
    const opened = store.getOverlaySnapshot();
    expect(opened.activeEntry?.label).toBe("v1");

    store.register({ id: "b", label: "v2" });
    expect(overlayNotifications).toBe(1);
    expect(store.getOverlaySnapshot()).toBe(opened);

    store.register({ id: "a", label: "v2" });
    expect(overlayNotifications).toBe(2);
    expect(activeTriggerNotifications).toBe(1);
    expect(store.getOverlaySnapshot().activeEntry?.label).toBe("v2");
  });

  test("unregister closes only the active entry and leaves siblings quiet", () => {
    const { clock } = createFakeClock();
    const store = createHoverCardGroupStore<{ id: string }>({ clock });
    let activeNotifications = 0;
    let overlayNotifications = 0;
    store.subscribeActive("a", () => {
      activeNotifications += 1;
    });
    store.subscribeOverlay(() => {
      overlayNotifications += 1;
    });

    store.register({ id: "a" });
    store.register({ id: "b" });
    store.openImmediate("a");

    store.unregister("b");
    expect(store.isActive("a")).toBe(true);
    expect(overlayNotifications).toBe(1);
    expect(activeNotifications).toBe(1);

    store.unregister("a");
    expect(store.isActive("a")).toBe(false);
    expect(store.getOverlaySnapshot().activeEntry).toBeNull();
    expect(overlayNotifications).toBe(2);
    expect(activeNotifications).toBe(2);
  });

  test("focusTrigger opens after openDelayMs, cancels on blur, and survives StrictMode dispose+activate", () => {
    const { clock, advance } = createFakeClock();
    const store = createHoverCardGroupStore<{ id: string }>({ clock, openDelayMs: 500 });
    store.register({ id: "a" });

    store.focusTrigger("a");
    advance(250);
    store.blurTrigger("a");
    advance(500);
    expect(store.isActive("a")).toBe(false);

    store.dispose();
    store.activate({ openDelayMs: 500, closeDelayMs: 300, swapSlowMs: 60 });
    store.focusTrigger("a");
    advance(500);
    expect(store.isActive("a")).toBe(true);
    expect(store.getOverlaySnapshot().activeEntry?.id).toBe("a");
  });
});
