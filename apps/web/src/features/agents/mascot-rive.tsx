import { useEffect, useRef, useState } from "react";
import { EventType, RiveFile, RuntimeLoader, type Rive } from "@rive-app/canvas-lite";
import riveWasmUrl from "@rive-app/canvas-lite/rive.wasm?url";
import {
  useRive,
  useViewModel,
  useViewModelInstance,
  useViewModelInstanceBoolean,
  useViewModelInstanceEnum,
} from "@rive-app/react-canvas-lite";

import type { AgentMascot } from "./agent-mascot";
import { followPointer } from "./mascot-look-tracker";
import { mascotsInMotion } from "./mascot-motion-budget";
import {
  MASCOT_RIVE,
  mascotArtboard,
  mascotRivUrl,
  type MascotActivity,
} from "./mascot-rive-contract";

// The runtime's WebAssembly is served from this app, never from a CDN, and this module is the only
// one that starts the runtime. With no fallback URL, a runtime that cannot load fails the file,
// and the mascots stay the still pictures they start as.
// https://rive.app/docs/runtimes/react/preloading-wasm.md
RuntimeLoader.setWasmUrl(riveWasmUrl);
RuntimeLoader.setWasmFallbackUrl(null);

let sharedFile: Promise<RiveFile> | undefined;

/**
 * The one Rive file every mascot canvas shares, fetched when the first canvas asks and kept for
 * the life of the page: the file counts the instances drawn from it, and the reference taken here
 * is never released, so the last canvas leaving does not unload it. A failed load stays failed,
 * and every mascot stays a still picture. Rive's guidance for a file used by many instances:
 * https://rive.app/docs/runtimes/react/caching-a-rive-file.md
 */
function mascotFile(): Promise<RiveFile> {
  sharedFile ??= new Promise<RiveFile>((resolve, reject) => {
    const file = new RiveFile({ src: mascotRivUrl() });
    file.on(EventType.Load, () => {
      file.getInstance();
      resolve(file);
    });
    file.on(EventType.LoadError, () => reject(new Error("The mascots' Rive file did not load")));
    void file.init();
  });
  return sharedFile;
}

/**
 * One mascot's canvas on the shared file. It owns its own view model instance, so what one mascot
 * acts out never reaches another that shares the file. The canvas listens to no pointer: the
 * wrapper around it does, and reports `hovered`; the eyes follow the pointer through the shared
 * watcher (`mascot-look-tracker.ts`). A canvas scrolled out of view pauses itself.
 * https://rive.app/docs/runtimes/react/data-binding.md
 */
export function MascotCanvas({
  mascot,
  activity,
  hovered,
  uncapped = false,
  onReady,
  onFailed,
}: {
  mascot: AgentMascot;
  activity: MascotActivity;
  hovered: boolean;
  /** Outside the limit on mascots moving at once (`mascot-motion-budget.ts`). */
  uncapped?: boolean;
  /** The canvas is bound and has drawn: the still picture beneath it may go. */
  onReady: () => void;
  onFailed: () => void;
}) {
  const [file, setFile] = useState<RiveFile | null>(null);
  useEffect(() => {
    let current = true;
    mascotFile().then(
      (loaded) => current && setFile(loaded),
      () => current && onFailed(),
    );
    return () => {
      current = false;
    };
  }, [onFailed]);
  // Keyed on the mascot: the Rive instance is made once per canvas and ignores a changed artboard.
  return (
    file && (
      <BoundMascot
        key={mascot}
        {...{ file, mascot, activity, hovered, uncapped, onReady, onFailed }}
      />
    )
  );
}

function BoundMascot({
  file,
  mascot,
  activity,
  hovered,
  uncapped = false,
  onReady,
  onFailed,
}: {
  file: RiveFile;
} & Parameters<typeof MascotCanvas>[0]) {
  const { rive, canvas, RiveComponent } = useRive({
    riveFile: file,
    artboard: mascotArtboard(mascot),
    stateMachine: MASCOT_RIVE.stateMachine,
    autoplay: true,
    autoBind: false,
    shouldDisableRiveListeners: true,
    onLoadError: onFailed,
  });
  const viewModel = useViewModel(rive, { name: MASCOT_RIVE.viewModel });
  const instance = useViewModelInstance(viewModel, { useNew: true, rive });
  const { setValue: setActivity } = useViewModelInstanceEnum(
    MASCOT_RIVE.activityProperty,
    instance,
  );
  const { setValue: setHovered } = useViewModelInstanceBoolean(
    MASCOT_RIVE.hoveredProperty,
    instance,
  );
  useEffect(() => setActivity(activity), [setActivity, activity]);
  // A file without the property leaves the mascot as it is.
  useEffect(() => setHovered(hovered), [setHovered, hovered]);
  // The eyes follow the pointer. The shared watcher writes the numbers straight into the view
  // model: a hook would hold each one in React state and render on every pointer move.
  useEffect(() => {
    const lookX = instance?.number(MASCOT_RIVE.lookXProperty);
    const lookY = instance?.number(MASCOT_RIVE.lookYProperty);
    if (!canvas || !lookX || !lookY) return;
    return followPointer(canvas, (look) => {
      lookX.value = look.x;
      lookY.value = look.y;
    });
  }, [instance, canvas]);
  const [bound, setBound] = useState(false);
  useEffect(() => {
    if (!instance || bound) return;
    // The first frame renders after the bind; the next one is on the canvas.
    const frame = requestAnimationFrame(() => {
      setBound(true);
      onReady();
    });
    return () => cancelAnimationFrame(frame);
  }, [instance, bound, onReady]);
  // Within the page's motion budget, or holding the frame it stopped on.
  const budgeted = useRef<BudgetedMascot | null>(null);
  useEffect(() => {
    if (!rive || !canvas) return;
    const mascot: BudgetedMascot = {
      rive,
      canvas,
      hovered: false,
      activity,
      changedAt: 0,
      uncapped,
      held: false,
    };
    budgeted.current = mascot;
    return joinMotionBudget(mascot);
  }, [rive, canvas, uncapped]);
  useEffect(() => {
    const mascot = budgeted.current;
    if (!mascot || mascot.hovered === hovered) return;
    mascot.hovered = hovered;
    // Leaving, it plays the reaction back out before it may hold still again.
    mascot.changedAt = performance.now();
    judgeMotionSoon();
  }, [hovered, rive, canvas]);
  useEffect(() => {
    const mascot = budgeted.current;
    if (!mascot || mascot.activity === activity) return;
    mascot.activity = activity;
    // A held mascot would go on showing the activity it stopped on: it moves while it settles.
    mascot.changedAt = performance.now();
    judgeMotionSoon();
  }, [activity, rive, canvas]);
  return <RiveComponent className="size-full" />;
}

