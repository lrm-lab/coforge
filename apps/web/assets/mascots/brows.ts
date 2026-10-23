import type { MascotActivity } from "#src/features/agents/mascot-rive-contract";
import { argb } from "./color.ts";
import { nextId } from "./contract.ts";
import { fmt, type Point } from "./svg-path.ts";
import { still, track, type Tracks } from "./timeline.ts";

/**
 * The brows: two short strokes over the eyes whose two vertices every activity keys, so one brow
 * can arch while the other stays put. Error shows both worried (inner ends up); thinking shows
 * the left one level and the right one raised in an arch, toward the thought bubble; the other
 * activities hide them. Positions are relative to each eye's resting centre.
 */
interface Brow {
  a: Point;
  b: Point;
  /** How far the stroke bows upward between its ends. */
  arch: number;
}

const WORRIED: Record<"L" | "R", Brow> = {
  L: { a: [-1.1, -1.85], b: [1.1, -2.95], arch: 0 },
  R: { a: [-1.1, -2.9], b: [1.1, -1.8], arch: 0 },
};

const PONDERING: Record<"L" | "R", Brow> = {
  L: { a: [-1, -2.5], b: [1, -2.65], arch: 0.1 },
  R: { a: [-1, -2.85], b: [1.15, -3], arch: 0.45 },
};

export interface BrowRig {
  side: Record<"L" | "R", { shape: string; vertices: [string, string] }>;
}

const shown = (state: MascotActivity): number =>
  state === "error" || state === "thinking" ? 1 : 0;
const pose = (state: MascotActivity): Record<"L" | "R", Brow> =>
  state === "thinking" ? PONDERING : WORRIED;

function ends(brow: Brow): { a: Point; b: Point; out: Point; in: Point } {
  const third: Point = [(brow.b[0] - brow.a[0]) / 3, (brow.b[1] - brow.a[1]) / 3];
  return {
    a: brow.a,
    b: brow.b,
    out: [third[0], third[1] - brow.arch],
    in: [-third[0], -third[1] - brow.arch],
  };
}

const angle = (h: Point): number => Math.atan2(h[1], h[0]);
const length = (h: Point): number => Math.hypot(h[0], h[1]);

export function allocateBrows(): BrowRig {
  const side = () => ({ shape: nextId(), vertices: [nextId(), nextId()] as [string, string] });
  return { side: { L: side(), R: side() } };
}

export function browXml(rig: BrowRig, side: "L" | "R", eye: Point, color: string): string {
  const { a, b, out, in: inH } = ends(WORRIED[side]);
  const [v0, v1] = rig.side[side].vertices;
  return (
    `<Shape x="${fmt(eye[0])}" y="${fmt(eye[1])}" opacity="0" name="Brow ${side}" id="${rig.side[side].shape}">` +
    `<PointsPath isClosed="false" name="Path">` +
    `<CubicDetachedVertex x="${fmt(a[0])}" y="${fmt(a[1])}" inRotation="${fmt(angle(out) + Math.PI)}" inDistance="0" outRotation="${fmt(angle(out))}" outDistance="${fmt(length(out))}" id="${v0}"/>` +
    `<CubicDetachedVertex x="${fmt(b[0])}" y="${fmt(b[1])}" inRotation="${fmt(angle(inH))}" inDistance="${fmt(length(inH))}" outRotation="${fmt(angle(inH) + Math.PI)}" outDistance="0" id="${v1}"/>` +
    `</PointsPath><Stroke thickness="0.85" cap="round" join="round" name="Stroke">` +
    `<SolidColor colorValue="${argb(color)}" name="Color"/></Stroke></Shape>`
  );
}

export function browTracks(tracks: Tracks, rig: BrowRig, state: MascotActivity): void {
  for (const side of ["L", "R"] as const) {
    const { shape, vertices } = rig.side[side];
    const { a, b, out, in: inH } = ends(pose(state)[side]);
    track(tracks, shape, "opacity", still(shown(state)));
    track(tracks, vertices[0], "x", still(a[0]));
    track(tracks, vertices[0], "y", still(a[1]));
    track(tracks, vertices[0], "outRotation", still(angle(out)));
    track(tracks, vertices[0], "outDistance", still(length(out)));
    track(tracks, vertices[1], "x", still(b[0]));
    track(tracks, vertices[1], "y", still(b[1]));
    track(tracks, vertices[1], "inRotation", still(angle(inH)));
    track(tracks, vertices[1], "inDistance", still(length(inH)));
  }
}
