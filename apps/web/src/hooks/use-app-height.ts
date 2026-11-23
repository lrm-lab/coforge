import { useLayoutEffect } from "react";

import { opensKeyboard } from "#src/hooks/use-keyboard-field-focused";
import { appHeight, tallestHeightSeen, viewportShapeKey } from "#src/lib/app-height";

const TALLEST_HEIGHTS_KEY = "coforge-app-height";
const SETTLE_AFTER_SYSTEM_ANIMATION_MS = 300;
const SAFE_AREA_PROBE_STYLE =
  "position:fixed;top:0;bottom:0;left:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";

type TallestHeights = Record<string, number>;

function readTallestHeights(): TallestHeights {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TALLEST_HEIGHTS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as TallestHeights) : {};
  } catch {
    return {};
  }
}

function writeTallestHeights(heights: TallestHeights) {
  try {
    localStorage.setItem(TALLEST_HEIGHTS_KEY, JSON.stringify(heights));
  } catch {
    return;
  }
}

function installedOnHomeScreen() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function useAppHeight() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = SAFE_AREA_PROBE_STYLE;
    document.body.append(probe);
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;

    const apply = () => {
      const installed = installedOnHomeScreen();
      if (!installed) {
        root.style.removeProperty("--app-height");
        root.removeAttribute("data-app-taller-than-viewport");
        return;
      }
      const probeStyle = getComputedStyle(probe);
      const key = viewportShapeKey(
        window.matchMedia("(orientation: landscape)").matches,
        window.screen.width,
      );
      const tallest = readTallestHeights();
      const measured = root.clientHeight;
      const applied = Number.parseFloat(root.style.getPropertyValue("--app-height"));
      const height = appHeight({
        measured,
        fixedViewportHeight: probe.getBoundingClientRect().height,
        installed,
        safeAreaTotal:
          Number.parseFloat(probeStyle.paddingTop) + Number.parseFloat(probeStyle.paddingBottom),
        onScreenKeyboardMayBeUp:
          window.matchMedia("(pointer: coarse)").matches &&
          opensKeyboard(document.activeElement as HTMLElement | null),
        applied: Number.isFinite(applied) ? applied : undefined,
        tallestSeen: tallest[key],
      });
      root.style.setProperty("--app-height", `${height}px`);
      root.toggleAttribute("data-app-taller-than-viewport", height > measured);
      if (tallest[key] !== tallestHeightSeen(tallest[key], measured))
        writeTallestHeights({ ...tallest, [key]: tallestHeightSeen(tallest[key], measured) });
    };

    const remeasure = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(apply, SETTLE_AFTER_SYSTEM_ANIMATION_MS);
    };
    const remeasureWhenVisible = () => {
      if (document.visibilityState === "visible") remeasure();
    };

    apply();
    window.addEventListener("pageshow", remeasure);
    window.addEventListener("resize", remeasure);
    window.addEventListener("focus", remeasure);
    document.addEventListener("focusout", remeasure);
    document.addEventListener("visibilitychange", remeasureWhenVisible);
    return () => {
      window.removeEventListener("pageshow", remeasure);
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("focus", remeasure);
      document.removeEventListener("focusout", remeasure);
      document.removeEventListener("visibilitychange", remeasureWhenVisible);
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(settleTimer);
      probe.remove();
      root.style.removeProperty("--app-height");
      root.removeAttribute("data-app-taller-than-viewport");
    };
  }, []);
}
