import { MASCOT_ACTIVITIES, type MascotActivity } from "#src/features/agents/mascot-rive-contract";
import { argb } from "./color.ts";
import { nextId } from "./contract.ts";
import type { Paint, Part } from "./spec.ts";
import { add, cubicAt, fmt, parseSvgPath, sub, type Point } from "./svg-path.ts";
import { still, track, type Tracks } from "./timeline.ts";

/**
 * The mouth morphs: one set of shapes whose vertices every activity keys, so changing activity
 * reshapes the mascot's own idle mouth (a grin, a kiss, a smile) into a small line and back
 * rather than fading one drawing into another. Each activity's line is a curve through three
 * points (`LinePose`: its middle raised or lowered, and for some a shorter, shifted, tilted line). The back part of the idle mouth
 * becomes the line: an open stroke spreads its vertices along it, a closed shape lies flat on it
 * and a stroke of the line's width (none while idle) draws it. Every other part (teeth, a tongue
 * band) folds onto the line and fades.
 */

/** Visible thickness of the line mouth. */
const LINE_WIDTH = 1.1;

export interface MouthLine {
  /** Centre of the line, relative to the face. */
  centre: Point;
  halfWidth: number;
  /** Rise of the line per unit of width, so it tilts like the eyes. */
  slope: number;
  /** Each activity's line. */
  poses: Record<Exclude<MascotActivity, "idle">, LinePose>;
}

export interface LinePose {
  /** How far the middle moves off the ends: down is a smile, up a frown. */
  mid: number;
  /** How far the whole line moves down (a frown sits lower, clear of a widened eye). */
  drop?: number;
  /** Its width as a share of the idle line's. */
  shrink?: number;
  /** How far it moves right. */
  shift?: number;
  /** Extra rise per unit of width: negative lifts the right end. */
  tilt?: number;
}

interface VertexPose {
  x: number;
  y: number;
  inRotation: number;
  inDistance: number;
  outRotation: number;
  outDistance: number;
}

interface MorphShape {
  id: string;
  vertexIds: string[];
  stroke?: { id: string; width: Record<MascotActivity, number> };
  opacity: Record<MascotActivity, number>;
  poses: Record<MascotActivity, VertexPose[]>;
}

export interface MouthRig {
  shapes: MorphShape[];
}

type Bezier = [Point, Point, Point, Point];
const len = (a: Point): number => Math.hypot(a[0], a[1]);
/** The line as one cubic through its ends and, at its half-way point, its middle. */
function lineCurve(line: MouthLine, pose: LinePose): Bezier {
  const cx = line.centre[0] + (pose.shift ?? 0);
  const cy = line.centre[1] + (pose.drop ?? 0);
  const half = line.halfWidth * (pose.shrink ?? 1);
  const slope = line.slope + (pose.tilt ?? 0);
  const l: Point = [cx - half, cy - half * slope];
  const r: Point = [cx + half, cy + half * slope];
  const q: Point = [2 * cx - (l[0] + r[0]) / 2, 2 * (cy + pose.mid) - (l[1] + r[1]) / 2];
  return [l, add(l, sub(q, l), 2 / 3), add(r, sub(q, r), 2 / 3), r];
}

function slopeAt([p0, p1, p2, p3]: Bezier, t: number): Point {
  const u = 1 - t;
  const term = (a: Point, b: Point, k: number): Point => [(b[0] - a[0]) * k, (b[1] - a[1]) * k];
  return add(add(term(p0, p1, 3 * u * u), term(p1, p2, 6 * u * t)), term(p2, p3, 3 * t * t));
}

const pointOn = (b: Bezier, t: number): Point => cubicAt(b[0], b[1], b[2], b[3], t);

/** A handle as Rive stores it: an angle and a distance from its vertex. */
const handle = (h: Point): [number, number] => [Math.atan2(h[1], h[0]), len(h)];

