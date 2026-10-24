import { useEffect, useLayoutEffect, type Dispatch } from "react";

import {
  castArrived,
  castEntered,
  initialCast,
  stageCapacity,
  stepCast,
  type CastMember,
  type CastState,
} from "./busy-agents-cast";
import { newWalker, spreadX, stepWalker, walkerPose, type Walker } from "./busy-agents-motion";

/** How often the cast is reconsidered; the mascots themselves move every frame. */
const CAST_STEP_SECONDS = 0.25;
/** The mascots keep this far from the stage's left edge, so a focus ring is not cut off. */
const INSET_PX = 4;

/** One mascot's moving parts: the element that slides, the body that hops, and its motion, with
 * the transforms last written so an unchanged one is not written again. */
type Slot = {
  el: HTMLElement;
  body: HTMLElement | null;
  walker: Walker;
  transform: string;
  zIndex: string;
  bodyTransform: string;
};

/** What the stage's loop keeps between frames. It lives outside React's state on purpose: it
 * changes every frame, and React renders only when `members` does (`publishMembers`). */
export type StageLive = {
  state: CastState;
  /** The busy Agents' ids, most relevant first. */
  busy: readonly string[];
  /** The stage's width in px, less the inset. */
  width: number;
  /** The mascots the viewer is pointing at, focused on, or reading the card of, as of the last
   * cast step. */
  held: ReadonlySet<string>;
  slots: Map<string, Slot>;
  /** `castKey` of the members React was last given. */
  published: string;
};

export function newStageLive(): StageLive {
  return {
    state: initialCast(),
    busy: [],
    width: 0,
    held: new Set(),
    slots: new Map(),
    published: "",
  };
}

const castKey = (members: readonly CastMember[]) =>
  members.map((member) => `${member.id}:${member.phase}`).join(",");

/** Hands React the members when who is on stage, or in which phase, has changed. */
function publishMembers(live: StageLive, setMembers: Dispatch<readonly CastMember[]>) {
  const key = castKey(live.state.members);
  if (key === live.published) return;
  live.published = key;
  setMembers(live.state.members);
}

/** Whether the viewer is pointing at, focused on, or reading the card of this mascot. Only a
 * pointer that can hover points: on a touch device `:hover` sticks after a tap, which would hold
 * the mascot on stage for good. */
const isHeld = (el: HTMLElement, canHover: boolean) =>
  el.matches(canHover ? ":hover, :focus-within" : ":focus-within") ||
  el.querySelector('[aria-expanded="true"]') !== null;

function placeSlot(slot: Slot, x: number, lifted: boolean) {
  const transform = `translate3d(${(x + INSET_PX).toFixed(2)}px,0,0)`;
  if (transform !== slot.transform) slot.el.style.transform = slot.transform = transform;
  // The one moving is drawn over the ones standing.
  const zIndex = lifted ? "2" : "1";
  if (zIndex !== slot.zIndex) slot.el.style.zIndex = slot.zIndex = zIndex;
}

function poseBody(slot: Slot, pose: ReturnType<typeof walkerPose>) {
  if (!slot.body) return;
  const transform =
    `translate3d(0,${pose.y.toFixed(2)}px,0) rotate(${pose.tilt.toFixed(2)}deg) ` +
    `scale(${pose.scaleX.toFixed(3)},${pose.scaleY.toFixed(3)})`;
  if (transform !== slot.bodyTransform) slot.body.style.transform = slot.bodyTransform = transform;
}

/** A mascot's element mounts: it starts behind the count, or, on the first fill, spread out.
 * Returns what unmounts it. */
export function mountMascot(live: StageLive, id: string, el: HTMLElement): () => void {
  const { members } = live.state;
  const index = Math.max(
    0,
    members.findIndex((member) => member.id === id),
  );
  const entering = members[index]?.phase === "entering";
  const x = entering ? live.width : spreadX(index, members.length, live.width);
  const slot: Slot = {
    el,
    body: el.querySelector<HTMLElement>("[data-mascot-body]"),
    walker: newWalker(x, Math.random, entering),
    transform: "",
    zIndex: "",
    bodyTransform: "",
  };
  placeSlot(slot, x, false);
  live.slots.set(id, slot);
  return () => {
    live.slots.delete(id);
  };
}

