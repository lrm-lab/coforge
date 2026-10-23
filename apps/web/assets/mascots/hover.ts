import { nextId } from "./contract.ts";
import { PIVOT, type Rig } from "./scene.ts";
import {
  animationXml,
  k,
  newTracks,
  sec,
  still,
  track,
  type Key,
  type Tracks,
} from "./timeline.ts";

/**
 * The hover layer owns the Hover root node, the Face node and each accessory's hover node (and
 * its outline twin); the activity layer never keys them, so a reaction rides on top of whatever
 * the mascot is doing. Three poses: `rest` (identity), `hello` (a gentle hop that ends where
 * `noticed` begins) and `noticed` (a gently breathing "I see you" pose held while hovered).
 */
export type HoverPose = "rest" | "hello" | "noticed";

export const HOVER_DURATION: Record<HoverPose, number> = {
  rest: sec(1),
  hello: 60,
  noticed: sec(2.4),
};

interface Frame {
  y: Key[];
  sx: Key[];
  sy: Key[];
  rot: Key[];
  faceDx: Key[];
  faceDy: Key[];
  faceScale: Key[];
  /** Multiplier applied to each accessory's own wiggle / pulse. */
  wiggle: Key[];
  pulse: Key[];
}

const FRAMES: Record<HoverPose, Frame> = {
  rest: {
    y: still(0),
    sx: still(1),
    sy: still(1),
    rot: still(0),
    faceDx: still(0),
    faceDy: still(0),
    faceScale: still(1),
    wiggle: still(0),
    pulse: still(0),
  },
  hello: {
    // A gentle hop: settle (squash), rise under a unit, land softly (a smaller squash) and come
    // to rest in the noticed pose, all inside one second.
    y: [k(0, 0), k(9, 0.06), k(27, -0.8), k(43, 0), k(52, 0.04), k(60, 0, "hold")],
    sx: [k(0, 1), k(9, 1.03), k(27, 0.99), k(43, 1.02), k(52, 1.008), k(60, 1.006, "hold")],
    sy: [k(0, 1), k(9, 0.965), k(27, 1.022), k(43, 0.98), k(52, 1.006), k(60, 1.012, "hold")],
    rot: [k(0, 0), k(9, 0), k(27, -0.02), k(43, 0.01), k(60, 0.015, "hold")],
    faceDx: [k(0, 0), k(12, -0.2), k(30, -0.4), k(60, -0.35, "hold")],
    faceDy: [k(0, 0), k(12, 0), k(30, -0.15), k(60, -0.1, "hold")],
    faceScale: [k(0, 1), k(12, 1), k(30, 1.07), k(60, 1.05, "hold")],
    wiggle: [k(0, 0), k(14, 0), k(26, 1), k(38, -0.7), k(50, 0.3), k(60, 0, "hold")],
    pulse: [k(0, 0), k(16, 0), k(32, 1), k(60, 0, "hold")],
  },
  noticed: {
    y: still(0),
    sx: [k(0, 1.006), k(72, 1), k(144, 1.006, "hold")],
    sy: [k(0, 1.012), k(72, 1.02), k(144, 1.012, "hold")],
    rot: [k(0, 0.015), k(72, 0.025), k(144, 0.015, "hold")],
    faceDx: still(-0.35),
    faceDy: still(-0.1),
    faceScale: still(1.05),
    wiggle: still(0),
    pulse: [k(0, 0), k(72, 0.25), k(144, 0, "hold")],
  },
};

const scaled = (keys: Key[], by: number): Key[] =>
  keys.map((key) => ({ ...key, value: key.value * by }));
const offset = (keys: Key[], by: number): Key[] =>
  keys.map((key) => ({ ...key, value: key.value + by }));

function hoverTracks(rig: Rig, pose: HoverPose): Tracks {
  const f = FRAMES[pose];
  const tracks = newTracks();
  track(tracks, rig.hoverRoot, "y", offset(f.y, PIVOT[1]));
  track(tracks, rig.hoverRoot, "scaleX", f.sx);
  track(tracks, rig.hoverRoot, "scaleY", f.sy);
  track(tracks, rig.hoverRoot, "rotation", f.rot);
  track(tracks, rig.face, "x", offset(f.faceDx, rig.faceAt[0]));
  track(tracks, rig.face, "y", offset(f.faceDy, rig.faceAt[1]));
  track(tracks, rig.face, "scaleX", f.faceScale);
  track(tracks, rig.face, "scaleY", f.faceScale);
  for (const { hover, twinHover, accessory } of rig.accessories) {
    // The outline twin moves with its accessory, so the sticker edge never comes apart.
    for (const id of [hover, twinHover]) {
      track(tracks, id, "rotation", scaled(f.wiggle, accessory.hover.wiggle));
      track(tracks, id, "scaleX", offset(scaled(f.pulse, accessory.hover.pulse), 1));
      track(tracks, id, "scaleY", offset(scaled(f.pulse, accessory.hover.pulse), 1));
    }
  }
  return tracks;
}

export interface HoverAnimations {
  ids: Record<HoverPose, string>;
  xml: string;
}

export function hoverAnimations(rig: Rig): HoverAnimations {
  const ids = { rest: nextId(), hello: nextId(), noticed: nextId() } satisfies Record<
    HoverPose,
    string
  >;
  const poses: HoverPose[] = ["rest", "hello", "noticed"];
  const xml = poses
    .map((p) => animationXml(`hover-${p}`, ids[p], HOVER_DURATION[p], hoverTracks(rig, p), []))
    .join("\n");
  return { ids, xml };
}
