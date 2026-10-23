import { nextId, type SharedIds } from "./contract.ts";
import { LOOK_REACH, lookBinds } from "./look.ts";
import type { Accessory, MascotSpec, Paint, Part } from "./spec.ts";
import { fmt, pathBounds, pointsPathsXml, type Point } from "./svg-path.ts";

/** Bottom centre of the picture: the mascot squashes, tilts and bobs around it. */
export const PIVOT: Point = [12, 21];
const WHITE = "FFFFFFFF";

const NAMED: Record<string, string> = { white: "FFFFFF", black: "000000" };

export const argb = (color: string): string =>
  `FF${NAMED[color] ?? color.replace("#", "").toUpperCase()}`;

/** Blend `hex` toward a neutral grey: the muted colour a mascot wears while offline. */
export function mute(hex: string): string {
  const n = hex.replace("#", "").slice(-6);
  const mixed = [0, 2, 4].map((i) => {
    const c = Number.parseInt(n.slice(i, i + 2), 16);
    return Math.round(c + (176 - c) * 0.42)
      .toString(16)
      .padStart(2, "0");
  });
  return `FF${mixed.join("").toUpperCase()}`;
}

export interface Tint {
  id: string;
  /** `AARRGGBB` while online. */
  color: string;
}

/** The animatable objects of one mascot artboard. */
export interface Rig {
  hoverRoot: string;
  mascot: string;
  face: string;
  eyeL: string;
  eyeR: string;
  pupilL: string;
  pupilR: string;
  closedL: string;
  closedR: string;
  browL: string;
  browR: string;
  mouthIdle: string;
  mouthLine: string;
  mouthMid: string;
  dots: string[];
  accessories: { id: string; accessory: Accessory }[];
  tints: Tint[];
  /** Eye centres relative to the face node, and the resting y of the mouth line's middle vertex. */
  eyeL0: Point;
  eyeR0: Point;
  mouthMid0: number;
  /** The face node's own position inside the Mascot node. */
  faceAt: Point;
  /** Root elements the artboard's data binds name (`look.ts`). */
  converters: string[];
}

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];

function paintXml(paint: Paint, tint: boolean, rig: Rig): string {
  if (paint.fill) {
    const id = tint ? nextId() : undefined;
    if (id) rig.tints.push({ id, color: argb(paint.fill) });
    return `<Fill name="Fill"><SolidColor colorValue="${argb(paint.fill)}"${id ? ` id="${id}"` : ""} name="Color"/></Fill>`;
  }
  const s = paint.stroke;
  if (!s) return "";
  return (
    `<Stroke thickness="${s.width}" cap="${s.cap ?? "round"}" join="${s.join ?? "round"}" name="Stroke">` +
    `<SolidColor colorValue="${argb(s.color)}" name="Color"/></Stroke>`
  );
}

function partXml(part: Part, frame: Point, name: string, rig: Rig, tint = false): string {
  const paints = part.paints.map((p) => paintXml(p, tint, rig)).join("\n");
  return `<Shape name="${name}">\n${pointsPathsXml(part.d, frame)}\n${paints}\n</Shape>`;
}

function ellipseXml(name: string, w: number, h: number, color: string, extra = ""): string {
  return (
    `<Shape ${extra} name="${name}"><Ellipse width="${fmt(w)}" height="${fmt(h)}" name="Path"/>` +
    `<Fill name="Fill"><SolidColor colorValue="${argb(color)}" name="Color"/></Fill></Shape>`
  );
}