function stepCastNow(live: StageLive, now: number, reduced: boolean) {
  const canHover = window.matchMedia("(hover: hover)").matches;
  live.held = new Set(
    [...live.slots].flatMap(([id, slot]) => (isHeld(slot.el, canHover) ? [id] : [])),
  );
  live.state = stepCast(
    live.state,
    {
      busy: live.busy,
      capacity: stageCapacity(live.width + INSET_PX),
      now,
      held: live.held,
      reduced,
    },
    Math.random,
  );
}

/** One frame of motion for every mascot on stage; reports the entrances and exits it finished. */
function moveMascots(
  live: StageLive,
  dt: number,
  time: number,
  setMembers: Dispatch<readonly CastMember[]>,
) {
  const { members } = live.state;
  for (const member of members) {
    const slot = live.slots.get(member.id);
    if (!slot) continue;
    const arrived = stepWalker(
      slot.walker,
      dt,
      {
        phase: member.phase,
        width: live.width,
        crowded: members.length >= 4,
        held: live.held.has(member.id),
      },
      Math.random,
    );
    if (arrived) {
      live.state = (member.phase === "leaving" ? castArrived : castEntered)(
        live.state,
        member.id,
        time,
      );
      publishMembers(live, setMembers);
    }
    const pose = walkerPose(slot.walker, time / 1000);
    placeSlot(slot, pose.x, pose.moving);
    poseBody(slot, pose);
  }
}

/** Reduced motion: the cast is settled once per change, and the mascots stand spread out. */
function settleStill(live: StageLive, setMembers: Dispatch<readonly CastMember[]>) {
  stepCastNow(live, performance.now(), true);
  publishMembers(live, setMembers);
  const { members } = live.state;
  members.forEach((member, index) => {
    const slot = live.slots.get(member.id);
    if (!slot) return;
    placeSlot(slot, spreadX(index, members.length, live.width), false);
    // Still means upright: motion that was on a moment ago leaves no tilt, hop or flip behind.
    if (slot.body && slot.bodyTransform !== "") {
      slot.body.style.transform = "";
      slot.bodyTransform = "";
    }
  });
}

/**
 * Runs the chat list header's stage: measures it, decides the cast (`busy-agents-cast.ts`), and
 * moves the mascots (`busy-agents-motion.ts`) by writing transforms straight to their elements, so
 * React renders only when `setMembers` is given a new cast. The animation-frame loop runs only
 * while the stage is `visible` (a conversation open on a small viewport hides the list), and with
 * `reduced` motion there is none: the cast settles when its inputs change.
 */
export function useStageLoop({
  live,
  stage,
  visible,
  busy,
  reduced,
  setMembers,
}: {
  live: StageLive;
  stage: HTMLElement | null;
  visible: boolean;
  busy: readonly string[];
  reduced: boolean;
  setMembers: Dispatch<readonly CastMember[]>;
}) {
  useLayoutEffect(() => {
    live.busy = busy;
  }, [live, busy]);

  // A raw ResizeObserver: the stage mounts only once something is busy, after the first render.
  useEffect(() => {
    if (!stage) return;
    const measure = () => {
      live.width = Math.max(0, stage.clientWidth - INSET_PX);
      if (reduced) settleStill(live, setMembers);
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(stage);
    return () => resize.disconnect();
  }, [live, stage, reduced, setMembers]);

  useEffect(() => {
    if (stage && reduced) settleStill(live, setMembers);
  }, [live, stage, reduced, busy, setMembers]);

  useEffect(() => {
    if (!stage || !visible || reduced) return;
    let last = performance.now();
    let sinceStep = Infinity;
    let frame = 0;
    const tick = (time: number) => {
      const dt = Math.min(0.05, (time - last) / 1000);
      last = time;
      sinceStep += dt;
      if (sinceStep >= CAST_STEP_SECONDS) {
        sinceStep = 0;
        stepCastNow(live, time, false);
        publishMembers(live, setMembers);
      }
      moveMascots(live, dt, time, setMembers);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [live, stage, visible, reduced, setMembers]);
}
