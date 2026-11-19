import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  DragOverlay,
  type ClientRect,
  type DropAnimationFunction,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { createPortal } from "react-dom";
import { spring } from "motion/react";

import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { cx } from "#src/utils/cx";
import { closedSlots, gapAt, lineAt, ripple, sourceExtent, type Slot } from "./ripple-geometry";

export type DragRippleAxis = "x" | "y";
export type RippleTarget = { list: string; gap: number };
type Point = { x: number; y: number };

const SETTLE = cssSpring(0.3, 0.1);
const LIFT = cssSpring(0.18, 0.4);
const LEAVE_MARGIN = 24;
const LIFT_ROOM = 64;
const SETTLE_TIMEOUT_MS = 3000;
const LIST_ATTRIBUTE = "data-ripple-list";
const ITEM_ATTRIBUTE = "data-ripple-key";

function cssSpring(visualDuration: number, bounce: number) {
  const [duration = "0ms", ...curve] = String(spring(visualDuration, bounce)).split(" ");
  const easing = curve.join(" ");
  return { css: `${duration} ${easing}`, ms: Number.parseFloat(duration), easing };
}

type MeasuredList = { container: HTMLElement; keys: string[]; slots: Slot[]; corners: Point[] };
type Source = { list: string; key: string };
type Settle = {
  target: RippleTarget | null;
  signature: string;
  home: string;
  index: number;
  extent: number;
  sourceShift: Point;
};

function measure(container: HTMLElement, axis: DragRippleAxis): MeasuredList {
  const box = container.getBoundingClientRect();
  const items = [...container.querySelectorAll<HTMLElement>(`[${ITEM_ATTRIBUTE}]`)].filter(
    (item) => item.parentElement?.closest(`[${LIST_ATTRIBUTE}]`) === container,
  );
  const rects = items.map((item) => item.getBoundingClientRect());
  return {
    container,
    keys: items.map((item) => item.getAttribute(ITEM_ATTRIBUTE) ?? ""),
    corners: rects.map((rect) => ({ x: rect.left - box.left, y: rect.top - box.top })),
    slots: rects.map((rect) =>
      axis === "x"
        ? { start: rect.left - box.left, size: rect.width }
        : { start: rect.top - box.top, size: rect.height },
    ),
  };
}

function along(axis: DragRippleAxis, offset: number): Point {
  return axis === "x" ? { x: offset, y: 0 } : { x: 0, y: offset };
}

function translate({ x, y }: Point) {
  return x === 0 && y === 0 ? undefined : `translate3d(${x}px, ${y}px, 0)`;
}

type OverlayDrop = Parameters<DropAnimationFunction>[0];

