import { useEffect, useRef, type RefObject, type TouchEvent } from "react";

import {
  releaseTurn,
  SETTLE_EASE,
  settleMs,
  swipeAxis,
  trackOffset,
} from "./action-card-questions-steps";

/** The gap between a question and the one beside it while a finger brings it in (`--spacing(1)`). */
const PAGE_GAP = 4;
/** How far back the finger's speed is read when it lets go, in milliseconds. */
const VELOCITY_WINDOW_MS = 100;

type Pages = { current: HTMLElement; next?: HTMLElement; previous?: HTMLElement; width: number };
type Settling = { timer: ReturnType<typeof setTimeout>; turn: -1 | 0 | 1 };

/**
 * A questions card's sideways swipe on a touch screen (task #91, Frank: "选项卡的动画优化下").
 * While the finger is down the question is the finger, one to one, the one beside it coming in a
 * gap away; past the last question it resists (`trackOffset`). Let go, it turns on distance or on a
 * flick (`releaseTurn`) and lands at the speed it was let go (`settleMs`), or snaps back. A finger
 * that touches it while it lands catches it where it is.
 *
 * Moves are written straight to the three pages' `transform`, no React render per move. `onTurn`
 * is told once the turn has landed, so the page that comes in is already where the next render
 * puts it.
 */
export function useQuestionSwipe({
  pages,
  hasNext,
  hasPrevious,
  onTurn,
}: {
  pages: RefObject<HTMLElement | null>;
  hasNext: boolean;
  hasPrevious: boolean;
  onTurn: (delta: -1 | 1) => void;
}) {
  const touch = useRef<{
    x: number;
    y: number;
    from: number;
    axis?: "x" | "y";
    samples: { t: number; x: number }[];
  }>(undefined);
  const settling = useRef<Settling>(undefined);
  const offset = useRef(0);
  useEffect(() => () => clearTimeout(settling.current?.timer), []);

  const find = (): Pages | undefined => {
    const grid = pages.current;
    const current = grid?.querySelector<HTMLElement>(":scope > [data-question]");
    if (!grid || !current) return undefined;
    return {
      current,
      next: grid.querySelector<HTMLElement>(":scope > [data-question-next]") ?? undefined,
      previous: grid.querySelector<HTMLElement>(":scope > [data-question-previous]") ?? undefined,
      width: current.offsetWidth,
    };
  };
  const place = (found: Pages, at: number, transition: string) => {
    offset.current = at;
    const page = found.width + PAGE_GAP;
    for (const [element, base] of [
      [found.current, 0],
      [found.next, page],
      [found.previous, -page],
    ] as const) {
      if (!element) continue;
      element.style.transition = transition;
      element.style.transform = `translateX(${base + at}px)`;
      if (base) element.style.visibility = "visible";
    }
  };
  /** Back to the classes' own rest: the current page in place, the others hidden. */
  const rest = (found: Pages) => {
    offset.current = 0;
    for (const element of [found.current, found.next, found.previous]) {
      if (!element) continue;
      element.style.removeProperty("transition");
      element.style.removeProperty("transform");
      element.style.removeProperty("visibility");
    }
  };

  const onTouchStart = (event: TouchEvent) => {
    const point = event.touches[0];
    if (!point) return;
    const found = find();
    // Caught while it lands: hold it where it is now, and go on from there.
    if (settling.current && found) {
      clearTimeout(settling.current.timer);
      settling.current = undefined;
      place(found, new DOMMatrixReadOnly(getComputedStyle(found.current).transform).m41, "none");
    }
    touch.current = {
      x: point.clientX,
      y: point.clientY,
      from: offset.current,
      samples: [{ t: event.timeStamp, x: point.clientX }],
    };
  };

  const onTouchMove = (event: TouchEvent) => {
    const start = touch.current;
    const point = event.touches[0];
    if (!start || !point || (!hasNext && !hasPrevious)) return;
    const dx = point.clientX - start.x;
    start.axis ??= start.from ? "x" : swipeAxis(dx, point.clientY - start.y);
    if (start.axis !== "x") return;
    const found = find();
    if (!found) return;
    start.samples.push({ t: event.timeStamp, x: point.clientX });
    while (start.samples.length > 2 && event.timeStamp - start.samples[0]!.t > VELOCITY_WINDOW_MS)
      start.samples.shift();
    place(found, trackOffset(start.from + dx, found.width, hasNext, hasPrevious), "none");
  };

  const onTouchEnd = (event: TouchEvent) => {
    const start = touch.current;
    touch.current = undefined;
    const found = find();
    // A touch whose moves the browser folded into its end is judged by where it ended.
    const end = event.changedTouches[0];
    if (start && found && !start.axis && end && (hasNext || hasPrevious)) {
      const dx = end.clientX - start.x;
      start.axis = swipeAxis(dx, end.clientY - start.y);
      if (start.axis === "x") {
        start.samples.push({ t: event.timeStamp, x: end.clientX });
        offset.current = trackOffset(dx, found.width, hasNext, hasPrevious);
      }
    }
    if (!start || !found || start.axis !== "x") {
      if (found && offset.current) settle(found, 0);
      return;
    }
    const first = start.samples[0]!;
    const last = start.samples.at(-1)!;
    // A finger held still before it lifts has no speed left to give.
    const held = event.timeStamp - last.t > VELOCITY_WINDOW_MS;
    const velocity = !held && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
    settle(
      found,
      releaseTurn(offset.current, velocity, found.width, hasNext, hasPrevious),
      velocity,
    );
  };

  const settle = (found: Pages, turn: -1 | 0 | 1, velocity = 0) => {
    const target = -turn * (found.width + PAGE_GAP);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ms = reduced ? 0 : settleMs(Math.abs(target - offset.current), velocity);
    place(found, target, ms ? `transform ${ms}ms ${SETTLE_EASE}` : "none");
    const done = () => {
      settling.current = undefined;
      offset.current = 0;
      // A turn renders the page that came in as the current one, exactly where it landed; one
      // that snapped back goes back to the classes' rest.
      if (turn) onTurn(turn);
      else rest(found);
    };
    if (!ms) return done();
    settling.current = { timer: setTimeout(done, ms), turn };
  };

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd };
}
