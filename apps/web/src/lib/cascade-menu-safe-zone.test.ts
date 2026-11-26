import { describe, expect, test } from "bun:test";
import {
  buildSafeZone,
  CASCADE_MENU_GEOMETRY,
  CASCADE_MENU_TIMINGS,
  computeSafeBandWidth,
  crossProduct,
  evaluateSafeWindowTick,
  getSafeZoneApex,
  isPointInMenuOrBridge,
  isPointInSafeBand,
  isPointInSafeZone,
  pointInRect,
  pointInTriangle,
  pushPointerPoint,
  resolveSubmenuSide,
} from "./cascade-menu-safe-zone";

describe("CASCADE_MENU_TIMINGS", () => {
  test("pins the required delay and motion constants", () => {
    expect(CASCADE_MENU_TIMINGS.OPEN_DELAY_MS).toBe(250);
    expect(CASCADE_MENU_TIMINGS.DRAG_OPEN_DELAY_MS).toBe(420);
    expect(CASCADE_MENU_TIMINGS.SAFE_ZONE_RECHECK_MS).toBe(80);
    expect(CASCADE_MENU_TIMINGS.SAFE_WINDOW_MAX_MS).toBe(1200);
    expect(CASCADE_MENU_TIMINGS.CLOSE_DELAY_MS).toBe(300);
    expect(CASCADE_MENU_TIMINGS.LEVEL_OPACITY_MS).toBe(150);
    expect(CASCADE_MENU_TIMINGS.LEVEL_TRANSFORM_MS).toBe(180);
    expect(CASCADE_MENU_TIMINGS.LEVEL_EXIT_MS).toBe(120);
    expect(CASCADE_MENU_TIMINGS.FOLDER_MORPH_MS).toBe(460);
    expect(CASCADE_MENU_TIMINGS.THEME_TRANSITION_MS).toBe(500);
  });

  test("pins the required geometry constants", () => {
    expect(CASCADE_MENU_GEOMETRY.SUBMENU_OVERLAP_PX).toBe(8);
    expect(CASCADE_MENU_GEOMETRY.SAFE_BAND_MIN_PX).toBe(56);
    expect(CASCADE_MENU_GEOMETRY.SAFE_BAND_MAX_PX).toBe(90);
    expect(CASCADE_MENU_GEOMETRY.SAFE_BAND_RATIO).toBe(0.43);
  });
});

describe("pointInTriangle", () => {
  const a = { x: 100, y: 100 };
  const b = { x: 200, y: 50 };
  const c = { x: 200, y: 250 };

  test("returns true for interior points regardless of winding order", () => {
    expect(pointInTriangle({ x: 150, y: 120 }, a, b, c)).toBe(true);
    expect(pointInTriangle({ x: 150, y: 120 }, a, c, b)).toBe(true);
  });

  test("returns true for points on triangle edges and vertices", () => {
    expect(pointInTriangle({ x: 100, y: 100 }, a, b, c)).toBe(true);
    expect(pointInTriangle({ x: 200, y: 150 }, a, b, c)).toBe(true);
    expect(pointInTriangle({ x: 150, y: 75 }, a, b, c)).toBe(true);
  });

  test("returns false for exterior points", () => {
    expect(pointInTriangle({ x: 99, y: 100 }, a, b, c)).toBe(false);
    expect(pointInTriangle({ x: 150, y: 40 }, a, b, c)).toBe(false);
    expect(pointInTriangle({ x: 150, y: 260 }, a, b, c)).toBe(false);
    expect(pointInTriangle({ x: 205, y: 120 }, a, b, c)).toBe(false);
  });

  test("returns false for degenerate zero-area triangles", () => {
    expect(
      pointInTriangle(
        { x: 150, y: 100 },
        { x: 100, y: 100 },
        { x: 150, y: 100 },
        { x: 200, y: 100 },
      ),
    ).toBe(false);
  });

  test("crossProduct signs flip across an edge", () => {
    expect(crossProduct(a, b, { x: 150, y: 120 })).toBeGreaterThan(0);
    expect(crossProduct(a, b, { x: 150, y: 40 })).toBeLessThan(0);
  });
});

describe("computeSafeBandWidth", () => {
  test("clamps 43% of parent width between 56px and 90px", () => {
    expect(computeSafeBandWidth(100)).toBe(56);
    expect(computeSafeBandWidth(160)).toBeCloseTo(68.8, 5);
    expect(computeSafeBandWidth(220)).toBe(90);
    expect(computeSafeBandWidth(260)).toBe(90);
  });
});

describe("pointer trail", () => {
  test("keeps the older of the last two distinct pointermove positions as apex", () => {
    let trail = pushPointerPoint({ previous: null, current: null }, { x: 10, y: 20 });
    expect(getSafeZoneApex(trail)).toBeNull();

    trail = pushPointerPoint(trail, { x: 30, y: 40 });
    expect(getSafeZoneApex(trail)).toEqual({ x: 10, y: 20 });

    trail = pushPointerPoint(trail, { x: 30, y: 40 });
    expect(getSafeZoneApex(trail)).toEqual({ x: 10, y: 20 });

    trail = pushPointerPoint(trail, { x: 50, y: 60 });
    expect(getSafeZoneApex(trail)).toEqual({ x: 30, y: 40 });
  });
});

