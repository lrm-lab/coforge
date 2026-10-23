/** SVG path data (M, L, C, H, V, Z, absolute) as Rive path vertices. */

/** The only path commands the source SVGs use; any other letter is refused by name. */
const SUPPORTED_COMMANDS = "M, L, C, H, V, Z (absolute)";

export type Point = readonly [number, number];

export const add = (a: Point, b: Point, k = 1): Point => [a[0] + b[0] * k, a[1] + b[1] * k];
export const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];

interface Vertex {
  p: Point;
  inHandle: Point | null;
  outHandle: Point | null;
}

export interface Subpath {
  vertices: Vertex[];
  closed: boolean;
}

export function parseSvgPath(d: string): Subpath[] {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const subpaths: Subpath[] = [];
  let current: Subpath | null = null;
  let at: Point = [0, 0];
  let i = 0;
  const num = (): number => Number(tokens[i++]);
  const last = (): Vertex => {
    const v = current?.vertices.at(-1);
    if (!v) throw new Error("path command before M");
    return v;
  };
  const lineTo = (p: Point): void => {
    current?.vertices.push({ p, inHandle: null, outHandle: null });
    at = p;
  };
  while (i < tokens.length) {
    const cmd = tokens[i++] as string;
    if (cmd === "M") {
      at = [num(), num()];
      current = { vertices: [{ p: at, inHandle: null, outHandle: null }], closed: false };
      subpaths.push(current);
    } else if (cmd === "L") {
      lineTo([num(), num()]);
    } else if (cmd === "H") {
      lineTo([num(), at[1]]);
    } else if (cmd === "V") {
      lineTo([at[0], num()]);
    } else if (cmd === "C") {
      const c1: Point = [num(), num()];
      const c2: Point = [num(), num()];
      const end: Point = [num(), num()];
      last().outHandle = c1;
      current?.vertices.push({ p: end, inHandle: c2, outHandle: null });
      at = end;
    } else if (cmd === "Z") {
      if (!current) throw new Error("path command Z before M");
      current.closed = true;
      // A closing segment that returns to the start point merges into the first vertex.
      const first = current.vertices[0] as Vertex;
      const tail = current.vertices.at(-1) as Vertex;
      if (
        current.vertices.length > 1 &&
        Math.hypot(first.p[0] - tail.p[0], first.p[1] - tail.p[1]) < 1e-3
      ) {
        first.inHandle = tail.inHandle;
        current.vertices.pop();
      }
    } else {
      throw new Error(`unsupported SVG path command "${cmd}": only ${SUPPORTED_COMMANDS} are read`);
    }
  }
  return subpaths;
}

export function fmt(v: number): string {
  return Number(v.toFixed(4)).toString();
}

function vertexXml(v: Vertex, frame: Point): string {
  const x = v.p[0] - frame[0];
  const y = v.p[1] - frame[1];
  if (!v.inHandle && !v.outHandle) return `<StraightVertex x="${fmt(x)}" y="${fmt(y)}"/>`;
  const handle = (h: Point | null): [number, number] =>
    h
      ? [Math.atan2(h[1] - v.p[1], h[0] - v.p[0]), Math.hypot(h[0] - v.p[0], h[1] - v.p[1])]
      : [0, 0];
  const [inRot, inDist] = handle(v.inHandle);
  const [outRot, outDist] = handle(v.outHandle);
  return (
    `<CubicDetachedVertex x="${fmt(x)}" y="${fmt(y)}" inRotation="${fmt(inRot)}" inDistance="${fmt(inDist)}" ` +
    `outRotation="${fmt(outRot)}" outDistance="${fmt(outDist)}"/>`
  );
}

function clockwise(vertices: Vertex[]): boolean {
  let area = 0;
  vertices.forEach((v, k) => {
    const n = vertices[(k + 1) % vertices.length] as Vertex;
    area += v.p[0] * n.p[1] - n.p[0] * v.p[1];
  });
  return area > 0; // y grows downward, so a positive shoelace sum is clockwise on screen
}

/** `PointsPath` elements for every subpath of `d`, positioned relative to `frame` (SVG coordinates). */
export function pointsPathsXml(d: string, frame: Point): string {
  return parseSvgPath(d)
    .map(
      (s) =>
        `<PointsPath isClosed="${s.closed}" isClockwise="${clockwise(s.vertices)}" name="Path">\n` +
        s.vertices.map((v) => `    ${vertexXml(v, frame)}`).join("\n") +
        "\n</PointsPath>",
    )
    .join("\n");
}

/** Axis-aligned bounds of a path's anchor points (handles ignored; good enough for placement). */
export function pathBounds(d: string): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of parseSvgPath(d)) {
    for (const v of s.vertices) {
      xs.push(v.p[0]);
      ys.push(v.p[1]);
    }
  }
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/** The point at `t` of the cubic from `p0` to `p3` with handles `p1`, `p2`. */
export function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
}

/** Bounds of everything `d` draws, curves included (sampled), unlike `pathBounds`. */
export function pathExtent(d: string): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of parseSvgPath(d)) {
    const n = s.vertices.length;
    for (let i = 0; i < (s.closed ? n : n - 1); i++) {
      const a = s.vertices[i] as Vertex;
      const b = s.vertices[(i + 1) % n] as Vertex;
      for (let k = 0; k <= 16; k++) {
        const [x, y] = cubicAt(a.p, a.outHandle ?? a.p, b.inHandle ?? b.p, b.p, k / 16);
        xs.push(x);
        ys.push(y);
      }
    }
  }
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}
