import { allocateBrows, browXml, type BrowRig } from "./brows.ts";
import { argb } from "./color.ts";
import { nextId, type SharedIds } from "./contract.ts";
import { fitFor, OUTLINE } from "./fit.ts";
import { LOOK_REACH, lookBinds } from "./look.ts";
import { mouthXml, type MouthLine, type MouthRig } from "./mouth.ts";
import type { Accessory, MascotSpec, Paint, Part } from "./spec.ts";
import { fmt, pathBounds, pointsPathsXml, sub, type Point } from "./svg-path.ts";
import { allocateThought, thoughtXml, type ThoughtRig } from "./thought.ts";

/** Bottom centre of the picture: the mascot squashes, tilts and bobs around it. */
export const PIVOT: Point = [12, 21];
const WHITE = "FFFFFFFF";

export interface Tint {
  id: string;
  /** `AARRGGBB` while online. */
  color: string;
}

/** One accessory's nodes: the activity layer moves `pose`, the hover layer turns `hover`, and the
 * white outline behind the body has the same pair (`twinPose`, `twinHover`) moved the same way. */
export interface AccessoryRig {
  accessory: Accessory;
  /** The pivot's place inside the Mascot node. */
  at: Point;
  pose: string;
  hover: string;
  twinPose: string;
  twinHover: string;
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
  brows: BrowRig;
  mouth: MouthRig;
  thought: ThoughtRig;
  sweat?: string;
  /** The sweat drop's place inside the face node. */
  sweatAt: Point;
  accessories: AccessoryRig[];
  tints: Tint[];
  /** Eye centres relative to the face node. */
  eyeL0: Point;
  eyeR0: Point;
  /** The face node's own position inside the Mascot node. */
  faceAt: Point;
  /** Root elements the artboard's data binds name (`look.ts`). */
  converters: string[];
}

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

