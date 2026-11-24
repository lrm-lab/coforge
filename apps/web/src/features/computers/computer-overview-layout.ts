import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { createDevicePreference } from "#src/features/settings/device-preference";

export type ComputersOverviewLayout = "card" | "list";

const layoutPreference = createDevicePreference<ComputersOverviewLayout>({
  key: "coforge-computers-layout",
  parse: (stored) => (stored === "list" ? "list" : "card"),
  serialize: (layout) => layout,
  fallback: "card",
});

export const useComputersOverviewLayout = layoutPreference.useValue;

export const DETAIL_WIDTH_DEFAULT_REM = 43;
export const DETAIL_WIDTH_MIN_REM = 26;
export const DETAIL_WIDTH_MAX_REM = 56;

export function clampDetailWidth(widthRem: number): number {
  return Math.min(DETAIL_WIDTH_MAX_REM, Math.max(DETAIL_WIDTH_MIN_REM, widthRem));
}

const widthPreference = createDevicePreference<number>({
  key: "coforge-computers-detail-width-rem",
  parse: (stored) => {
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? clampDetailWidth(parsed) : DETAIL_WIDTH_DEFAULT_REM;
  },
  serialize: (width) => String(Math.round(width * 10) / 10),
  fallback: DETAIL_WIDTH_DEFAULT_REM,
});

function applyDetailWidthDom(
  pane: HTMLElement | null,
  separator: HTMLDivElement | null,
  widthRem: number,
) {
  pane?.style.setProperty("--computer-detail-width", `${widthRem}rem`);
  separator?.setAttribute("aria-valuenow", String(Math.round(widthRem * 10) / 10));
}

export function useComputerDetailWidth() {
  const [storedWidth, setStoredWidth] = widthPreference.useValue();
  const [widthRem, setWidthRem] = useState(storedWidth);
  const [resizing, setResizing] = useState(false);
  const paneRef = useRef<HTMLElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(widthRem);
  const detachDragRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    widthRef.current = widthRem;
  }, [widthRem]);

  useEffect(() => {
    if (!resizing) setWidthRem(storedWidth);
  }, [resizing, storedWidth]);

  useEffect(() => {
    return () => {
      detachDragRef.current?.();
      detachDragRef.current = null;
    };
  }, []);

  const commitWidth = useCallback(
    (next: number) => {
      const clamped = clampDetailWidth(next);
      widthRef.current = clamped;
      applyDetailWidthDom(paneRef.current, separatorRef.current, clamped);
      setWidthRem(clamped);
      setStoredWidth(clamped);
    },
    [setStoredWidth],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      detachDragRef.current?.();
      const rootFontSize =
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize || "16") || 16;
      const startX = event.clientX;
      const startWidthRem = widthRef.current;
      const directionSign = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
      let pendingWidth = startWidthRem;
      setResizing(true);

      const onMove = (moveEvent: globalThis.PointerEvent) => {
        const deltaRem = ((startX - moveEvent.clientX) * directionSign) / rootFontSize;
        pendingWidth = clampDetailWidth(startWidthRem + deltaRem);
        applyDetailWidthDom(paneRef.current, separatorRef.current, pendingWidth);
      };
      const detach = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (detachDragRef.current === detach) detachDragRef.current = null;
      };
      const onUp = () => {
        detach();
        setResizing(false);
        commitWidth(pendingWidth);
      };

      detachDragRef.current = detach;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [commitWidth],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const directionSign = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
      const step = event.shiftKey ? 4 : 2;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        commitWidth(widthRef.current + step * directionSign);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        commitWidth(widthRef.current - step * directionSign);
      } else if (event.key === "Home") {
        event.preventDefault();
        commitWidth(DETAIL_WIDTH_MIN_REM);
      } else if (event.key === "End") {
        event.preventDefault();
        commitWidth(DETAIL_WIDTH_MAX_REM);
      }
    },
    [commitWidth],
  );

  const onReset = useCallback(() => commitWidth(DETAIL_WIDTH_DEFAULT_REM), [commitWidth]);

  return {
    paneRef,
    separatorRef,
    widthRem,
    resizing,
    onPointerDown,
    onKeyDown,
    onReset,
  };
}
