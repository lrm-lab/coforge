import { lookToward, STRAIGHT_AHEAD, type MascotLook } from "./mascot-look";

/**
 * The one pointer watcher every moving mascot shares. A mascot registers the element it is drawn
 * in and a function that takes its look (`lookToward` of the pointer relative to the element's
 * centre); the watcher keeps a single passive `pointermove` listener on the document for all of
 * them, runs at most once per animation frame, and costs nothing while no mascot is registered.
 * It holds no React state: the caller writes the look straight into the Rive view model.
 *
 * The eyes ease back to straight ahead when the pointer leaves the window or the window loses
 * focus, and never leave it on a device without hover (`(hover: none)`) or for a touch pointer.
 * A mascot that moves under a still pointer (scrolling) looks again at the next pointer move.
 */
interface LookSink {
  element: Element;
  apply: (look: MascotLook) => void;
  /** What `apply` last received, so an unchanged look is not written again. */
  x: number;
  y: number;
}

const sinks = new Set<LookSink>();
let pointerX = 0;
let pointerY = 0;
let pointerInside = false;
let frame = 0;
let listening = false;

function flush(): void {
  frame = 0;
  for (const sink of sinks) {
    let look = STRAIGHT_AHEAD;
    if (pointerInside) {
      const box = sink.element.getBoundingClientRect();
      look = lookToward(
        pointerX - (box.left + box.width / 2),
        pointerY - (box.top + box.height / 2),
      );
    }
    if (look.x === sink.x && look.y === sink.y) continue;
    sink.x = look.x;
    sink.y = look.y;
    sink.apply(look);
  }
}

function schedule(): void {
  if (frame === 0) frame = requestAnimationFrame(flush);
}

function onPointerMove(event: PointerEvent): void {
  if (event.pointerType === "touch") return;
  pointerX = event.clientX;
  pointerY = event.clientY;
  pointerInside = true;
  schedule();
}

function onPointerGone(): void {
  pointerInside = false;
  schedule();
}

function listen(): void {
  document.addEventListener("pointermove", onPointerMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onPointerGone, { passive: true });
  window.addEventListener("blur", onPointerGone);
  listening = true;
}

function unlisten(): void {
  document.removeEventListener("pointermove", onPointerMove);
  document.documentElement.removeEventListener("pointerleave", onPointerGone);
  window.removeEventListener("blur", onPointerGone);
  if (frame !== 0) cancelAnimationFrame(frame);
  frame = 0;
  pointerInside = false;
  listening = false;
}

const hasHover = (): boolean => !window.matchMedia("(hover: none)").matches;

/**
 * Starts feeding `apply` with where the pointer lies relative to `element`; returns the stop
 * function. A device without hover is never fed: its mascots keep looking straight ahead.
 */
export function followPointer(element: Element, apply: (look: MascotLook) => void): () => void {
  if (!hasHover()) return () => {};
  const sink: LookSink = { element, apply, x: STRAIGHT_AHEAD.x, y: STRAIGHT_AHEAD.y };
  sinks.add(sink);
  if (!listening) listen();
  // A mascot that appears under a pointer already seen looks at it right away.
  if (pointerInside) schedule();
  return () => {
    sinks.delete(sink);
    if (sinks.size === 0 && listening) unlisten();
  };
}
