import type { MascotActivity } from "#src/features/agents/mascot-rive-contract";
import { mute, type Rig } from "./scene.ts";
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
 * The activity layer owns: the Mascot node (bob / tilt / breathe), both eyes, the closed-eye arcs,
 * brows, the mouth line and idle mouth, the thinking dots and the offline tint. The hover layer
 * owns different nodes (Hover root, Face, accessories), so the two layers compose without ever
 * keying the same property. Every animation keys every property any state touches, because a
 * state machine does not reset a property that the incoming state leaves unkeyed.
 */
interface Pose {
  eye: { dx: number; dy: number; sx: number; sy: number };
  pupil: number;
  closed: number;
  brow: number;
  mouthIdle: number;
  line: number;
  lineDy: number;
  dots: number;
  offline: boolean;
}

const POSES: Record<MascotActivity, Pose> = {
  idle: {
    eye: { dx: 0, dy: 0, sx: 1, sy: 1 },
    pupil: 1,
    closed: 0,
    brow: 0,
    mouthIdle: 1,
    line: 0,
    lineDy: 0,
    dots: 0,
    offline: false,
  },
  thinking: {
    eye: { dx: 0.35, dy: -0.9, sx: 1, sy: 1 },
    pupil: 1,
    closed: 0,
    brow: 0,
    mouthIdle: 0,
    line: 1,
    lineDy: 0.05,
    dots: 1,
    offline: false,
  },
  working: {
    eye: { dx: 0, dy: 0.25, sx: 1, sy: 0.8 },
    pupil: 1,
    closed: 0,
    brow: 0,
    mouthIdle: 0,
    line: 1,
    lineDy: 0.35,
    dots: 0,
    offline: false,
  },
  error: {
    eye: { dx: 0, dy: 0, sx: 1.2, sy: 1.25 },
    pupil: 1,
    closed: 0,
    brow: 1,
    mouthIdle: 0,
    line: 1,
    lineDy: -0.85,
    dots: 0,
    offline: false,
  },
  offline: {
    eye: { dx: 0, dy: 0, sx: 1, sy: 1 },
    pupil: 0,
    closed: 1,
    brow: 0,
    mouthIdle: 0,
    line: 1,
    lineDy: 0.25,
    dots: 0,
    offline: true,
  },
};

/** Loop lengths in frames at 60 fps; all are 2.4 s or longer so nothing flickers. */
const DURATION: Record<MascotActivity, number> = {
  idle: sec(5),
  thinking: sec(3),
  working: sec(4),
  error: sec(4),
  offline: sec(5),
};

function mascotMotion(tracks: Tracks, rig: Rig, state: MascotActivity): void {
  let y: Key[] = still(0);
  let sx: Key[] = still(1);
  let sy: Key[] = still(1);
  let rot: Key[] = still(0);
  if (state === "idle") {
    y = [k(0, 0), k(150, -0.4), k(300, 0, "hold")]; // a gentle float, 0.4 units over 5 s
  } else if (state === "thinking") {
    rot = [k(0, 0), k(90, 0.03), k(180, 0, "hold")]; // a slight head tilt toward the dots
  } else if (state === "working") {
    // Leaning into the work: a constant forward tilt, and one small nod near the end of the loop.
    rot = [k(0, 0.035), k(120, 0.045), k(240, 0.035, "hold")];
    y = [k(0, 0), k(198, 0), k(210, 0.18), k(224, 0, "hold")];
    sy = [k(0, 1), k(198, 1), k(210, 0.985), k(224, 1, "hold")];
  } else if (state === "error") {
    rot = [k(0, 0), k(60, 0.026), k(180, -0.026), k(240, 0, "hold")]; // a slow worried sway, +-1.5 degrees
    sy = still(0.985);
  } else {
    sy = [k(0, 1), k(150, 1.03), k(300, 1, "hold")]; // slow breathing
    sx = [k(0, 1), k(150, 0.992), k(300, 1, "hold")];
  }
  track(tracks, rig.mascot, "y", y);
  track(tracks, rig.mascot, "scaleX", sx);
  track(tracks, rig.mascot, "scaleY", sy);
  track(tracks, rig.mascot, "rotation", rot);
}

