export const CASCADE_MENU_TIMINGS = {
  OPEN_DELAY_MS: 220,
  DRAG_OPEN_DELAY_MS: 420,
  SAFE_ZONE_RECHECK_MS: 80,
  SAFE_WINDOW_MAX_MS: 1200,
  CLOSE_DELAY_MS: 360,
  LEVEL_OPACITY_MS: 170,
  LEVEL_TRANSFORM_MS: 360,
  FOLDER_MORPH_MS: 460,
  THEME_TRANSITION_MS: 500,
} as const;

export const CASCADE_MENU_GEOMETRY = {
  SUBMENU_OVERLAP_PX: 8,
  LEVEL_PADDING_PX: 6,
  ROW_HEIGHT_PX: 32,
  ROW_GAP_PX: 4,
  LEVEL_MIN_WIDTH_PX: 210,
  LEVEL_MAX_WIDTH_PX: 260,
  LEVEL_MAX_HEIGHT_PX: 420,
  VIEWPORT_MARGIN_PX: 12,
  SAFE_BAND_MIN_PX: 56,
  SAFE_BAND_MAX_PX: 90,
  SAFE_BAND_RATIO: 0.43,
} as const;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface RectLike {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export type SubmenuSide = "right" | "left";

export interface SafeZoneTriangle {
  readonly apex: Point;
  readonly edgeTop: Point;
  readonly edgeBottom: Point;
  readonly side: SubmenuSide;
  readonly bandStart: number;
  readonly bandEnd: number;
}

export interface PointerTrail {
  readonly previous: Point | null;
  readonly current: Point | null;
}

export interface SubmenuPosition {
  readonly left: number;
  readonly top: number;
  readonly side: SubmenuSide;
}

const DEGENERATE_AREA_EPSILON = 1e-6;

export function pointInRect(point: Point, rect: RectLike): boolean {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}

export function crossProduct(a: Point, b: Point, p: Point): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

export function pointInTriangle(point: Point, a: Point, b: Point, c: Point): boolean {
  if (Math.abs(crossProduct(a, b, c)) < DEGENERATE_AREA_EPSILON) {
    return false;
  }
  const d1 = crossProduct(a, b, point);
  const d2 = crossProduct(b, c, point);
  const d3 = crossProduct(c, a, point);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

export function computeSafeBandWidth(parentWidth: number): number {
  return Math.min(
    CASCADE_MENU_GEOMETRY.SAFE_BAND_MAX_PX,
    Math.max(
      CASCADE_MENU_GEOMETRY.SAFE_BAND_MIN_PX,
      parentWidth * CASCADE_MENU_GEOMETRY.SAFE_BAND_RATIO,
    ),
  );
}

export function pushPointerPoint(trail: PointerTrail, next: Point): PointerTrail {
  if (trail.current && trail.current.x === next.x && trail.current.y === next.y) {
    return trail;
  }
  return {
    previous: trail.current,
    current: next,
  };
}

export function getSafeZoneApex(trail: PointerTrail): Point | null {
  return trail.previous;
}

export function resolveSubmenuSide(parentRect: RectLike, submenuRect: RectLike): SubmenuSide {
  const parentCenterX = (parentRect.left + parentRect.right) / 2;
  const submenuCenterX = (submenuRect.left + submenuRect.right) / 2;
  return submenuCenterX < parentCenterX ? "left" : "right";
}

export function buildSafeZone(
  apex: Point,
  parentRect: RectLike,
  submenuRect: RectLike,
  side?: SubmenuSide,
): SafeZoneTriangle {
  const resolvedSide = side ?? resolveSubmenuSide(parentRect, submenuRect);
  const bandWidth = computeSafeBandWidth(parentRect.width);
  if (resolvedSide === "left") {
    return {
      apex,
      edgeTop: { x: submenuRect.right, y: submenuRect.top },
      edgeBottom: { x: submenuRect.right, y: submenuRect.bottom },
      side: "left",
      bandStart: parentRect.left,
      bandEnd: parentRect.left + bandWidth,
    };
  }
  return {
    apex,
    edgeTop: { x: submenuRect.left, y: submenuRect.top },
    edgeBottom: { x: submenuRect.left, y: submenuRect.bottom },
    side: "right",
    bandStart: parentRect.right - bandWidth,
    bandEnd: parentRect.right,
  };
}

export function isPointInSafeBand(
  point: Point,
  parentRect: RectLike,
  zone: SafeZoneTriangle,
): boolean {
  return (
    point.y >= parentRect.top &&
    point.y <= parentRect.bottom &&
    point.x >= zone.bandStart &&
    point.x <= zone.bandEnd
  );
}

export function isPointInSafeZone(
  point: Point,
  parentRect: RectLike,
  submenuRect: RectLike,
  zone: SafeZoneTriangle,
): boolean {
  if (pointInRect(point, submenuRect)) {
    return false;
  }
  return (
    isPointInSafeBand(point, parentRect, zone) &&
    pointInTriangle(point, zone.apex, zone.edgeTop, zone.edgeBottom)
  );
}

export function isPointInMenuOrBridge(
  point: Point,
  rects: readonly RectLike[],
  safeZones: readonly SafeZoneTriangle[],
): boolean {
  for (const rect of rects) {
    if (pointInRect(point, rect)) {
      return true;
    }
  }
  for (const zone of safeZones) {
    if (pointInTriangle(point, zone.apex, zone.edgeTop, zone.edgeBottom)) {
      return true;
    }
  }
  return false;
}

export function computeSubmenuPosition(
  parentRect: RectLike,
  rowRect: RectLike,
  submenuWidth: number,
  submenuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  titleOffsetY = 0,
): SubmenuPosition {
  const { SUBMENU_OVERLAP_PX, LEVEL_PADDING_PX, VIEWPORT_MARGIN_PX } = CASCADE_MENU_GEOMETRY;
  const rightLeft = parentRect.right - SUBMENU_OVERLAP_PX;
  const leftLeft = parentRect.left + SUBMENU_OVERLAP_PX - submenuWidth;

  let side: SubmenuSide;
  let left: number;
  if (rightLeft + submenuWidth <= viewportWidth - VIEWPORT_MARGIN_PX) {
    side = "right";
    left = rightLeft;
  } else if (leftLeft >= VIEWPORT_MARGIN_PX) {
    side = "left";
    left = leftLeft;
  } else {
    const spaceRight = viewportWidth - VIEWPORT_MARGIN_PX - rightLeft;
    const spaceLeft = parentRect.left + SUBMENU_OVERLAP_PX - VIEWPORT_MARGIN_PX;
    if (spaceLeft > spaceRight) {
      side = "left";
      left = Math.max(VIEWPORT_MARGIN_PX, leftLeft);
    } else {
      side = "right";
      left = Math.max(
        VIEWPORT_MARGIN_PX,
        Math.min(rightLeft, viewportWidth - VIEWPORT_MARGIN_PX - submenuWidth),
      );
    }
  }

  const desiredTop = rowRect.top - LEVEL_PADDING_PX - titleOffsetY;
  const maxTop = Math.max(VIEWPORT_MARGIN_PX, viewportHeight - VIEWPORT_MARGIN_PX - submenuHeight);
  const top = Math.max(VIEWPORT_MARGIN_PX, Math.min(desiredTop, maxTop));

  return { left, top, side };
}
