import { useEffect, useState } from "react";
import { EventType, RiveFile, RuntimeLoader } from "@rive-app/canvas-lite";
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
  onReady,
  onFailed,
}: {
  mascot: AgentMascot;
  activity: MascotActivity;
  hovered: boolean;
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
    file && <BoundMascot key={mascot} {...{ file, mascot, activity, hovered, onReady, onFailed }} />
  );
}

function BoundMascot({
  file,
  mascot,
  activity,
  hovered,
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
  return <RiveComponent className="size-full" />;
}
