import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { createPortal } from "react-dom";

import { type ModalOverlay as OfficialModalOverlay } from "#src/components/application/modals/modal";
import { OVERLAY_SCRIM_Z } from "#src/lib/overlay-layer";
import { cx } from "#src/utils/cx";

const SERVER_VIEWPORT_SIZE = { width: 0, height: 0 };
let cachedViewportSize = SERVER_VIEWPORT_SIZE;

function subscribeViewportSize(onChange: () => void) {
  window.addEventListener("resize", onChange);
  window.visualViewport?.addEventListener("resize", onChange);
  return () => {
    window.removeEventListener("resize", onChange);
    window.visualViewport?.removeEventListener("resize", onChange);
  };
}

function readViewportSize() {
  if (typeof window === "undefined") return SERVER_VIEWPORT_SIZE;
  const width = Math.round(window.visualViewport?.width ?? window.innerWidth);
  const height = Math.round(window.visualViewport?.height ?? window.innerHeight);
  if (cachedViewportSize.width !== width || cachedViewportSize.height !== height) {
    cachedViewportSize = { width, height };
  }
  return cachedViewportSize;
}

const ignoreViewportSize = () => () => {};

export function useVisualViewportSize(enabled: boolean) {
  return useSyncExternalStore(
    enabled ? subscribeViewportSize : ignoreViewportSize,
    enabled ? readViewportSize : () => SERVER_VIEWPORT_SIZE,
    () => SERVER_VIEWPORT_SIZE,
  );
}

const outsideInertCounts = new WeakMap<HTMLElement, number>();
const SKIP_INERT_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE"]);

export function acquireOutsideInert(portalContainer: Element): () => void {
  const acquired: HTMLElement[] = [];
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child === portalContainer || child.contains(portalContainer)) break;
    if (SKIP_INERT_TAGS.has(child.tagName)) continue;
    if (
      child.dataset.liveAnnouncer === "true" ||
      child.hasAttribute("data-live-announcer") ||
      child.hasAttribute("data-react-aria-top-layer")
    ) {
      continue;
    }
    const count = outsideInertCounts.get(child) ?? 0;
    if (count === 0 && child.inert) continue;
    outsideInertCounts.set(child, count + 1);
    child.inert = true;
    acquired.push(child);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const child of acquired) {
      const next = (outsideInertCounts.get(child) ?? 0) - 1;
      if (next <= 0) {
        outsideInertCounts.delete(child);
        child.inert = false;
      } else {
        outsideInertCounts.set(child, next);
      }
    }
  };
}

export function resolveScrimConfig(
  className: ComponentProps<typeof OfficialModalOverlay>["className"],
  instant: boolean,
): { enabled: boolean; className: string } {
  const staticClass = typeof className === "string" ? className : "";
  if (staticClass.includes("bg-transparent")) {
    return { enabled: false, className: "" };
  }
  const hasLightOverlay = staticClass.includes("bg-overlay/30");
  const noBlur = staticClass.includes("backdrop-blur-none");
  return {
    enabled: true,
    className: cx(
      hasLightOverlay ? "bg-overlay/30" : "bg-modal-scrim/70",
      !noBlur && "backdrop-blur-[6px]",
      !instant && "motion-enter animate-in fade-in scrim-in",
    ),
  };
}

export function PageCoordinateScrim({
  open,
  className,
  portalContainer,
  zIndex = OVERLAY_SCRIM_Z,
}: {
  open: boolean;
  className: string;
  portalContainer?: Element | null;
  zIndex?: number;
}) {
  const [box, setBox] = useState<{ top: number; height: number }>({ top: 0, height: 0 });

  useLayoutEffect(() => {
    if (!open || typeof window === "undefined") return;
    const sync = () => {
      const top = Math.max(0, window.scrollY);
      const docHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
        window.innerHeight,
      );
      const height = Math.max(
        window.innerHeight,
        Math.min(docHeight - top, window.innerHeight * 1.25),
      );
      setBox({ top, height });
    };
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, { passive: true });
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync);
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      aria-hidden="true"
      data-page-scrim=""
      style={{
        top: `${box.top}px`,
        height: box.height > 0 ? `${box.height}px` : "100dvh",
        zIndex,
      }}
      className={cx("pointer-events-auto absolute inset-x-0", className)}
    />,
    portalContainer ?? document.body,
  );
}

export function useKeepFocusedFieldInView(open: boolean) {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!open || !viewport) return;
    let dialog: Element | null | undefined;
    const reveal = () => {
      const field = document.activeElement;
      if (
        field instanceof HTMLElement &&
        dialog?.contains(field) &&
        field.matches("input, textarea, [contenteditable]")
      )
        field.scrollIntoView({ block: "nearest" });
    };
    const resized = new ResizeObserver(reveal);
    const watch = () => {
      dialog = document.activeElement?.closest('[role="dialog"], [role="alertdialog"]');
      resized.disconnect();
      if (dialog) resized.observe(dialog);
    };
    viewport.addEventListener("resize", watch);
    return () => {
      viewport.removeEventListener("resize", watch);
      resized.disconnect();
    };
  }, [open]);
}
