import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useHotkey } from "@tanstack/react-hotkeys";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ArtifactMobileSheet } from "./artifact-mobile-sheet";

const STORAGE_KEY = "coforge:artifact-side-panel-width-rem";
const DEFAULT_WIDTH_REM = 21.25;
const MIN_WIDTH_REM = 18;
const MAX_WIDTH_REM = 32;
const KEY_STEP_REM = 1;
const KEY_FAST_STEP_REM = 2;

function clampRem(value: number): number {
  return Math.min(MAX_WIDTH_REM, Math.max(MIN_WIDTH_REM, Math.round(value * 100) / 100));
}

function readStoredWidth(): number {
  if (typeof localStorage === "undefined") return DEFAULT_WIDTH_REM;
  try {
    const raw = Number.parseFloat(localStorage.getItem(STORAGE_KEY) ?? "");
    return Number.isFinite(raw) ? clampRem(raw) : DEFAULT_WIDTH_REM;
  } catch {
    return DEFAULT_WIDTH_REM;
  }
}

function writeStoredWidth(widthRem: number) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, String(widthRem));
  } catch {}
}

export function ArtifactSidePanel({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useHotkey("Escape", () => {
    const hasOuterOverlay = [...document.querySelectorAll(OPEN_OVERLAY_SELECTOR)].some(
      (element) => !element.hasAttribute("data-artifact-mobile-sheet"),
    );
    if (hasOuterOverlay) return;
    if (document.querySelector("[data-artifact-find-bar], [data-review-card]")) return;
    onClose();
  });
  const wide = useBreakpoint("sm");
  const [widthRem, setWidthRem] = useState(DEFAULT_WIDTH_REM);
  const [resizing, setResizing] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const cleanupDragRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setWidthRem(readStoredWidth());
  }, []);

  useEffect(() => () => cleanupDragRef.current?.(), []);

  const commitWidth = useCallback((next: number) => {
    const clamped = clampRem(next);
    asideRef.current?.style.setProperty("--artifact-side-panel-width", `${clamped}rem`);
    setWidthRem(clamped);
    writeStoredWidth(clamped);
  }, []);

  const onSeparatorPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    cleanupDragRef.current?.();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startRem = widthRem;
    const rootFontSize =
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const rtl = getComputedStyle(asideRef.current ?? document.documentElement).direction === "rtl";
    const directionSign = rtl ? -1 : 1;
    let latestRem = startRem;
    setResizing(true);

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const deltaRem = ((startX - moveEvent.clientX) * directionSign) / rootFontSize;
      latestRem = clampRem(startRem + deltaRem);
      asideRef.current?.style.setProperty("--artifact-side-panel-width", `${latestRem}rem`);
      separatorRef.current?.setAttribute("aria-valuenow", String(Math.round(latestRem * 10) / 10));
    };

    const cleanup = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onFinish);
      target.removeEventListener("pointercancel", onFinish);
      cleanupDragRef.current = null;
    };

    const onFinish = () => {
      cleanup();
      setResizing(false);
      setWidthRem(latestRem);
      writeStoredWidth(latestRem);
    };

    cleanupDragRef.current = cleanup;
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onFinish);
    target.addEventListener("pointercancel", onFinish);
  };

  const onSeparatorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_FAST_STEP_REM : KEY_STEP_REM;
    const rtl = getComputedStyle(asideRef.current ?? document.documentElement).direction === "rtl";
    const directionSign = rtl ? -1 : 1;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      commitWidth(widthRem + step * directionSign);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      commitWidth(widthRem - step * directionSign);
    } else if (event.key === "Home") {
      event.preventDefault();
      commitWidth(MIN_WIDTH_REM);
    } else if (event.key === "End") {
      event.preventDefault();
      commitWidth(MAX_WIDTH_REM);
    }
  };

  if (!wide) {
    return (
      <ArtifactMobileSheet label={label} onClose={onClose}>
        {children}
      </ArtifactMobileSheet>
    );
  }

  return (
    <>
      {resizing && <div aria-hidden="true" className="fixed inset-0 z-50 cursor-col-resize" />}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 z-20 hidden bg-overlay/25 sm:block @3xl/artifact:hidden"
      />
      <aside
        ref={asideRef}
        aria-label={label}
        style={{ "--artifact-side-panel-width": `${widthRem}rem` } as CSSProperties}
        className={cn(
          "relative flex w-[21.25rem] shrink-0 flex-col border-s border-secondary bg-primary @3xl/artifact:w-(--artifact-side-panel-width)",
          "@max-3xl/artifact:absolute @max-3xl/artifact:inset-y-0 @max-3xl/artifact:end-0 @max-3xl/artifact:z-30 @max-3xl/artifact:max-w-[min(21.25rem,85vw)] @max-3xl/artifact:shadow-xl",
        )}
      >
        <div
          ref={separatorRef}
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={m.av_resize_side_panel()}
          aria-valuemin={MIN_WIDTH_REM}
          aria-valuemax={MAX_WIDTH_REM}
          aria-valuenow={Math.round(widthRem * 10) / 10}
          data-resizing={resizing ? "true" : undefined}
          onPointerDown={onSeparatorPointerDown}
          onKeyDown={onSeparatorKeyDown}
          onDoubleClick={() => commitWidth(DEFAULT_WIDTH_REM)}
          className="absolute inset-y-0 -start-1.5 z-20 hidden w-3 cursor-col-resize outline-focus-ring focus-visible:outline-2 @3xl/artifact:block after:absolute after:inset-y-0 after:start-1.5 after:w-px after:bg-transparent after:transition-colors hover:after:bg-brand-solid focus-visible:after:bg-brand-solid data-[resizing=true]:after:bg-brand-solid"
        />
        {children}
      </aside>
    </>
  );
}
