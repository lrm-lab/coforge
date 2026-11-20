import { describe, expect, test } from "bun:test";
import {
  INLINE_DEFAULT_HEIGHT_PX,
  INLINE_MAX_HEIGHT_PX,
  INLINE_MIN_HEIGHT_PX,
  clampInlineFrameHeight,
  nextInlineFrameHeight,
} from "#src/features/artifacts/artifact-page-theme";
import {
  INLINE_EMBED_MAX_ACTIVE,
  createInlineEmbedPool,
} from "#src/features/artifacts/inline-embed-pool";

describe("inline embed LRU pool", () => {
  test("activates visible slots up to the limit and evicts off-screen slots first", () => {
    const pool = createInlineEmbedPool(2);
    pool.setVisible("m1", true);
    pool.setVisible("m2", true);
    expect(pool.isActive("m1")).toBe(true);
    expect(pool.isActive("m2")).toBe(true);

    pool.setVisible("m1", false);
    expect(pool.isActive("m1")).toBe(true);

    pool.setVisible("m3", true);
    expect(pool.isActive("m1")).toBe(false);
    expect(pool.isActive("m2")).toBe(true);
    expect(pool.isActive("m3")).toBe(true);
  });

  test("evicts least recently used visible slot when all active slots remain in view", () => {
    const pool = createInlineEmbedPool(2);
    pool.setVisible("m1", true);
    pool.setVisible("m2", true);
    pool.setVisible("m1", true);
    pool.setVisible("m3", true);
    expect(pool.isActive("m1")).toBe(true);
    expect(pool.isActive("m2")).toBe(false);
    expect(pool.isActive("m3")).toBe(true);
  });

  test("releases slots on unmount and notifies subscribers only when state changes", () => {
    const pool = createInlineEmbedPool(INLINE_EMBED_MAX_ACTIVE);
    let notifications = 0;
    const unsubscribe = pool.subscribe(() => {
      notifications += 1;
    });
    pool.setVisible("m1", true);
    pool.setVisible("m1", true);
    expect(notifications).toBe(1);
    pool.release("m1");
    expect(pool.isActive("m1")).toBe(false);
    expect(notifications).toBe(2);
    unsubscribe();
    pool.setVisible("m2", true);
    expect(notifications).toBe(2);
  });

  test("remembers clamped heights per artifact version key with bounded capacity", () => {
    const pool = createInlineEmbedPool(2, 2);
    pool.rememberHeight("a1:1", 40);
    expect(pool.cachedHeight("a1:1")).toBe(INLINE_MIN_HEIGHT_PX);
    pool.rememberHeight("a2:1", 2000);
    expect(pool.cachedHeight("a2:1")).toBe(INLINE_MAX_HEIGHT_PX);
    pool.rememberHeight("a3:1", 320);
    expect(pool.cachedHeight("a1:1")).toBeUndefined();
    expect(pool.cachedHeight("a2:1")).toBe(INLINE_MAX_HEIGHT_PX);
    expect(pool.cachedHeight("a3:1")).toBe(320);
  });

  test("clamps invalid heights to default and valid heights within bounds", () => {
    expect(clampInlineFrameHeight(Number.NaN)).toBe(INLINE_DEFAULT_HEIGHT_PX);
    expect(clampInlineFrameHeight(0)).toBe(INLINE_DEFAULT_HEIGHT_PX);
    expect(clampInlineFrameHeight(50)).toBe(INLINE_MIN_HEIGHT_PX);
    expect(clampInlineFrameHeight(340.2)).toBe(341);
    expect(clampInlineFrameHeight(5000)).toBe(INLINE_MAX_HEIGHT_PX);
  });

  test("default pool keeps 16 loaded embeds mounted across scrolls and evicts off-screen slots on the 17th", () => {
    expect(INLINE_EMBED_MAX_ACTIVE).toBe(16);
    const pool = createInlineEmbedPool();
    for (let i = 1; i <= 16; i++) {
      pool.setVisible(`m${i}`, true);
      if (i <= 12) pool.setVisible(`m${i}`, false);
    }
    for (let i = 1; i <= 16; i++) expect(pool.isActive(`m${i}`)).toBe(true);
    pool.setVisible("m17", true);
    expect(pool.isActive("m1")).toBe(false);
    expect(pool.isActive("m17")).toBe(true);
    for (let i = 2; i <= 16; i++) expect(pool.isActive(`m${i}`)).toBe(true);
  });

  test("monotonic inline height fits initial compact cards, prevents tab-switch shrink jitter, and resets when host width changes", () => {
    let state = {
      height: INLINE_DEFAULT_HEIGHT_PX,
      settled: false,
      hostWidth: null as number | null,
    };
    state = nextInlineFrameHeight(state, 140, 896);
    expect(state).toEqual({ height: 140, settled: true, hostWidth: 896 });

    state = nextInlineFrameHeight(state, 510, 896);
    expect(state).toEqual({ height: 510, settled: true, hostWidth: 896 });

    state = nextInlineFrameHeight(state, 390, 896);
    expect(state).toEqual({ height: 510, settled: true, hostWidth: 896 });

    state = nextInlineFrameHeight(state, 390, 895);
    expect(state).toEqual({ height: 510, settled: true, hostWidth: 896 });

    state = nextInlineFrameHeight(state, 390, 893);
    expect(state).toEqual({ height: 390, settled: true, hostWidth: 893 });

    state = nextInlineFrameHeight(state, 620, 420);
    expect(state).toEqual({ height: 620, settled: true, hostWidth: 420 });

    state = nextInlineFrameHeight(state, 390, 896);
    expect(state).toEqual({ height: 390, settled: true, hostWidth: 896 });

    expect(nextInlineFrameHeight(state, 0, 896)).toEqual(state);
    expect(nextInlineFrameHeight(state, Number.NaN, 896)).toEqual(state);
  });
});