export function flyOverlay(
  dragOverlay: OverlayDrop["dragOverlay"],
  transform: OverlayDrop["transform"],
  to: Point,
) {
  const options = { duration: SETTLE.ms, easing: SETTLE.easing, fill: "forwards" as const };
  const lifted = dragOverlay.node.firstElementChild;
  if (lifted instanceof HTMLElement)
    lifted.animate(
      [{ transform: getComputedStyle(lifted).transform }, { transform: "none" }],
      options,
    );
  const released = dragOverlay.node.getBoundingClientRect();
  const final = { x: transform.x + to.x - released.left, y: transform.y + to.y - released.top };
  return dragOverlay.node
    .animate(
      [
        { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` },
        { transform: `translate3d(${final.x}px, ${final.y}px, 0)` },
      ],
      options,
    )
    .finished.then(() => undefined);
}

export function liftFor(axis: DragRippleAxis, below = false): CSSProperties {
  return {
    transform:
      axis === "y"
        ? "translate3d(40px, 0, 0) scale(0.9)"
        : `translate3d(0, calc(${below ? "" : "-"}100% ${below ? "+" : "-"} 6px), 0)`,
    transformOrigin: axis === "x" ? "center" : "left center",
    animation: `drag-ripple-lift ${LIFT.css} both`,
  };
}

export function useDragRipple({
  axis,
  amplitude,
  signature,
  keyboardFallback,
}: {
  axis: DragRippleAxis;
  amplitude: number;
  signature: string;
  keyboardFallback?: KeyboardCoordinateGetter;
}) {
  const reduced = usePrefersReducedMotion();
  const containers = useRef(new Map<string, HTMLElement>());
  const measured = useRef(new Map<string, MeasuredList>());
  const landing = useRef<Point | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [ready, setReady] = useState(false);
  const [liftBelow, setLiftBelow] = useState(false);
  const [target, setTarget] = useState<RippleTarget | null>(null);
  const [settle, setSettle] = useState<Settle | null>(null);
  const [flying, setFlying] = useState<string | null>(null);

  const settling = settle !== null && settle.signature === signature;

  useLayoutEffect(() => {
    if (!source || ready) return;
    measured.current = new Map(
      [...containers.current].map(([id, container]) => [id, measure(container, axis)]),
    );
    const home = measured.current.get(source.list)?.container.getBoundingClientRect();
    setLiftBelow(home !== undefined && home.top < LIFT_ROOM);
    setReady(true);
  }, [source, ready, axis]);

  useEffect(() => {
    if (!settle) return;
    if (!settling) {
      setSettle(null);
      return;
    }
    const timer = window.setTimeout(
      () => {
        setFlying(null);
        setSettle(settle.target ? { ...settle, target: null } : null);
      },
      settle.target ? SETTLE_TIMEOUT_MS : SETTLE.ms,
    );
    return () => window.clearTimeout(timer);
  }, [settle, settling]);

  const indexIn = (list: string, key: string) => {
    const index = measured.current.get(list)?.keys.indexOf(key) ?? -1;
    return index >= 0 ? index : null;
  };
  const origin = source && ready ? measured.current.get(source.list) : undefined;
  const home = source && origin ? indexIn(source.list, source.key) : null;
  const homeIn = (list: string) => (source?.list === list ? home : null);
  const extent = origin && home !== null ? sourceExtent(origin.slots, home) : 0;
  const restingSlots = (list: string) => {
    const slots = measured.current.get(list)?.slots ?? [];
    return reduced ? slots : closedSlots(slots, homeIn(list));
  };
  const ownSlot = ({ list, gap }: RippleTarget) => {
    const index = homeIn(list);
    return index !== null && (gap === index || (reduced && gap === index + 1));
  };
  const shown = target && !ownSlot(target) ? target : null;

  const begin = useCallback((list: string, key: string) => {
    setSettle(null);
    setTarget(null);
    setReady(false);
    setFlying(key);
    setSource({ list, key });
  }, []);

  const entryOf = (list: string) => {
    const container = containers.current.get(list);
    if (!container) return undefined;
    const entry = measured.current.get(list);
    if (entry?.container === container) return entry;
    const fresh = measure(container, axis);
    measured.current.set(list, fresh);
    return fresh;
  };

  const move = (
    dragged: ClientRect | null,
    lists: readonly string[],
    snap?: (target: RippleTarget) => number,
  ) => {
    if (!ready || !dragged) return;
    const point = { x: dragged.left + dragged.width / 2, y: dragged.top + dragged.height / 2 };
    let next: RippleTarget | null = null;
    let nearest = LEAVE_MARGIN;
    for (const list of lists) {
      const entry = entryOf(list);
      if (!entry) continue;
      const box = entry.container.getBoundingClientRect();
      const distance = Math.max(
        box.left - point.x,
        point.x - box.right,
        box.top - point.y,
        point.y - box.bottom,
        0,
      );
      if (distance > nearest || (next && distance === nearest)) continue;
      nearest = distance;
      const local = axis === "x" ? point.x - box.left : point.y - box.top;
      next = { list, gap: gapAt(restingSlots(list), local) };
    }
    if (next && snap) next = { ...next, gap: snap(next) };
    if (next?.list !== target?.list || next?.gap !== target?.gap) setTarget(next);
  };

  const step = (direction: 1 | -1): number | null => {
    const list = target?.list ?? source?.list;
    const entry = list === undefined ? undefined : entryOf(list);
    if (!entry || !ready || list === undefined) return null;
    const slots = restingSlots(list);
    const gap = (target?.list === list ? target.gap : (homeIn(list) ?? 0)) + direction;
    if (gap < 0 || gap > slots.length) return null;
    const box = entry.container.getBoundingClientRect();
    return (axis === "x" ? box.left : box.top) + lineAt(slots, gap);
  };
  const latestStep = useRef(step);
  latestStep.current = step;
  const keyboardCoordinates = useCallback<KeyboardCoordinateGetter>(
    (event, args) => {
      const [back, forward] = axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
      const direction = event.code === forward ? 1 : event.code === back ? -1 : 0;
      const line = direction === 0 ? null : latestStep.current(direction);
      const rect = args.context.collisionRect;
      if (line === null || !rect) return keyboardFallback?.(event, args);
      return axis === "x"
        ? { x: line - rect.width / 2, y: args.currentCoordinates.y }
        : { x: args.currentCoordinates.x, y: line - rect.height / 2 };
    },
    [axis, keyboardFallback],
  );

  const placedOf = (drop: RippleTarget | null) => {
    if (!drop) return null;
    const index = homeIn(drop.list);
    return reduced && index !== null && drop.gap > index ? { ...drop, gap: drop.gap - 1 } : drop;
  };

  const landingFor = (placed: RippleTarget | null): Point => {
    const homeCorner = origin!.corners[home!]!;
    const list = placed ? measured.current.get(placed.list)! : origin!;
    const box = list.container.getBoundingClientRect();
    let start = axis === "x" ? homeCorner.x : homeCorner.y;
    if (placed) {
      const closed = closedSlots(list.slots, homeIn(placed.list));
      const after = closed[placed.gap];
      const before = closed[placed.gap - 1];
      const size = origin!.slots[home!]!.size;
      start = after ? after.start : before ? before.start + before.size + extent - size : 0;
    }
    return axis === "x"
      ? { x: box.left + start, y: box.top + homeCorner.y }
      : { x: box.left + homeCorner.x, y: box.top + start };
  };

  const end = (commit: boolean): RippleTarget | null => {
    const placed = placedOf(commit ? shown : null);
    landing.current = null;
    if (source && origin && home !== null) {
      const to = landingFor(placed);
      const box = origin.container.getBoundingClientRect();
      const corner = origin.corners[home]!;
      landing.current = to;
      setSettle({
        target: placed,
        signature,
        home: source.list,
        index: home,
        extent,
        sourceShift: { x: to.x - box.left - corner.x, y: to.y - box.top - corner.y },
      });
    }
    setSource(null);
    setTarget(null);
    setReady(false);
    if (reduced || !landing.current) setFlying(null);
    return placed;
  };

  const dropAnimation: DropAnimationFunction = ({ dragOverlay, transform }) => {
    const to = landing.current;
    landing.current = null;
    const land = () => setFlying(null);
    if (!to || reduced) return land();
    return flyOverlay(dragOverlay, transform, to).then(land, land);
  };

  const draggingStyle = (list: string, index: number): CSSProperties | undefined => {
    const homeIndex = homeIn(list);
    if (index === homeIndex) return undefined;
    const after = homeIndex !== null && index > homeIndex;
    let offset = after ? -extent : 0;
    let delay = 0;
    if (shown?.list === list) {
      const shift = ripple(after ? index - 1 : index, shown.gap, amplitude);
      offset += shift.offset;
      delay = shift.delayMs;
    }
    return {
      transform: translate(along(axis, offset)),
      transition: `transform var(--duration-sm) var(--ease-in-out) ${delay}ms`,
    };
  };

  const settlingStyle = (list: string, index: number, current: Settle): CSSProperties => {
    const isHome = current.home === list;
    if (isHome && index === current.index) return { transform: translate(current.sourceShift) };
    let offset = 0;
    const after = isHome && index > current.index;
    if (current.target) {
      if (after) offset -= current.extent;
      if (current.target.list === list && (after ? index - 1 : index) >= current.target.gap)
        offset += current.extent;
    }
    return {
      transform: translate(along(axis, offset)),
      transition: "transform var(--duration-sm) var(--ease-in-out)",
    };
  };

  const itemStyle = (list: string, key: string): CSSProperties | undefined => {
    if (reduced) return source?.key === key ? { opacity: 0.3 } : undefined;
    const hidden = key === flying ? { opacity: 0 } : undefined;
    if (!(source && ready) && !settling) return hidden;
    const index = indexIn(list, key);
    if (index === null) return hidden;
    const moved =
      source && ready ? draggingStyle(list, index) : settlingStyle(list, index, settle!);
    return { ...moved, ...hidden };
  };

  const line = (list: string): number | null =>
    source && ready && shown?.list === list ? lineAt(restingSlots(list), shown.gap) : null;

  const listRefs = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const listRef = (id: string) => {
    let ref = listRefs.current.get(id);
    if (!ref) {
      ref = (node) => {
        if (node) containers.current.set(id, node);
        else containers.current.delete(id);
      };
      listRefs.current.set(id, ref);
    }
    return ref;
  };

  const liftStyle = reduced ? undefined : liftFor(axis, liftBelow);

  return {
    axis,
    begin,
    move,
    keyboardCoordinates,
    end,
    dropAnimation,
    itemStyle,
    line,
    listRef,
    liftStyle,
  };
}

export type DragRipple = ReturnType<typeof useDragRipple>;

export function rippleListProps(ripple: DragRipple, id: string) {
  return {
    "data-ripple-list": id,
    ref: ripple.listRef(id),
  };
}

export function rippleItemProps(ripple: DragRipple, list: string, key: string) {
  return { "data-ripple-key": key, style: ripple.itemStyle(list, key) };
}

export function DragRippleLine({
  ripple,
  list,
  className,
}: {
  ripple: DragRipple;
  list: string;
  className?: string;
}) {
  const at = ripple.line(list);
  if (at === null) return null;
  const horizontal = ripple.axis === "x";
  return (
    <span
      aria-hidden="true"
      className={cx(
        "pointer-events-none absolute z-10",
        horizontal ? "inset-y-1.5 left-0 w-px" : "inset-x-2 top-0 h-px",
        className,
      )}
      style={{
        transform: translate(along(ripple.axis, at - 0.5)),
        transition: "transform var(--duration-sm) var(--ease-in-out)",
      }}
    >
      <span
        className="block size-full bg-current opacity-15"
        style={{
          animation: `${horizontal ? "drag-ripple-grow-y" : "drag-ripple-grow-x"} var(--duration-sm) var(--ease-out) both`,
        }}
      />
    </span>
  );
}

export function DragRippleOverlay({
  ripple,
  children,
}: {
  ripple: DragRipple;
  children: ReactNode;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <DragOverlay dropAnimation={ripple.dropAnimation} className="pointer-events-none">
      {children}
    </DragOverlay>,
    document.body,
  );
}