/** Eye keys: `x`/`y` are absolute inside the face node, the others are the eye's scale. */
function eyeMotion(tracks: Tracks, rig: Rig, state: MascotActivity): void {
  const p = POSES[state].eye;
  const eyes = [
    { id: rig.eyeL, at: rig.eyeL0 },
    { id: rig.eyeR, at: rig.eyeR0 },
  ];
  for (const { id, at } of eyes) {
    let x: Key[] = still(at[0] + p.dx);
    let y: Key[] = still(at[1] + p.dy);
    let sy: Key[] = still(p.sy);
    if (state === "idle") {
      sy = [k(0, 1, "hold"), k(262, 1, "linear"), k(270, 0.1, "linear"), k(278, 1, "hold")]; // one blink per loop
    } else if (state === "working") {
      // Reading two lines: a slow scan left to right, a quick return, the second line a hair lower.
      const scan = (dx: number): number => at[0] + dx;
      x = [
        k(0, scan(-0.65), "hold"),
        k(18, scan(-0.65)),
        k(90, scan(0.65), "hold"),
        k(96, scan(0.65)),
        k(112, scan(-0.65), "hold"),
        k(118, scan(-0.65)),
        k(190, scan(0.65), "hold"),
        k(196, scan(0.65)),
        k(212, scan(-0.65), "hold"),
        k(240, scan(-0.65), "hold"),
      ];
      y = [
        k(0, at[1] + 0.25, "hold"),
        k(100, at[1] + 0.25),
        k(112, at[1] + 0.4, "hold"),
        k(196, at[1] + 0.4),
        k(212, at[1] + 0.25, "hold"),
        k(240, at[1] + 0.25, "hold"),
      ];
    }
    track(tracks, id, "x", x);
    track(tracks, id, "y", y);
    track(tracks, id, "scaleX", still(p.sx));
    track(tracks, id, "scaleY", sy);
  }
}

function thinkingDots(tracks: Tracks, rig: Rig, state: MascotActivity): void {
  rig.dots.forEach((id, i) => {
    if (state !== "thinking") return track(tracks, id, "opacity", still(0));
    const a = i * 30;
    const keys: Key[] = a === 0 ? [k(0, 0.25)] : [k(0, 0.25, "hold"), k(a, 0.25)];
    keys.push(k(a + 45, 1), k(a + 100, 0.25, "hold"));
    if ((keys.at(-1)?.frame ?? 0) < 180) keys.push(k(180, 0.25, "hold"));
    track(tracks, id, "opacity", keys);
  });
}

export function activityAnimation(rig: Rig, state: MascotActivity, id: string): string {
  const pose = POSES[state];
  const tracks = newTracks();
  mascotMotion(tracks, rig, state);
  eyeMotion(tracks, rig, state);
  thinkingDots(tracks, rig, state);
  track(tracks, rig.pupilL, "opacity", still(pose.pupil));
  track(tracks, rig.pupilR, "opacity", still(pose.pupil));
  track(tracks, rig.closedL, "opacity", still(pose.closed));
  track(tracks, rig.closedR, "opacity", still(pose.closed));
  track(tracks, rig.browL, "opacity", still(pose.brow));
  track(tracks, rig.browR, "opacity", still(pose.brow));
  track(tracks, rig.mouthIdle, "opacity", still(pose.mouthIdle));
  track(tracks, rig.mouthLine, "opacity", still(pose.line));
  track(tracks, rig.mouthMid, "y", still(rig.mouthMid0 + pose.lineDy));
  const colors = rig.tints.map((t) => ({
    id: t.id,
    color: pose.offline ? mute(t.color) : t.color,
  }));
  return animationXml(state, id, DURATION[state], tracks, colors);
}