function eyeXml(
  spec: MascotSpec,
  side: "L" | "R",
  at: Point,
  id: string,
  pupil: string,
  closed: string,
  look: string,
): string {
  const { radius, color, glints } = spec.eyes;
  const d = radius * 2;
  const glintXml = glints
    .map(
      (g) =>
        `<Shape x="${fmt(g.offset[0])}" y="${fmt(g.offset[1])}" rotation="${fmt(g.rotation)}" name="Glint">` +
        `<Rectangle width="${fmt(g.width)}" height="${fmt(g.height)}" cornerRadiusTL="${fmt(g.width / 2)}" name="Path"/>` +
        `<Fill name="Fill"><SolidColor colorValue="${WHITE}" name="Color"/></Fill></Shape>`,
    )
    .join("\n");
  const arc =
    `<Shape opacity="0" name="Closed eye ${side}" id="${closed}"><PointsPath isClosed="false" name="Path">` +
    `<CubicDetachedVertex x="-0.9" y="-0.05" inRotation="0" inDistance="0" outRotation="0.9" outDistance="0.35"/>` +
    `<CubicDetachedVertex x="0.9" y="-0.05" inRotation="2.24" inDistance="0.35" outRotation="0" outDistance="0"/>` +
    `</PointsPath><Stroke thickness="0.9" cap="round" join="round" name="Stroke">` +
    `<SolidColor colorValue="${argb(spec.featureColor)}" name="Color"/></Stroke></Shape>`;
  return (
    `<Node x="${fmt(at[0])}" y="${fmt(at[1])}" name="Eye ${side}" id="${id}">\n` +
    `${arc}\n<Node name="Pupil ${side}" id="${pupil}">\n${look}\n${glintXml}\n${ellipseXml("Eye", d, d, color)}\n</Node>\n</Node>`
  );
}

function browXml(spec: MascotSpec, side: "L" | "R", eye: Point, id: string): string {
  // Worried brows: the inner end sits higher than the outer one.
  const [a, b]: [Point, Point] =
    side === "L"
      ? [
          [-1.1, -1.55],
          [1.1, -2.65],
        ]
      : [
          [-1.1, -2.6],
          [1.1, -1.5],
        ];
  return (
    `<Shape x="${fmt(eye[0])}" y="${fmt(eye[1])}" opacity="0" name="Brow ${side}" id="${id}">` +
    `<PointsPath isClosed="false" name="Path"><StraightVertex x="${a[0]}" y="${a[1]}"/><StraightVertex x="${b[0]}" y="${b[1]}"/></PointsPath>` +
    `<Stroke thickness="0.85" cap="round" join="round" name="Stroke"><SolidColor colorValue="${argb(spec.browColor)}" name="Color"/></Stroke></Shape>`
  );
}

/** Mouth line anchored under the eyes, tilted like them, as wide as the mascot's own mouth allows. */
function mouthLineXml(
  spec: MascotSpec,
  rig: Rig,
  centre: Point,
  halfWidth: number,
  slope: number,
): string {
  const [cx, cy] = centre;
  const chord = Math.atan2(slope, 1);
  const h = (v: number): string => fmt(v);
  return (
    `<Shape opacity="0" name="Mouth line" id="${rig.mouthLine}"><PointsPath isClosed="false" name="Path">` +
    `<StraightVertex x="${h(cx - halfWidth)}" y="${h(cy - halfWidth * slope)}"/>` +
    `<CubicDetachedVertex x="${h(cx)}" y="${h(cy)}" inRotation="${h(chord + Math.PI)}" inDistance="0.9" outRotation="${h(chord)}" outDistance="0.9" id="${rig.mouthMid}"/>` +
    `<StraightVertex x="${h(cx + halfWidth)}" y="${h(cy + halfWidth * slope)}"/></PointsPath>` +
    `<Stroke thickness="1.1" cap="round" join="round" name="Stroke"><SolidColor colorValue="${argb(spec.mouthLineColor)}" name="Color"/></Stroke></Shape>`
  );
}

function accessoryXml(a: Accessory, rig: Rig): string {
  const id = nextId();
  rig.accessories.push({ id, accessory: a });
  const parts = a.parts
    .map((p, i) => partXml(p, a.pivot, `${a.name} ${i + 1}`, rig, true))
    .join("\n");
  const at = sub(a.pivot, PIVOT);
  return `<Node x="${fmt(at[0])}" y="${fmt(at[1])}" name="${a.name}" id="${id}">\n${parts}\n</Node>`;
}

