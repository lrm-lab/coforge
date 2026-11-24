import { expect, test } from "bun:test";

import {
  FOOT_BAR_HOLD_MS,
  createFootBarFoldState,
  flushFootBarPending,
  openFootBarNow,
  setFootBarFocus,
  stepFootBarScroll,
} from "#src/lib/foot-bar-fold";

const VP = 700;
const MAX = 2000;

test("folds after 8px consecutive downward scroll and opens after 8px upward scroll", () => {
  let s = createFootBarFoldState();
  s = stepFootBarScroll(s, { scrollTop: 100, maxScrollTop: MAX, viewportHeight: VP, now: 0 });
  expect(s.folded).toBe(false);

  s = stepFootBarScroll(s, { scrollTop: 105, maxScrollTop: MAX, viewportHeight: VP, now: 50 });
  expect(s.folded).toBe(false);

  s = stepFootBarScroll(s, { scrollTop: 108, maxScrollTop: MAX, viewportHeight: VP, now: 100 });
  expect(s.folded).toBe(true);

  s = stepFootBarScroll(s, {
    scrollTop: 100,
    maxScrollTop: MAX,
    viewportHeight: VP,
    now: 100 + FOOT_BAR_HOLD_MS,
  });
  expect(s.folded).toBe(false);
});

test("opens whenever within 48px of the top", () => {
  let s = createFootBarFoldState();
  s = stepFootBarScroll(s, { scrollTop: 120, maxScrollTop: MAX, viewportHeight: VP, now: 0 });
  s = stepFootBarScroll(s, { scrollTop: 140, maxScrollTop: MAX, viewportHeight: VP, now: 50 });
  expect(s.folded).toBe(true);

  s = stepFootBarScroll(s, {
    scrollTop: 48,
    maxScrollTop: MAX,
    viewportHeight: VP,
    now: 50 + FOOT_BAR_HOLD_MS,
  });
  expect(s.folded).toBe(false);
});

test("ignores jumps larger than a screen and overscroll bounce past either end", () => {
  let s = createFootBarFoldState();
  s = stepFootBarScroll(s, { scrollTop: 100, maxScrollTop: MAX, viewportHeight: VP, now: 0 });

  s = stepFootBarScroll(s, { scrollTop: 950, maxScrollTop: MAX, viewportHeight: VP, now: 50 });
  expect(s.folded).toBe(false);

  s = stepFootBarScroll(s, { scrollTop: MAX + 20, maxScrollTop: MAX, viewportHeight: VP, now: 80 });
  expect(s.folded).toBe(false);

  s = stepFootBarScroll(s, { scrollTop: -12, maxScrollTop: MAX, viewportHeight: VP, now: 100 });
  expect(s.folded).toBe(false);
});

test("holds a fold for 320ms and applies only the latest pending change once unlocked", () => {
  let s = createFootBarFoldState();
  s = stepFootBarScroll(s, { scrollTop: 100, maxScrollTop: MAX, viewportHeight: VP, now: 0 });
  s = stepFootBarScroll(s, { scrollTop: 120, maxScrollTop: MAX, viewportHeight: VP, now: 100 });
  expect(s.folded).toBe(true);

  s = stepFootBarScroll(s, { scrollTop: 100, maxScrollTop: MAX, viewportHeight: VP, now: 200 });
  expect(s.folded).toBe(true);
  expect(s.pendingFolded).toBe(false);

  s = stepFootBarScroll(s, { scrollTop: 120, maxScrollTop: MAX, viewportHeight: VP, now: 250 });
  expect(s.folded).toBe(true);
  expect(s.pendingFolded).toBeNull();

  s = stepFootBarScroll(s, { scrollTop: 100, maxScrollTop: MAX, viewportHeight: VP, now: 300 });
  expect(s.pendingFolded).toBe(false);
  s = flushFootBarPending(s, 100 + FOOT_BAR_HOLD_MS);
  expect(s.folded).toBe(false);
});

test("opens on tap and refuses to fold while holding keyboard focus", () => {
  let s = createFootBarFoldState();
  s = stepFootBarScroll(s, { scrollTop: 100, maxScrollTop: MAX, viewportHeight: VP, now: 0 });
  s = stepFootBarScroll(s, { scrollTop: 120, maxScrollTop: MAX, viewportHeight: VP, now: 100 });
  expect(s.folded).toBe(true);

  s = openFootBarNow(s, 150);
  expect(s.folded).toBe(false);

  s = setFootBarFocus(s, true, 500);
  s = stepFootBarScroll(s, { scrollTop: 300, maxScrollTop: MAX, viewportHeight: VP, now: 900 });
  expect(s.folded).toBe(false);

  s = setFootBarFocus(s, false, 950);
  s = stepFootBarScroll(s, { scrollTop: 320, maxScrollTop: MAX, viewportHeight: VP, now: 1000 });
  expect(s.folded).toBe(true);
});