function pose(p: Point, inHandle: Point, outHandle: Point): VertexPose {
  const [inRotation, inDistance] = handle(inHandle);
  const [outRotation, outDistance] = handle(outHandle);
  return { x: p[0], y: p[1], inRotation, inDistance, outRotation, outDistance };
}

/** The source drawing's vertices, relative to `frame`. */
function sourcePoses(part: Part, frame: Point): { poses: VertexPose[]; closed: boolean } {
  const [path] = parseSvgPath(part.d);
  if (!path) throw new Error("a mouth part has no path");
  const poses = path.vertices.map((v) => {
    const p = sub(v.p, frame);
    return pose(
      p,
      v.inHandle ? sub(v.inHandle, v.p) : [0, 0],
      v.outHandle ? sub(v.outHandle, v.p) : [0, 0],
    );
  });
  return { poses, closed: path.closed };
}

/** A stroke along the line: the vertices spread evenly over it, each handle a third of its span. */
function strokeTarget(count: number, b: Bezier): VertexPose[] {
  const span = 1 / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => {
    const t = i * span;
    const d: Point = [(slopeAt(b, t)[0] * span) / 3, (slopeAt(b, t)[1] * span) / 3];
    return pose(pointOn(b, t), i > 0 ? [-d[0], -d[1]] : [0, 0], i < count - 1 ? d : [0, 0]);
  });
}

/**
 * A closed shape laid flat on the line: each vertex at the point of the line as far along it as
 * the vertex is across the shape, each handle the exact piece of the line to its neighbour, so the
 * outline runs along the line and back and a stroke of the line's width draws it.
 */
function collapseTarget(source: VertexPose[], b: Bezier): VertexPose[] {
  const xs = source.map((p) => p.x);
  const min = Math.min(...xs);
  const span = Math.max(...xs) - min || 1;
  const ts = source.map((p) => (p.x - min) / span);
  const n = ts.length;
  return ts.map((t, i) => {
    const d = slopeAt(b, t);
    const toNext = (ts[(i + 1) % n]! - t) / 3;
    const fromPrev = (t - ts[(i - 1 + n) % n]!) / 3;
    return pose(
      pointOn(b, t),
      [-d[0] * fromPrev, -d[1] * fromPrev],
      [d[0] * toNext, d[1] * toNext],
    );
  });
}

/** Folds every vertex onto the line under it, handles gone. */
function foldTarget(source: VertexPose[], b: Bezier): VertexPose[] {
  const [l, , , r] = b;
  return source.map((p) => {
    const t = Math.min(1, Math.max(0, (p.x - l[0]) / (r[0] - l[0])));
    return pose(pointOn(b, t), [0, 0], [0, 0]);
  });
}

/** Turns each target angle by whole turns to the nearest of the idle one, so the morph never
 * spins a handle the long way round; a handle of no length takes the other pose's angle. */
function settleAngles(idle: VertexPose[], target: VertexPose[]): void {
  const near = (angle: number, to: number): number =>
    angle + Math.round((to - angle) / (2 * Math.PI)) * 2 * Math.PI;
  target.forEach((t, i) => {
    const s = idle[i]!;
    for (const [rot, dist] of [
      ["inRotation", "inDistance"],
      ["outRotation", "outDistance"],
    ] as const) {
      if (t[dist] < 1e-6) t[rot] = s[rot];
      else if (s[dist] < 1e-6) s[rot] = t[rot];
      else t[rot] = near(t[rot], s[rot]);
    }
  });
}

function clockwise(poses: VertexPose[]): boolean {
  let area = 0;
  poses.forEach((p, i) => {
    const q = poses[(i + 1) % poses.length]!;
    area += p.x * q.y - q.x * p.y;
  });
  return area > 0;
}

const perActivity = <T>(
  idle: T,
  other: (a: Exclude<MascotActivity, "idle">) => T,
): Record<MascotActivity, T> =>
  Object.fromEntries(MASCOT_ACTIVITIES.map((a) => [a, a === "idle" ? idle : other(a)])) as Record<
    MascotActivity,
    T
  >;