/** A part's white silhouette, outline width wider all round: the sticker edge drawn behind it. */
function outlineXml(d: string, frame: Point, name: string): string {
  return (
    `<Shape name="${name}">\n${pointsPathsXml(d, frame)}\n` +
    `<Stroke thickness="${OUTLINE}" cap="round" join="round" name="Outline"><SolidColor colorValue="${WHITE}" name="Color"/></Stroke>\n` +
    `<Fill name="Fill"><SolidColor colorValue="${WHITE}" name="Color"/></Fill>\n</Shape>`
  );
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

/** A small sweat drop beside the face, its tip up, white-edged like the rest of the sticker. */
function sweatXml(at: Point, id: string): string {
  const drop =
    `<PointsPath isClosed="true" name="Path">` +
    `<StraightVertex x="0" y="-1.5"/>` +
    `<CubicDetachedVertex x="0.8" y="0.33" inRotation="-1.75" inDistance="0.78" outRotation="1.5708" outDistance="0.45"/>` +
    `<CubicDetachedVertex x="0" y="1.1" inRotation="0" inDistance="0.44" outRotation="3.1416" outDistance="0.44"/>` +
    `<CubicDetachedVertex x="-0.8" y="0.33" inRotation="1.5708" inDistance="0.45" outRotation="-1.39" outDistance="0.78"/>` +
    `</PointsPath>`;
  return (
    `<Shape x="${fmt(at[0])}" y="${fmt(at[1])}" opacity="0" name="Sweat" id="${id}">${drop}` +
    `<Stroke thickness="0.6" cap="round" join="round" name="Outline"><SolidColor colorValue="${WHITE}" name="Color"/></Stroke>` +
    `<Fill name="Fill"><SolidColor colorValue="FF7CC8FF" name="Color"/></Fill></Shape>`
  );
}

function accessoryXml(a: Accessory, rig: Rig): { front: string; outline: string } {
  const entry: AccessoryRig = {
    accessory: a,
    at: sub(a.pivot, PIVOT),
    pose: nextId(),
    hover: nextId(),
    twinPose: nextId(),
    twinHover: nextId(),
  };
  rig.accessories.push(entry);
  const parts = a.parts
    .map((p, i) => partXml(p, a.pivot, `${a.name} ${i + 1}`, rig, true))
    .join("\n");
  const outlines = a.parts
    .map((p, i) => outlineXml(p.d, a.pivot, `${a.name} outline ${i + 1}`))
    .join("\n");
  const wrap = (name: string, pose: string, hover: string, inner: string): string =>
    `<Node x="${fmt(entry.at[0])}" y="${fmt(entry.at[1])}" name="${name}" id="${pose}">\n` +
    `<Node name="${name} hover" id="${hover}">\n${inner}\n</Node>\n</Node>`;
  return {
    front: wrap(a.name, entry.pose, entry.hover, parts),
    outline: wrap(`${a.name} outline`, entry.twinPose, entry.twinHover, outlines),
  };
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

/** The idle mouth's line: centred on the mascot's own mouth, tilted half as much as the eyes, as
 * wide as that mouth allows. */
function mouthLine(spec: MascotSpec, face: Point): MouthLine {
  const { l, r } = spec.eyes;
  const mb = bounds(spec.mouth);
  return {
    centre: [(mb.minX + mb.maxX) / 2 - face[0], (mb.minY + mb.maxY) / 2 - face[1]],
    halfWidth: Math.max(1.1, Math.min(1.7, (mb.maxX - mb.minX) * 0.3)),
    slope: Math.max(-0.15, Math.min(0, ((r[1] - l[1]) / (r[0] - l[0])) * 0.5)),
    poses: {
      // "Hmm": a short curve pulled toward the bubble, its far end up.
      thinking: { mid: -0.3, shrink: 0.6, shift: 0.5, tilt: -0.25 },
      working: { mid: 0.35 },
      error: { mid: -0.85, drop: 0.4 },
      offline: { mid: 0.25 },
    },
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
  const mouth = mouthXml(spec.mouth, face, mouthLine(spec, face));
  // The whole figure is placed once (`fit.ts`); everything inside keeps source coordinates.
  const fit = fitFor(spec);
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
    brows: allocateBrows(),
    mouth: mouth.rig,
    thought: allocateThought(),
    sweat: spec.sweat ? nextId() : undefined,
    sweatAt: spec.sweat ? sub(spec.sweat, face) : [0, 0],
    accessories: [],
    tints: [],
    eyeL0: sub(l, face),
    eyeR0: sub(r, face),
    faceAt: sub(face, PIVOT),
    converters: [],
  };
  // The look binds sit on nodes no animation keys, so they compose with every activity and with
  // the hover layer: the pupils, and a wrapper around the whole face.
  const eyeLook = lookBinds(shared, LOOK_REACH.eye);
  const eyeLookR = lookBinds(shared, LOOK_REACH.eye);
  const faceLook = lookBinds(shared, LOOK_REACH.face);
  const browLook = lookBinds(shared, LOOK_REACH.brow);
  rig.converters.push(
    ...eyeLook.converters,
    ...eyeLookR.converters,
    ...faceLook.converters,
    ...browLook.converters,
  );

  const front = spec.front.map((a) => accessoryXml(a, rig));
  const behind = spec.behind.map((a) => accessoryXml(a, rig));
  const bodyId = nextId();
  rig.tints.push({ id: bodyId, color: argb(spec.body.fill) });
  const body =
    `<Shape name="Body">\n${pointsPathsXml(spec.body.d, PIVOT)}\n` +
    `<Fill name="Fill"><SolidColor colorValue="${argb(spec.body.fill)}" id="${bodyId}" name="Color"/></Fill>\n</Shape>`;
  // One white silhouette behind everything, the body's and every accessory's, so the sticker
  // edge runs around the whole figure and never between its parts.
  const outline = [...front, ...behind].map((a) => a.outline).join("\n");
  const sweat = rig.sweat ? sweatXml(rig.sweatAt, rig.sweat) : "";

  const faceAt = rig.faceAt;
  const xml = `${thoughtXml(rig.thought)}
<Node x="${fmt(fit.at[0])}" y="${fmt(fit.at[1])}" scaleX="${fit.scale}" scaleY="${fit.scale}" name="Fit">
<Node x="${PIVOT[0]}" y="${PIVOT[1]}" name="Hover root" id="${rig.hoverRoot}">
<Node name="Mascot" id="${rig.mascot}">
<Node x="${fmt(faceAt[0])}" y="${fmt(faceAt[1])}" name="Face" id="${rig.face}">
${sweat}
<Node name="Face look">
${faceLook.binds}
<Node name="Brows look">
${browLook.binds}
${browXml(rig.brows, "L", rig.eyeL0, spec.browColor)}
${browXml(rig.brows, "R", rig.eyeR0, spec.browColor)}
</Node>
${eyeXml(spec, "L", rig.eyeL0, rig.eyeL, rig.pupilL, rig.closedL, eyeLook.binds)}
${eyeXml(spec, "R", rig.eyeR0, rig.eyeR, rig.pupilR, rig.closedR, eyeLookR.binds)}
<Node name="Mouth">
${mouth.xml}
</Node>
</Node>
</Node>
${front.map((a) => a.front).join("\n")}
${body}
${behind.map((a) => a.front).join("\n")}
<Node name="Outline">
${outline}
${outlineXml(spec.body.d, PIVOT, "Body outline")}
</Node>
</Node>
</Node>
</Node>`;
  return { xml, rig };
}
