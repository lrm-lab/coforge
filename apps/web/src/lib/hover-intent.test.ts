import { describe, expect, test } from "bun:test";
import {
  CARD_CLOSE_DELAY_MS,
  CARD_OPEN_DELAY_MS,
  CARD_SWAP_SLOW_MS,
  CHART_TOOLTIP_OPEN_DELAY_MS,
  computePointerSpeed,
  createCardGroupController,
  createChartHoverController,
  createLabelGroupController,
  createMessageToolbarController,
  isPointerFast,
  LABEL_COOLDOWN_MS,
  LABEL_OPEN_DELAY_MS,
  MESSAGE_TOOLBAR_CLOSE_DELAY_MS,
  MESSAGE_TOOLBAR_OPEN_DELAY_MS,
  POINTER_FAST_THRESHOLD_PX_PER_MS,
  POINTER_SPEED_WINDOW_MS,
  pushVelocitySample,
  type HoverClock,
  type VelocitySample,
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

describe("pointer velocity", () => {
  test("pins speed window and fast threshold constants", () => {
    expect(POINTER_SPEED_WINDOW_MS).toBe(90);
    expect(POINTER_FAST_THRESHOLD_PX_PER_MS).toBe(0.1);
  });

  test("measures speed over the last 90ms and classifies fast vs slow", () => {
    let samples: readonly VelocitySample[] = [];
    samples = pushVelocitySample(samples, { x: 0, y: 0, t: 100 });
    expect(computePointerSpeed(samples)).toBe(0);
    expect(isPointerFast(computePointerSpeed(samples))).toBe(false);

    samples = pushVelocitySample(samples, { x: 30, y: 0, t: 160 });
    expect(computePointerSpeed(samples)).toBeCloseTo(0.5, 5);
    expect(isPointerFast(computePointerSpeed(samples))).toBe(true);

    samples = pushVelocitySample(samples, { x: 32, y: 0, t: 250 });
    expect(samples.length).toBe(2);
    expect(computePointerSpeed(samples)).toBeCloseTo(2 / 90, 5);
    expect(isPointerFast(computePointerSpeed(samples))).toBe(false);
  });
});

describe("createLabelGroupController", () => {
  test("pins label timing constants", () => {
    expect(LABEL_OPEN_DELAY_MS).toBe(500);
    expect(LABEL_COOLDOWN_MS).toBe(400);
  });

  test("sweeping across triggers opens nothing; resting 500ms opens and moving within group swaps at once", () => {
    const { clock, advance, pendingCount } = createFakeClock();
    const events: Array<{ activeId: string | null; instant: boolean }> = [];
    const ctrl = createLabelGroupController({
      clock,
      onChange: (snap) => events.push({ activeId: snap.activeId, instant: snap.instant }),
    });

    ctrl.pointerEnterTrigger("a");
    advance(300);
    ctrl.pointerLeaveTrigger("a");
    ctrl.pointerEnterTrigger("b");
    advance(300);
    ctrl.pointerLeaveTrigger("b");
    ctrl.pointerEnterTrigger("c");
    advance(499);
    expect(ctrl.getSnapshot().activeId).toBeNull();

    advance(1);
    expect(ctrl.getSnapshot()).toEqual({ activeId: "c", instant: false });

    ctrl.pointerLeaveTrigger("c");
    advance(50);
    expect(ctrl.getSnapshot().activeId).toBe("c");

    ctrl.pointerEnterTrigger("b");
    expect(ctrl.getSnapshot()).toEqual({ activeId: "b", instant: true });

    ctrl.pointerLeaveGroup();
    expect(ctrl.getSnapshot().activeId).toBeNull();

    advance(399);
    ctrl.pointerEnterTrigger("a");
    expect(ctrl.getSnapshot()).toEqual({ activeId: "a", instant: true });

    ctrl.pointerLeaveGroup();
    advance(401);
    ctrl.pointerEnterTrigger("a");
    expect(ctrl.getSnapshot().activeId).toBeNull();
    advance(500);
    expect(ctrl.getSnapshot()).toEqual({ activeId: "a", instant: false });

    ctrl.dispose();
    expect(pendingCount()).toBe(0);
    expect(events.length).toBeGreaterThan(0);
  });

  test("pressing a trigger hides its label until the pointer leaves that trigger", () => {
    const { clock, advance } = createFakeClock();
    const ctrl = createLabelGroupController({ clock, onChange: () => {} });

    ctrl.pointerEnterTrigger("a");
    advance(500);
    expect(ctrl.getSnapshot().activeId).toBe("a");

    ctrl.pressTrigger("a");
    expect(ctrl.getSnapshot().activeId).toBeNull();

    ctrl.pointerEnterTrigger("a");
    advance(600);
    expect(ctrl.getSnapshot().activeId).toBeNull();

    ctrl.pointerLeaveTrigger("a");
    ctrl.pointerLeaveGroup();
    advance(500);
    ctrl.pointerEnterTrigger("a");
    advance(500);
    expect(ctrl.getSnapshot().activeId).toBe("a");

    ctrl.dispose();
  });

  test("keyboard focus shows at once and escape hides immediately", () => {
    const { clock } = createFakeClock();
    const ctrl = createLabelGroupController({ clock, onChange: () => {} });

    ctrl.focusTrigger("a");
    expect(ctrl.getSnapshot()).toEqual({ activeId: "a", instant: true });

    ctrl.escape();
    expect(ctrl.getSnapshot().activeId).toBeNull();

    ctrl.focusTrigger("b");
    expect(ctrl.getSnapshot().activeId).toBe("b");

    ctrl.blurTrigger("b");
    expect(ctrl.getSnapshot().activeId).toBeNull();

    ctrl.dispose();
  });
});

describe("createCardGroupController", () => {
  test("pins card timing constants", () => {
    expect(CARD_OPEN_DELAY_MS).toBe(700);
    expect(CARD_CLOSE_DELAY_MS).toBe(300);
    expect(CARD_SWAP_SLOW_MS).toBe(60);
  });

  test("waits 700ms to open, gives 300ms close grace, and swaps only after slowing down for 60ms", () => {
    const { clock, advance, pendingCount } = createFakeClock();
    const ctrl = createCardGroupController({ clock, onChange: () => {} });

    ctrl.pointerEnterTrigger("a", 10, 10);
    advance(699);
    expect(ctrl.getSnapshot().activeId).toBeNull();

    advance(1);
    expect(ctrl.getSnapshot()).toEqual({ activeId: "a", swapped: false });

    ctrl.pointerLeaveTrigger("a");
    advance(200);
    expect(ctrl.getSnapshot().activeId).toBe("a");
    ctrl.pointerEnterCard();
    advance(500);
    expect(ctrl.getSnapshot().activeId).toBe("a");

    ctrl.pointerLeaveCard();
    ctrl.pointerEnterTrigger("b", 40, 10);
    advance(20);
    ctrl.pointerMove(80, 10);
    advance(20);
    ctrl.pointerMove(120, 10);
    advance(149);
    expect(ctrl.getSnapshot().activeId).toBe("a");

    advance(1);
    expect(ctrl.getSnapshot()).toEqual({ activeId: "b", swapped: true });

    advance(100);
    ctrl.pointerLeaveTrigger("b");
    ctrl.pointerEnterTrigger("c", 122, 10);
    advance(59);
    expect(ctrl.getSnapshot().activeId).toBe("b");
    advance(1);
    expect(ctrl.getSnapshot()).toEqual({ activeId: "c", swapped: true });

    ctrl.pointerLeaveTrigger("c");
    advance(299);
    expect(ctrl.getSnapshot().activeId).toBe("c");
    advance(1);
    expect(ctrl.getSnapshot().activeId).toBeNull();

    ctrl.openImmediate("c");
    expect(ctrl.getSnapshot().activeId).toBe("c");
    ctrl.closeImmediate();
    expect(ctrl.getSnapshot().activeId).toBeNull();

    ctrl.dispose();
    expect(pendingCount()).toBe(0);
  });
});

describe("createMessageToolbarController", () => {
  test("skips fast sweeps, opens after 150ms slow dwell, and holds 200ms on leave", () => {
    const { clock, advance, pendingCount } = createFakeClock();
    const ctrl = createMessageToolbarController({ clock, onChange: () => {} });

    expect(MESSAGE_TOOLBAR_OPEN_DELAY_MS).toBe(150);
    expect(MESSAGE_TOOLBAR_CLOSE_DELAY_MS).toBe(200);

    ctrl.pointerEnter(0, 0);
    advance(50);
    ctrl.pointerMove(40, 0);
    advance(50);
    ctrl.pointerMove(80, 0);
    advance(60);
    expect(ctrl.isOpen()).toBe(false);

    advance(90);
    expect(ctrl.isOpen()).toBe(true);

    ctrl.pointerLeave();
    advance(199);
    expect(ctrl.isOpen()).toBe(true);
    advance(1);
    expect(ctrl.isOpen()).toBe(false);

    ctrl.dispose();
    expect(pendingCount()).toBe(0);
  });
});

describe("createChartHoverController", () => {
  test("waits 200ms on initial entry, tracks immediately while active, and cools down over 400ms", () => {
    const { clock, advance, pendingCount } = createFakeClock();
    const ctrl = createChartHoverController({ clock, onChange: () => {} });

    expect(CHART_TOOLTIP_OPEN_DELAY_MS).toBe(200);

    ctrl.pointerEnter();
    advance(199);
    expect(ctrl.isVisible()).toBe(false);
    advance(1);
    expect(ctrl.isVisible()).toBe(true);

    ctrl.pointerLeave();
    expect(ctrl.isVisible()).toBe(false);

    advance(350);
    ctrl.pointerEnter();
    expect(ctrl.isVisible()).toBe(true);

    ctrl.pointerLeave();
    advance(401);
    ctrl.pointerEnter();
    expect(ctrl.isVisible()).toBe(false);
    advance(200);
    expect(ctrl.isVisible()).toBe(true);

    ctrl.dispose();
    expect(pendingCount()).toBe(0);
  });
});