describe("safe zone right and left placement", () => {
  const parentRect = { left: 100, right: 320, top: 100, bottom: 300, width: 220, height: 200 };
  const rightSubmenuRect = {
    left: 312,
    right: 532,
    top: 120,
    bottom: 280,
    width: 220,
    height: 160,
  };
  const leftSubmenuRect = {
    left: -112,
    right: 108,
    top: 120,
    bottom: 280,
    width: 220,
    height: 160,
  };

  test("resolves submenu side even with 8px overlap", () => {
    expect(resolveSubmenuSide(parentRect, rightSubmenuRect)).toBe("right");
    expect(resolveSubmenuSide(parentRect, leftSubmenuRect)).toBe("left");
  });

  test("uses submenu left edge and parent right band for right-side submenus", () => {
    const zone = buildSafeZone({ x: 240, y: 150 }, parentRect, rightSubmenuRect);
    expect(zone.side).toBe("right");
    expect(zone.edgeTop).toEqual({ x: 312, y: 120 });
    expect(zone.edgeBottom).toEqual({ x: 312, y: 280 });
    expect(zone.bandStart).toBe(230);
    expect(zone.bandEnd).toBe(320);

    expect(isPointInSafeZone({ x: 280, y: 170 }, parentRect, rightSubmenuRect, zone)).toBe(true);
    expect(isPointInSafeZone({ x: 220, y: 170 }, parentRect, rightSubmenuRect, zone)).toBe(false);
    expect(isPointInSafeZone({ x: 350, y: 170 }, parentRect, rightSubmenuRect, zone)).toBe(false);
  });

  test("uses submenu right edge and parent left band for flipped left-side submenus", () => {
    const zone = buildSafeZone({ x: 180, y: 150 }, parentRect, leftSubmenuRect);
    expect(zone.side).toBe("left");
    expect(zone.edgeTop).toEqual({ x: 108, y: 120 });
    expect(zone.edgeBottom).toEqual({ x: 108, y: 280 });
    expect(zone.bandStart).toBe(100);
    expect(zone.bandEnd).toBe(190);

    expect(isPointInSafeZone({ x: 140, y: 170 }, parentRect, leftSubmenuRect, zone)).toBe(true);
    expect(isPointInSafeZone({ x: 200, y: 170 }, parentRect, leftSubmenuRect, zone)).toBe(false);
    expect(isPointInSafeZone({ x: 90, y: 170 }, parentRect, leftSubmenuRect, zone)).toBe(false);
  });

  test("ends protection once pointer enters open submenu", () => {
    const zone = buildSafeZone({ x: 240, y: 150 }, parentRect, rightSubmenuRect);
    expect(pointInRect({ x: 315, y: 160 }, rightSubmenuRect)).toBe(true);
    expect(isPointInSafeBand({ x: 315, y: 160 }, parentRect, zone)).toBe(true);
    expect(isPointInSafeZone({ x: 315, y: 160 }, parentRect, rightSubmenuRect, zone)).toBe(false);
  });

  test("keeps close protection inside anchor, levels, or safe-zone triangle", () => {
    const anchorRect = { left: 100, right: 180, top: 60, bottom: 92, width: 80, height: 32 };
    const zone = buildSafeZone({ x: 240, y: 150 }, parentRect, rightSubmenuRect);

    expect(isPointInMenuOrBridge({ x: 120, y: 70 }, [anchorRect, parentRect], [zone])).toBe(true);
    expect(isPointInMenuOrBridge({ x: 280, y: 170 }, [anchorRect, parentRect], [zone])).toBe(true);
    expect(isPointInMenuOrBridge({ x: 50, y: 50 }, [anchorRect, parentRect], [zone])).toBe(false);
  });
});

describe("evaluateSafeWindowTick", () => {
  const parentRect = { left: 100, right: 320, top: 100, bottom: 300, width: 220, height: 200 };
  const submenuRect = { left: 312, right: 532, top: 120, bottom: 280, width: 220, height: 160 };
  const zone = buildSafeZone({ x: 240, y: 150 }, parentRect, submenuRect);

  test("waits while the pointer remains inside the safe zone before the max window expires", () => {
    expect(evaluateSafeWindowTick({ x: 280, y: 170 }, parentRect, submenuRect, zone, 240)).toBe(
      "wait",
    );
  });

  test("commits once the safe window reaches 1200ms while still on the parent menu", () => {
    expect(
      evaluateSafeWindowTick(
        { x: 280, y: 170 },
        parentRect,
        submenuRect,
        zone,
        CASCADE_MENU_TIMINGS.SAFE_WINDOW_MAX_MS,
      ),
    ).toBe("commit");
  });

  test("commits immediately when the pointer leaves the safe zone onto the parent menu", () => {
    expect(evaluateSafeWindowTick({ x: 200, y: 170 }, parentRect, submenuRect, zone, 80)).toBe(
      "commit",
    );
  });

  test("cancels when the pointer reaches the open submenu", () => {
    expect(evaluateSafeWindowTick({ x: 350, y: 170 }, parentRect, submenuRect, zone, 80)).toBe(
      "cancel",
    );
  });

  test("cancels instead of committing when the pointer leaves the parent menu", () => {
    expect(evaluateSafeWindowTick({ x: 60, y: 170 }, parentRect, submenuRect, zone, 80)).toBe(
      "cancel",
    );
    expect(evaluateSafeWindowTick({ x: 280, y: 340 }, parentRect, submenuRect, zone, 1500)).toBe(
      "cancel",
    );
    expect(evaluateSafeWindowTick(null, parentRect, submenuRect, zone, 1500)).toBe("cancel");
  });
});
