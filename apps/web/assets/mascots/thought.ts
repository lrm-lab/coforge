import type { MascotActivity } from "#src/features/agents/mascot-rive-contract";
import { nextId } from "./contract.ts";
import { fmt, type Point } from "./svg-path.ts";
import { still, track, type ColorKey, type Tracks } from "./timeline.ts";

/**
 * The thinking indicator: a small white thought bubble inside the avatar's circle, above the head
 * and a little right, its one trail circle pointing down at the head, with three neutral
 * dark-grey dots that light up in turn. It is the same for every mascot and the figure never
 * moves for it: it sits clear of every mascot's eyes and brows (checked by eye in the contact
 * sheets; the face box is tight on orange), and inside the circle the web draws behind the
 * figure. Everything here is in artboard units (24 by 24), outside the fitted figure.
 */
/** The avatar's circle in artboard units (no fill is drawn there now): the picture is drawn at 110% of the avatar,
 * 5% left and 6.5% up (`.avatar-sticker-figure` in `styles.css`). */
export const CIRCLE = { centre: [12, 12.33] as Point, radius: 10.9 };
const BUBBLE = { centre: [13.5, 4.1] as Point, width: 5, height: 3.3 };
const TRAIL: { at: Point; d: number }[] = [{ at: [11.3, 6.3], d: 0.8 }];
const DOT_D = 0.95;
const DOT_GAP = 1.35;
/** The bubble's white edge. */
const EDGE = 1.2;
const RIM = "FFC3C9D3";
const PAPER = "FFFFFFFF";
const DOT_ON = "FF353B47";
const DOT_OFF = "FFC4C9D2";
/** One dot's turn, frames: the three light up across 2 s. */
export const DOT_CYCLE = 120;

export interface ThoughtRig {
  /** The bubble group, popped in around its trail's tip. */
  node: string;
  /** Each dot's shape and its colour. */
  dots: { shape: string; color: string }[];
}

const R = BUBBLE.height / 2;
/** Where the bubble pops from: its trail. */
const ANCHOR: Point = TRAIL[0]!.at;

function dotXml(name: string, at: Point, ids: { shape: string; color: string }): string {
  return (
    `<Shape x="${fmt(at[0])}" y="${fmt(at[1])}" name="${name}" id="${ids.shape}">` +
    `<Ellipse width="${fmt(DOT_D)}" height="${fmt(DOT_D)}" name="Path"/>` +
    `<Fill name="Fill"><SolidColor colorValue="${DOT_OFF}" id="${ids.color}" name="Color"/></Fill></Shape>`
  );
}

export function thoughtXml(rig: ThoughtRig): string {
  const [cx, cy] = BUBBLE.centre;
  const rel = (p: Point): Point => [p[0] - ANCHOR[0], p[1] - ANCHOR[1]];
  const shapes = (paint: () => string): string => {
    const bubble =
      `<Shape x="${fmt(cx - ANCHOR[0])}" y="${fmt(cy - ANCHOR[1])}" name="Bubble">` +
      `<Rectangle width="${BUBBLE.width}" height="${BUBBLE.height}" cornerRadiusTL="${R}" name="Path"/>` +
      `${paint()}</Shape>`;
    const trail = TRAIL.map(
      ({ at, d }, i) =>
        `<Shape x="${fmt(rel(at)[0])}" y="${fmt(rel(at)[1])}" name="Trail ${i + 1}">` +
        `<Ellipse width="${d}" height="${d}" name="Path"/>${paint()}</Shape>`,
    ).join("\n");
    return `${bubble}\n${trail}`;
  };
  // Front to back: the dots, the paper with its rim, then the white edge behind everything.
  const dots = rig.dots
    .map((ids, i) => dotXml(`Dot ${i + 1}`, rel([cx + (i - 1) * DOT_GAP, cy]), ids))
    .join("\n");
  // The paper carries a thin grey rim, so the bubble shows on a white page too.
  const paper = shapes(
    () =>
      `<Fill name="Fill"><SolidColor colorValue="${PAPER}" name="Color"/></Fill>` +
      `<Stroke thickness="0.25" name="Rim"><SolidColor colorValue="${RIM}" name="Color"/></Stroke>`,
  );
  const edge = shapes(
    () =>
      `<Stroke thickness="${EDGE}" join="round" name="Edge"><SolidColor colorValue="${PAPER}" name="Color"/></Stroke>`,
  );
  return (
    `<Node x="${fmt(ANCHOR[0])}" y="${fmt(ANCHOR[1])}" opacity="0" name="Thought" id="${rig.node}">\n` +
    `${dots}\n${paper}\n${edge}\n</Node>`
  );
}

/** Whether the bubble, its white edge included, lies inside the avatar's circle. */
export function bubbleInsideCircle(): boolean {
  const half = BUBBLE.width / 2 - R;
  return [-half, half].every(
    (dx) =>
      Math.hypot(BUBBLE.centre[0] + dx - CIRCLE.centre[0], BUBBLE.centre[1] - CIRCLE.centre[1]) +
        R +
        EDGE / 2 <=
      CIRCLE.radius,
  );
}

/** The bubble shown while thinking, popping in from its trail, the dots lighting in turn. */
export function thoughtTracks(
  tracks: Tracks,
  rig: ThoughtRig,
  state: MascotActivity,
  duration: number,
): ColorKey[] {
  const on = state === "thinking";
  track(tracks, rig.node, "opacity", still(on ? 1 : 0));
  track(tracks, rig.node, "scaleX", still(on ? 1 : 0.6));
  track(tracks, rig.node, "scaleY", still(on ? 1 : 0.6));
  return rig.dots.map(({ color }, i) => {
    if (!on) return { id: color, color: DOT_OFF };
    // Each cycle the dots light in turn, each fading before the next cycle starts.
    const start = i * 28;
    const keys: { frame: number; color: string }[] = [];
    for (let s = 0; s < duration; s += DOT_CYCLE) {
      if (start > 0) keys.push({ frame: s, color: DOT_OFF });
      keys.push(
        { frame: s + start, color: DOT_OFF },
        { frame: s + start + 18, color: DOT_ON },
        { frame: s + start + 48, color: DOT_OFF },
      );
    }
    keys.push({ frame: duration, color: DOT_OFF });
    return { id: color, color: DOT_OFF, keys };
  });
}

export function allocateThought(): ThoughtRig {
  if (!bubbleInsideCircle()) throw new Error("the thought bubble must lie inside the circle");
  return { node: nextId(), dots: [0, 1, 2].map(() => ({ shape: nextId(), color: nextId() })) };
}
