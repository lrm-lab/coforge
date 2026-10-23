import { lazy, Suspense, useCallback, useEffect, useState, type ComponentProps } from "react";

import { useNearViewport } from "#src/hooks/use-near-viewport";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { cx } from "#src/utils/cx";

import type { AgentMascot } from "./agent-mascot";
import { mascotStaticUrl } from "./mascot-contract";
import type { MascotCanvas as Canvas } from "./mascot-rive";
import type { MascotActivity } from "./mascot-rive-contract";

type CanvasProps = ComponentProps<typeof Canvas>;

// The Rive runtime, its WebAssembly and the code that drives it load as one chunk, and only when
// a mascot that may move is near the screen: a page of still pictures never pays for any of them.
// A chunk that cannot load leaves the still picture, like any other failure.
const MascotCanvas = lazy(() =>
  import("./mascot-rive").then(
    ({ MascotCanvas: canvas }) => ({ default: canvas }),
    () => ({ default: FailedCanvas }),
  ),
);

function FailedCanvas({ onFailed }: CanvasProps) {
  useEffect(onFailed, [onFailed]);
  return null;
}

const STILL_CLASS = "size-full object-contain";

/** The still picture with the Rive canvas over it; it goes once the canvas has drawn. Mounted only
 * while the mascot moves, so a mascot that scrolls away drops its canvas. The caller keys it on the
 * mascot: the Rive instance is made once per canvas and ignores a changed artboard. */
function MovingMascot({ onFailed, ...canvas }: Omit<CanvasProps, "onReady">) {
  const [ready, setReady] = useState(false);
  const markReady = useCallback(() => setReady(true), []);
  return (
    <>
      <img
        src={mascotStaticUrl(canvas.mascot)}
        alt=""
        className={cx(STILL_CLASS, ready && "invisible")}
      />
      <span className="absolute inset-0">
        <Suspense fallback={null}>
          <MascotCanvas {...canvas} onReady={markReady} onFailed={onFailed} />
        </Suspense>
      </span>
    </>
  );
}

/**
 * An Agent's mascot filling its parent: a still picture first (server render, hydration, reduced
 * motion, a failed load, anywhere off screen), and a Rive canvas over it once the shared file is
 * in and the mascot is near the viewport. The canvas acts out `activity` and reacts to the pointer
 * being over the picture. It is decorative; the avatar around it carries the name and status.
 */
export function AgentMascotView({
  mascot,
  activity,
  still = false,
  hovered: hoveredFromParent,
  className,
}: {
  mascot: AgentMascot;
  /** What the mascot acts out (`mascotActivity`). */
  activity: MascotActivity;
  /** The picture stays still whatever the Agent does (an archived Agent's, a copy of an avatar
   * already moving elsewhere on screen). */
  still?: boolean;
  /** Whether the pointer is over a larger target this picture belongs to (a list row), which
   * decides the mascot's `hovered` in place of the picture's own pointer. */
  hovered?: boolean;
  className?: string;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [hoveredOver, setHovered] = useState(false);
  const hovered = hoveredFromParent ?? hoveredOver;
  const [failed, setFailed] = useState(false);
  const mayMove = !still && !reducedMotion && !failed;
  const [watch, near] = useNearViewport(mayMove);
  const markFailed = useCallback(() => setFailed(true), []);
  return (
    <span
      ref={watch}
      aria-hidden="true"
      className={cx("relative block size-full", className)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {mayMove && near ? (
        <MovingMascot
          key={mascot}
          mascot={mascot}
          activity={activity}
          hovered={hovered}
          onFailed={markFailed}
        />
      ) : (
        <img src={mascotStaticUrl(mascot)} alt="" className={STILL_CLASS} />
      )}
    </span>
  );
}