/** A mounted canvas the motion budget plays or pauses; `held` is the budget's own pause. */
type BudgetedMascot = {
  rive: Rive;
  canvas: HTMLCanvasElement;
  hovered: boolean;
  activity: MascotActivity;
  /** When `activity` or `hovered` last changed (`performance.now()`), 0 for never. */
  changedAt: number;
  uncapped: boolean;
  held: boolean;
};

const budget = new Set<BudgetedMascot>();
const ids = new WeakMap<BudgetedMascot, string>();
let nextId = 0;
let judging: number | undefined;
let soon: number | undefined;
let entering: IntersectionObserver | undefined;
// Often enough that a face sliding out from behind another starts moving within a beat, rarely
// enough that the layout read it takes stays small next to one frame of drawing.
const JUDGE_EVERY_MS = 500;
// Long enough for a state machine to play a change of activity or hover through to its loop.
const SETTLE_MS = 1_500;

function joinMotionBudget(mascot: BudgetedMascot) {
  ids.set(mascot, String(nextId++));
  budget.add(mascot);
  // Judged in the next animation frame: the layout it reads is then the one that frame lays out
  // anyway, not an extra one forced between frames while the page scrolls.
  judging ??= window.setInterval(judgeMotionSoon, JUDGE_EVERY_MS);
  // A canvas scrolling into view is judged at once, before it moves past the limit for long.
  entering ??= new IntersectionObserver(judgeMotionSoon);
  entering.observe(mascot.canvas);
  judgeMotionSoon();
  return () => {
    budget.delete(mascot);
    entering?.unobserve(mascot.canvas);
    // The same instance may join again (a changed `uncapped`): it starts from playing.
    if (mascot.held) mascot.rive.play();
    if (budget.size === 0) {
      window.clearInterval(judging);
      judging = undefined;
      entering?.disconnect();
      entering = undefined;
    } else judgeMotionSoon();
  };
}

function judgeMotionSoon() {
  soon ??= requestAnimationFrame(() => {
    soon = undefined;
    judgeMotion();
  });
}

/** Measures every mounted mascot and plays or pauses each as `mascotsInMotion` says. Only a pause
 * this budget made is undone here: `play()` restarts drawing, which the runtime stops for a
 * canvas off screen. */
function judgeMotion() {
  const now = performance.now();
  const mascots = [...budget].sort((a, b) =>
    a.canvas.compareDocumentPosition(b.canvas) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
  const byId = new Map(mascots.map((mascot) => [ids.get(mascot)!, mascot]));
  const { play, pause } = mascotsInMotion(
    mascots.map((mascot) => {
      const box = mascot.canvas.getBoundingClientRect();
      const onScreen =
        box.width > 0 &&
        box.bottom > 0 &&
        box.right > 0 &&
        box.top < window.innerHeight &&
        box.left < window.innerWidth;
      const over = onScreen
        ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        : null;
      return {
        id: ids.get(mascot)!,
        onScreen,
        covered: over !== null && over !== mascot.canvas && !mascot.canvas.contains(over),
        hovered: mascot.hovered,
        settling: mascot.changedAt > 0 && now - mascot.changedAt < SETTLE_MS,
        atWork: mascot.activity === "working" || mascot.activity === "thinking",
        uncapped: mascot.uncapped,
      };
    }),
  );
  for (const id of play) {
    const mascot = byId.get(id)!;
    if (!mascot.held) continue;
    mascot.held = false;
    mascot.rive.play();
  }
  for (const id of pause) {
    const mascot = byId.get(id)!;
    if (mascot.held) continue;
    mascot.held = true;
    mascot.rive.pause();
  }
}