function paintXml(paint: Paint, strokeId: string | undefined): string {
  if (paint.fill) {
    return `<Fill name="Fill"><SolidColor colorValue="${argb(paint.fill)}" name="Color"/></Fill>`;
  }
  const s = paint.stroke;
  if (!s) return "";
  return (
    `<Stroke thickness="${s.width}" cap="${s.cap ?? "round"}" join="${s.join ?? "round"}"${strokeId ? ` id="${strokeId}"` : ""} name="Stroke">` +
    `<SolidColor colorValue="${argb(s.color)}" name="Color"/></Stroke>`
  );
}

/** The mouth's shapes (front to back, like `parts`) and the rig its activities key. */
export function mouthXml(
  parts: Part[],
  frame: Point,
  line: MouthLine,
): { xml: string; rig: MouthRig } {
  const shapes: MorphShape[] = [];
  const xml = parts.map((part, index) => {
    const main = index === parts.length - 1;
    const { poses: idle, closed } = sourcePoses(part, frame);
    // The line is a stroke: a filled main part gets one in its own colour, unseen while idle.
    const fill = part.paints.find((p) => p.fill)?.fill;
    const ownStroke = part.paints.find((p) => p.stroke)?.stroke;
    const stroke =
      ownStroke ?? (main && fill ? { color: fill, width: 0, cap: "round" as const } : undefined);
    const paints = main && !ownStroke && stroke ? [...part.paints, { stroke }] : part.paints;
    const poses = perActivity(idle, (a) => {
      const b = lineCurve(line, line.poses[a]);
      if (!main) return foldTarget(idle, b);
      return closed ? collapseTarget(idle, b) : strokeTarget(idle.length, b);
    });
    for (const a of MASCOT_ACTIVITIES) if (a !== "idle") settleAngles(idle, poses[a]);
    const shape: MorphShape = {
      id: nextId(),
      vertexIds: idle.map(() => nextId()),
      opacity: perActivity(1, () => (main ? 1 : 0)),
      poses,
    };
    if (stroke && main) {
      shape.stroke = { id: nextId(), width: perActivity(stroke.width, () => LINE_WIDTH) };
    }
    shapes.push(shape);
    const vertices = idle
      .map(
        (p, i) =>
          `<CubicDetachedVertex x="${fmt(p.x)}" y="${fmt(p.y)}" inRotation="${fmt(p.inRotation)}" inDistance="${fmt(p.inDistance)}" ` +
          `outRotation="${fmt(p.outRotation)}" outDistance="${fmt(p.outDistance)}" id="${shape.vertexIds[i]}"/>`,
      )
      .join("\n");
    const paintXmls = paints
      .map((p) => paintXml(p, p.stroke ? shape.stroke?.id : undefined))
      .join("\n");
    return (
      `<Shape name="Mouth ${index + 1}" id="${shape.id}">\n<PointsPath isClosed="${closed}" isClockwise="${clockwise(idle)}" name="Path">\n` +
      `${vertices}\n</PointsPath>\n${paintXmls}\n</Shape>`
    );
  });
  return { xml: xml.join("\n"), rig: { shapes } };
}

/** Keys every mouth vertex, opacity and stroke width at `state`'s pose. */
export function mouthTracks(tracks: Tracks, rig: MouthRig, state: MascotActivity): void {
  for (const shape of rig.shapes) {
    track(tracks, shape.id, "opacity", still(shape.opacity[state]));
    if (shape.stroke) track(tracks, shape.stroke.id, "thickness", still(shape.stroke.width[state]));
    shape.poses[state].forEach((p, i) => {
      const id = shape.vertexIds[i]!;
      for (const prop of [
        "x",
        "y",
        "inRotation",
        "inDistance",
        "outRotation",
        "outDistance",
      ] as const) {
        track(tracks, id, prop, still(p[prop]));
      }
    });
  }
}