function bounds(parts: Part[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const all = parts.map((p) => pathBounds(p.d));
  return {
    minX: Math.min(...all.map((b) => b.minX)),
    maxX: Math.max(...all.map((b) => b.maxX)),
    minY: Math.min(...all.map((b) => b.minY)),
    maxY: Math.max(...all.map((b) => b.maxY)),
  };
}

export interface BuiltScene {
  /** Artboard children, front to back. */
  xml: string;
  rig: Rig;
}

export function buildScene(spec: MascotSpec, shared: SharedIds): BuiltScene {
  const { l, r } = spec.eyes;
  const face: Point = [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2 + 1.5];
  const eyeL0 = sub(l, face);
  const eyeR0 = sub(r, face);
  const rig: Rig = {
    hoverRoot: nextId(),
    mascot: nextId(),
    face: nextId(),
    eyeL: nextId(),
    eyeR: nextId(),
    pupilL: nextId(),
    pupilR: nextId(),
    closedL: nextId(),
    closedR: nextId(),
    browL: nextId(),
    browR: nextId(),
    mouthIdle: nextId(),
    mouthLine: nextId(),
    mouthMid: nextId(),
    dots: [nextId(), nextId(), nextId()],
    accessories: [],
    tints: [],
    eyeL0,
    eyeR0,
    mouthMid0: 0,
    faceAt: sub(face, PIVOT),
    converters: [],
  };
  // The look binds sit on nodes no animation keys, so they compose with every activity and with
  // the hover layer: the pupils, and a wrapper around the whole face.
  const eyeLook = lookBinds(shared, LOOK_REACH.eye);
  const eyeLookR = lookBinds(shared, LOOK_REACH.eye);
  const faceLook = lookBinds(shared, LOOK_REACH.face);
  rig.converters.push(...eyeLook.converters, ...eyeLookR.converters, ...faceLook.converters);
  const mb = bounds(spec.mouth);
  const mouthCentre: Point = [(mb.minX + mb.maxX) / 2 - face[0], (mb.minY + mb.maxY) / 2 - face[1]];
  const slope = Math.max(-0.15, Math.min(0, ((r[1] - l[1]) / (r[0] - l[0])) * 0.5));
  const halfWidth = Math.max(1.1, Math.min(1.7, (mb.maxX - mb.minX) * 0.3));
  rig.mouthMid0 = mouthCentre[1];

  const dots = spec.dots.points
    .map(
      (p, i) =>
        `<Shape x="${fmt(p[0])}" y="${fmt(p[1])}" opacity="0" name="Thinking dot ${i + 1}" id="${rig.dots[i]}">` +
        `<Ellipse width="1.5" height="1.5" name="Path"/><Fill name="Fill"><SolidColor colorValue="${argb(spec.dots.color)}" name="Color"/></Fill></Shape>`,
    )
    .join("\n");

  const mouthIdle = spec.mouth.map((p, i) => partXml(p, face, `Mouth ${i + 1}`, rig)).join("\n");
  const front = spec.front.map((a) => accessoryXml(a, rig)).join("\n");
  const behind = spec.behind.map((a) => accessoryXml(a, rig)).join("\n");
  const bodyId = nextId();
  rig.tints.push({ id: bodyId, color: argb(spec.body.fill) });
  const body =
    `<Shape name="Body">\n${pointsPathsXml(spec.body.d, PIVOT)}\n` +
    `<Stroke thickness="2" cap="round" join="round" name="Outline"><SolidColor colorValue="${WHITE}" name="Color"/></Stroke>\n` +
    `<Fill name="Fill"><SolidColor colorValue="${argb(spec.body.fill)}" id="${bodyId}" name="Color"/></Fill>\n</Shape>`;

  const faceAt = rig.faceAt;
  const xml = `${dots}
<Node x="${PIVOT[0]}" y="${PIVOT[1]}" name="Hover root" id="${rig.hoverRoot}">
<Node name="Mascot" id="${rig.mascot}">
<Node x="${fmt(faceAt[0])}" y="${fmt(faceAt[1])}" name="Face" id="${rig.face}">
<Node name="Face look">
${faceLook.binds}
${browXml(spec, "L", eyeL0, rig.browL)}
${browXml(spec, "R", eyeR0, rig.browR)}
${eyeXml(spec, "L", eyeL0, rig.eyeL, rig.pupilL, rig.closedL, eyeLook.binds)}
${eyeXml(spec, "R", eyeR0, rig.eyeR, rig.pupilR, rig.closedR, eyeLookR.binds)}
${mouthLineXml(spec, rig, mouthCentre, halfWidth, slope)}
<Node name="Mouth" id="${rig.mouthIdle}">
${mouthIdle}
</Node>
</Node>
</Node>
${front}
${body}
${behind}
</Node>
</Node>`;
  return { xml, rig };
}
