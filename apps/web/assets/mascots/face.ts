import type { MascotSpec } from "./spec.ts";
import { pathBounds, pathOutline, type Point } from "./svg-path.ts";

/**
 * Where the face sits on the body. The source drawings put each face high on the right of its
 * blob and tilt it up toward that corner, so at rest every mascot reads as glancing up and to the
 * right (Frank, 2026-10-23). The scene moves the face toward the middle of the body's round mass
 * (all the way across, a little way down, so it stays in the head) and turns it most of the way
 * level, so a mascot at rest looks at the viewer. The face's own drawing is unchanged: the move
 * and the turn place the whole face, eyes, brows, mouth and sweat drop together. The move stops
 * short where it would bring the face within `CLEARANCE` of an accessory drawn over the body
 * that the source kept it clear of (green's sparkle).
 */
const TOWARD_CENTRE = { x: 1, y: 0.3 };

/** The share of the eyes' tilt the turn takes away. */
const LEVEL = 0.65;

/** The share of an idle mouth's sideways offset from the eyes' middle that the line mouth of the
 * other activities keeps: most of the way under the eyes, a hint of the drawing's side, since a
 * line off to one side tips the face toward it. */
export const MOUTH_OFFSET_KEPT = 0.3;

/** The room kept between the face's lines and a front accessory's edge, source units. */
const CLEARANCE = 1;

export interface FacePlacement {
  /** How far the face moves, source units. */
  shift: Point;
  /** How far it turns around its own origin, radians (clockwise, as Rive turns). */
  rotation: number;
}

/** Turns `p` by `angle` radians around the origin, as Rive turns a child. */
export function turn(p: Point, angle: number): Point {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}

/** Whether `p` lies inside the closed outline `polygon` (even-odd). */
export function inside(p: Point, polygon: Point[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] as Point;
    const [xj, yj] = polygon[j] as Point;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function distanceToEdge(p: Point, polygon: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Point;
    const b = polygon[(i + 1) % polygon.length] as Point;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
    );
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

/** The centre of the body's round mass: the centre of the largest circle inside it, so a tail,
 * an ear or a tuft does not pull it off the head. */
export function bodyCentre(spec: MascotSpec): Point {
  const polygon = pathOutline(spec.body.d, 8).flat();
  const b = pathBounds(spec.body.d);
  const STEP = 0.1;
  let best = { distance: -1, at: [0, 0] as Point };
  for (let x = b.minX; x <= b.maxX; x += STEP) {
    for (let y = b.minY; y <= b.maxY; y += STEP) {
      const p: Point = [x, y];
      if (!inside(p, polygon)) continue;
      const distance = distanceToEdge(p, polygon);
      if (distance > best.distance) best = { distance, at: p };
    }
  }
  return best.at;
}

/** The point the face is drawn around: between the eyes and a little below. */
export function faceOrigin(spec: MascotSpec): Point {
  const { l, r } = spec.eyes;
  return [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2 + 1.5];
}

/** Points along the face's drawing: both eyes' rims and the idle mouth. */
function facePoints(spec: MascotSpec): Point[] {
  const { l, r, radius } = spec.eyes;
  const rim = (c: Point): Point[] =>
    Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * 2 * Math.PI;
      return [c[0] + radius * Math.cos(a), c[1] + radius * Math.sin(a)] as Point;
    });
  return [...rim(l), ...rim(r), ...spec.mouth.flatMap((p) => pathOutline(p.d, 8).flat())];
}

function gap(a: Point[], b: Point[]): number {
  let best = Infinity;
  for (const p of a) for (const q of b) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
  return best;
}

/** The face's points placed: turned around its origin, then moved. */
function placed(points: Point[], origin: Point, shift: Point, rotation: number): Point[] {
  return points.map((p) => {
    const t = turn([p[0] - origin[0], p[1] - origin[1]], rotation);
    return [origin[0] + t[0] + shift[0], origin[1] + t[1] + shift[1]] as Point;
  });
}

/** The longest part of `shift` that keeps the face `CLEARANCE` from every front accessory part
 * the source keeps it that far from. */
function clearShift(spec: MascotSpec, shift: Point, rotation: number): Point {
  const face = facePoints(spec);
  const origin = faceOrigin(spec);
  const parts = spec.front
    .flatMap((a) => a.parts.map((p) => pathOutline(p.d, 8).flat()))
    .filter((part) => gap(face, part) >= CLEARANCE);
  for (let k = 1; k > 0; k -= 0.05) {
    const step: Point = [shift[0] * k, shift[1] * k];
    const moved = placed(face, origin, step, rotation);
    if (parts.every((part) => gap(moved, part) >= CLEARANCE)) return step;
  }
  return [0, 0];
}

export function facePlacement(spec: MascotSpec): FacePlacement {
  const { l, r } = spec.eyes;
  const body = bodyCentre(spec);
  const face = facePoints(spec);
  const xs = face.map((p) => p[0]);
  const ys = face.map((p) => p[1]);
  const centre: Point = [
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (Math.min(...ys) + Math.max(...ys)) / 2,
  ];
  const toward: Point = [
    (body[0] - centre[0]) * TOWARD_CENTRE.x,
    (body[1] - centre[1]) * TOWARD_CENTRE.y,
  ];
  const rotation = -Math.atan2(r[1] - l[1], r[0] - l[0]) * LEVEL;
  return { shift: clearShift(spec, toward, rotation), rotation };
}
