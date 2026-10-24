/**
 * How one mascot moves on the chat list header's stage, frame by frame, with no React and no DOM:
 * it slides with a small hop (mascots have no legs), works in place for a while, turns round before
 * walking the other way, and comes out from or goes back behind the stage's right edge, where the
 * count is. Mascots may pass each other.
 */

import { between, type Random } from "./busy-agents-random";
import type { CastPhase } from "./busy-agents-cast";

/** A mascot's box, in px (the 24px sticker). */
export const MASCOT_PX = 24;
/** One hop per this many px travelled. */
const HOP_PX = 6.5;
const ACCELERATION = 15;
const DECELERATION = 12;
/** A mascot going back in keeps at least this speed, so it does not stall at the edge. */
const EXIT_SPEED = 6;
const TURN_SECONDS = 0.34;

export type Walker = {
  x: number;
  /** Speed, px/s, always ≥ 0; `face` gives the direction. */
  v: number;
  face: 1 | -1;
  maxSpeed: number;
  mode: "stand" | "walk" | "turn";
  target: number;
  /** Seconds left standing. */
  timer: number;
  /** Progress through a turn, 0..1. */
  turn: number;
  /** Hops travelled; its fraction is where in a hop the mascot is. */
  gait: number;
  /** A phase offset for the breathing of a mascot standing still. */
  breath: number;
};

export type WalkContext = {
  phase: CastPhase;
  /** The stage's width in px; x ≥ width is behind the count. */
  width: number;
  /** Four or more on stage: shorter walks, longer work in place. */
  crowded: boolean;
  /** The viewer is pointing at it or reading its card: it stops where it is. */
  held: boolean;
};

/** The furthest right a mascot stands while it is on stage, clear of the count. */
export const roamEnd = (width: number) => Math.max(0, width - MASCOT_PX - 6);

/** Where the `index`-th of `count` mascots stands when they are spread along a stage `width` wide:
 * each in the middle of its share of the way. */
export const spreadX = (index: number, count: number, width: number) =>
  ((index + 0.5) * roamEnd(width)) / Math.max(1, count);

/** A mascot coming out from behind the count, or one already on stage at `x`. */
export function newWalker(x: number, random: Random, entering: boolean): Walker {
  return {
    x,
    v: 0,
    face: entering ? -1 : random() < 0.5 ? 1 : -1,
    maxSpeed: between(10, 13, random),
    mode: entering ? "walk" : "stand",
    target: x,
    timer: entering ? 0 : between(0.4, 3, random),
    turn: 0,
    gait: random() * 2,
    breath: random() * Math.PI * 2,
  };
}

/** Advances a mascot by `dt` seconds. Returns whether it finished coming out (`entering`) or going
 * back in (`leaving`); a mascot already `on` stage never does. */
export function stepWalker(w: Walker, dt: number, ctx: WalkContext, random: Random): boolean {
  const end = roamEnd(ctx.width);
  if (
    ctx.phase === "leaving" &&
    w.mode !== "turn" &&
    (w.mode === "stand" || w.target <= ctx.width)
  ) {
    w.target = ctx.width + 1;
    if (w.face < 0) startTurn(w);
    else w.mode = "walk";
  }
  if (ctx.phase === "entering" && (w.mode === "stand" || w.target > end)) {
    w.target = between(0, end, random);
    w.mode = "walk";
  }
  if (w.mode === "stand") {
    if (!ctx.held) w.timer -= dt;
    if (w.timer <= 0) pickNext(w, ctx, end, random);
  } else if (w.mode === "turn") {
    w.turn = Math.min(1, w.turn + dt / TURN_SECONDS);
    if (w.turn >= 1) {
      w.face = w.face > 0 ? -1 : 1;
      w.mode = "walk";
    }
  }
  let desired = 0;
  let ahead = 0;
  if (w.mode === "walk") {
    ahead = (w.target - w.x) * w.face;
    desired = ctx.held ? 0 : Math.min(w.maxSpeed, Math.sqrt(2 * DECELERATION * Math.max(0, ahead)));
    if (ctx.phase === "leaving" && !ctx.held) desired = Math.max(desired, EXIT_SPEED);
  }
  w.v =
    desired > w.v
      ? Math.min(desired, w.v + ACCELERATION * dt)
      : Math.max(desired, w.v - DECELERATION * 1.15 * dt);
  w.x += w.face * w.v * dt;
  w.gait += (w.v * dt) / HOP_PX;
  if (ctx.phase !== "on") return ctx.phase === "leaving" ? w.x >= ctx.width : w.x <= end;
  if (w.mode === "walk" && !ctx.held && ahead < 0.8 && w.v < 1.2) {
    w.v = 0;
    w.mode = "stand";
    w.timer = ctx.crowded ? between(5, 12, random) : between(3.5, 9, random);
  }
  return false;
}

function pickNext(w: Walker, ctx: WalkContext, end: number, random: Random) {
  const reach = ctx.crowded ? 22 : end;
  const lo = Math.max(0, w.x - reach);
  const hi = Math.min(end, w.x + reach);
  // Keep going the way it faces more often than not, if there is room.
  const room = w.face > 0 ? hi - w.x : w.x - lo;
  let dir: 1 | -1 = room > 12 && random() < 0.6 ? w.face : w.face > 0 ? -1 : 1;
  let span = dir > 0 ? hi - w.x : w.x - lo;
  if (span < 6) {
    dir = dir > 0 ? -1 : 1;
    span = dir > 0 ? hi - w.x : w.x - lo;
  }
  w.target = w.x + dir * between(Math.min(6, span), span, random);
  if (dir !== w.face) startTurn(w);
  else w.mode = "walk";
}

function startTurn(w: Walker) {
  w.mode = "turn";
  w.turn = 0;
}

/** The mascot's pose for this frame: where it is and how its body hops, tilts and faces. */
export function walkerPose(w: Walker, seconds: number) {
  const amount = Math.min(1, w.v / 10);
  const swing = Math.sin(Math.PI * w.gait);
  const lift = Math.abs(swing);
  let y = -1.3 * lift * amount;
  const tilt = 3 * swing * amount + w.face * 2 * amount;
  const land = Math.pow(1 - lift, 6) * amount;
  const breath = Math.sin(seconds * 1.745 + w.breath) * (1 - amount);
  let scaleX = (1 + 0.03 * land) * (1 - 0.009 * breath);
  const scaleY = (1 - 0.04 * land) * (1 + 0.018 * breath);
  let facing: number = w.face;
  if (w.mode === "turn") {
    const t = w.turn < 0.5 ? 4 * w.turn ** 3 : 1 - (-2 * w.turn + 2) ** 3 / 2;
    const c = Math.cos(Math.PI * t);
    facing = (c >= 0 ? w.face : -w.face) * Math.max(0.2, Math.abs(c));
    y -= 1.1 * Math.sin(Math.PI * w.turn);
  }
  scaleX *= facing;
  return { x: w.x, y, tilt, scaleX, scaleY, moving: w.v > 1 };
}
