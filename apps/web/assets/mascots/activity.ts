import type { MascotActivity } from "#src/features/agents/mascot-rive-contract";
import { browTracks } from "./brows.ts";
import { mute } from "./color.ts";
import { mouthTracks } from "./mouth.ts";
import type { Rig } from "./scene.ts";
import { DOT_CYCLE, thoughtTracks } from "./thought.ts";
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
 * The activity layer owns: the Mascot node (float / tilt / breathe), both eyes, the closed-eye
 * arcs, the brows' vertices (`brows.ts`), the mouth's vertices (`mouth.ts`), the thought bubble
 * (`thought.ts`), the sweat drop, each accessory's pose node and the
 * offline tint. The hover layer owns different nodes (Hover root,
 * Face, each accessory's hover node), so the two layers compose without ever keying the same
 * property. Every animation keys every property any state touches, because a state machine does
 * not reset a property that the incoming state leaves unkeyed.
 */
interface Pose {
  eye: { dx: number; dy: number; sx: number; sy: number };
  pupil: number;
  closed: number;
  offline: boolean;
}

const POSES: Record<MascotActivity, Pose> = {
  idle: {
    eye: { dx: 0, dy: 0, sx: 1, sy: 1 },
    pupil: 1,
    closed: 0,
    offline: false,
  },
  thinking: {
    eye: { dx: 0.15, dy: -0.6, sx: 1, sy: 1 },
    pupil: 1,
    closed: 0,
    offline: false,
  },
  working: {
    eye: { dx: 0, dy: 0.25, sx: 1, sy: 0.8 },
    pupil: 1,
    closed: 0,
    offline: false,
  },
  error: {
    eye: { dx: 0, dy: 0, sx: 1.15, sy: 1.18 },
    pupil: 1,
    closed: 0,
    offline: false,
  },
  offline: {
    eye: { dx: 0, dy: 0, sx: 1, sy: 1 },
    pupil: 0,
    closed: 1,
    offline: true,
  },
};

/** Loop lengths in frames at 60 fps; all are 4 s or longer so nothing flickers. */
const DURATION: Record<MascotActivity, number> = {
  idle: sec(12),
  thinking: DOT_CYCLE * 3,
  working: sec(8),
  error: sec(8),
  offline: sec(5),
};

/** The repeating beats inside the loops, frames: each loop is a whole number of them. */
const BEAT = {
  /** Idle's float. */
  float: DURATION.idle / 3,
  /** Thinking's head tilt, half a loop. */
  tilt: DURATION.thinking / 2,
  /** One working pass: two lines read, one nod. */
  pass: DURATION.working / 2,
  /** One error sway. */
  sway: DURATION.error / 2,
};

/** When each loop blinks, in frames. Idle's gaps differ (2.2 s, 4.5 s, a quick double, 3.5 s)
 * so the rhythm never reads as a metronome; the busy states blink once in a while. */
const BLINKS: Record<MascotActivity, number[]> = {
  idle: [130, 400, 424, 610],
  thinking: [250],
  working: [205],
  error: [300],
  offline: [],
};

/** A loop that keeps `base` and closes to a tenth of it at each blink: quick to close (65 ms),
 * a beat shut, a little slower to open (110 ms). */
function blinking(base: number, at: number[], duration: number): Key[] {
  if (at.length === 0) return still(base);
  const keys: Key[] = [k(0, base, "hold")];
  for (const f of at) {
    keys.push(
      k(f, base),
      k(f + 4, base * 0.1, "hold"),
      k(f + 6, base * 0.1),
      k(f + 13, base, "hold"),
    );
  }
  keys.push(k(duration, base, "hold"));
  return keys;
}

/** `cycle` repeated `times` across a loop of `duration` frames, its keys offset each time. */
function repeat(cycle: (start: number) => Key[], period: number, duration: number): Key[] {
  const keys: Key[] = [];
  for (let start = 0; start < duration; start += period) keys.push(...cycle(start));
  return keys;
}

function mascotMotion(tracks: Tracks, rig: Rig, state: MascotActivity): void {
  const length = DURATION[state];
  let y: Key[] = still(0);
  let sx: Key[] = still(1);
  let sy: Key[] = still(1);
  let rot: Key[] = still(0);
  if (state === "idle") {
    // A faint float, 0.4 units every 4 s.
    y = [...repeat((s) => [k(s, 0), k(s + 120, -0.4)], BEAT.float, length), k(length, 0, "hold")];
  } else if (state === "thinking") {
    // The head tilts toward the thought bubble and settles, twice per loop.
    rot = [...repeat((s) => [k(s, 0), k(s + 90, 0.035)], BEAT.tilt, length), k(length, 0, "hold")];
  } else if (state === "working") {
    // Leaning into the work and back, with one small nod per reading pass.
    rot = [...repeat((s) => [k(s, 0), k(s + 120, 0.03)], BEAT.pass, length), k(length, 0, "hold")];
    y = [
      ...repeat(
        (s) => [k(s, 0, "hold"), k(s + 198, 0), k(s + 210, 0.18), k(s + 224, 0, "hold")],
        BEAT.pass,
        length,
      ),
      k(length, 0, "hold"),
    ];
    sy = [
      ...repeat(
        (s) => [k(s, 1, "hold"), k(s + 198, 1), k(s + 210, 0.985), k(s + 224, 1, "hold")],
        BEAT.pass,
        length,
      ),
      k(length, 1, "hold"),
    ];
  } else if (state === "error") {
    // A slow worried sway, +-1.5 degrees, twice per loop.
    rot = [
      ...repeat((s) => [k(s, 0), k(s + 60, 0.026), k(s + 180, -0.026)], BEAT.sway, length),
      k(length, 0, "hold"),
    ];
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
    if (state === "thinking") {
      // Pondering: the gaze wanders slowly around the bubble.
      const length = DURATION.thinking;
      x = [
        k(0, at[0] + p.dx),
        k(130, at[0] + p.dx - 0.2),
        k(250, at[0] + p.dx + 0.12),
        k(length, at[0] + p.dx, "hold"),
      ];
      y = [k(0, at[1] + p.dy), k(180, at[1] + p.dy + 0.15), k(length, at[1] + p.dy, "hold")];
    } else if (state === "working") {
      // Reading two lines: a slow scan left to right, a quick return, the second line a hair lower.
      const scan = (dx: number): number => at[0] + dx;
      const pass = (s: number): Key[] => [
        k(s, scan(-0.65), "hold"),
        k(s + 18, scan(-0.65)),
        k(s + 90, scan(0.65), "hold"),
        k(s + 96, scan(0.65)),
        k(s + 112, scan(-0.65), "hold"),
        k(s + 118, scan(-0.65)),
        k(s + 190, scan(0.65), "hold"),
        k(s + 196, scan(0.65)),
        k(s + 212, scan(-0.65), "hold"),
      ];
      const lines = (s: number): Key[] => [
        k(s, at[1] + 0.25, "hold"),
        k(s + 100, at[1] + 0.25),
        k(s + 112, at[1] + 0.4, "hold"),
        k(s + 196, at[1] + 0.4),
        k(s + 212, at[1] + 0.25, "hold"),
      ];
      x = [...repeat(pass, BEAT.pass, DURATION.working), k(DURATION.working, scan(-0.65), "hold")];
      y = [
        ...repeat(lines, BEAT.pass, DURATION.working),
        k(DURATION.working, at[1] + 0.25, "hold"),
      ];
    }
    track(tracks, id, "x", x);
    track(tracks, id, "y", y);
    track(tracks, id, "scaleX", still(p.sx));
    track(tracks, id, "scaleY", blinking(p.sy, BLINKS[state], DURATION[state]));
  }
}

/** Each accessory's pose node (and its outline twin) at this activity's place. */
function accessoryPoses(tracks: Tracks, rig: Rig, state: MascotActivity): void {
  for (const a of rig.accessories) {
    const pose = a.accessory.pose?.[state] ?? { dx: 0, dy: 0, rotation: 0 };
    for (const id of [a.pose, a.twinPose]) {
      track(tracks, id, "x", still(a.at[0] + pose.dx));
      track(tracks, id, "y", still(a.at[1] + pose.dy));
      track(tracks, id, "rotation", still(pose.rotation));
    }
  }
}

/** The error's sweat drop: shown, and sliding a little down the face and back. */
function sweat(tracks: Tracks, rig: Rig, state: MascotActivity): void {
  if (!rig.sweat) return;
  const on = state === "error";
  track(tracks, rig.sweat, "opacity", still(on ? 1 : 0));
  const length = DURATION.error;
  const y = on ? [k(0, 0), k(length / 2, 0.45), k(length, 0, "hold")] : still(0);
  // Rive keys a shape's place absolutely: offset from where the scene put it.
  track(
    tracks,
    rig.sweat,
    "y",
    y.map((key) => ({ ...key, value: key.value + rig.sweatAt[1] })),
  );
}

export function activityAnimation(rig: Rig, state: MascotActivity, id: string): string {
  const pose = POSES[state];
  const tracks = newTracks();
  mascotMotion(tracks, rig, state);
  eyeMotion(tracks, rig, state);
  const dotColors = thoughtTracks(tracks, rig.thought, state, DURATION[state]);
  browTracks(tracks, rig.brows, state);
  accessoryPoses(tracks, rig, state);
  sweat(tracks, rig, state);
  mouthTracks(tracks, rig.mouth, state);
  track(tracks, rig.pupilL, "opacity", still(pose.pupil));
  track(tracks, rig.pupilR, "opacity", still(pose.pupil));
  track(tracks, rig.closedL, "opacity", still(pose.closed));
  track(tracks, rig.closedR, "opacity", still(pose.closed));
  const colors = rig.tints.map((t) => ({
    id: t.id,
    color: pose.offline ? mute(t.color) : t.color,
  }));
  return animationXml(state, id, DURATION[state], tracks, [...colors, ...dotColors]);
}
