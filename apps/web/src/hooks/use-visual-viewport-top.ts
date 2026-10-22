import { useSyncExternalStore } from "react";

const ignore = () => () => {};

// The last offset read while not pinch-zoomed: zooming pans the visual viewport, and React Aria's
// `--visual-viewport-height` holds still while zoomed too, so the two stay in step.
let lastTop = 0;

function subscribe(onChange: () => void) {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  viewport.addEventListener("resize", onChange);
  viewport.addEventListener("scroll", onChange);
  return () => {
    viewport.removeEventListener("resize", onChange);
    viewport.removeEventListener("scroll", onChange);
  };
}

function read() {
  const viewport = window.visualViewport;
  if (viewport && viewport.scale <= 1) lastTop = viewport.offsetTop;
  return lastTop;
}

/**
 * How far the visual viewport sits below the top of the layout viewport, in CSS px. iOS Safari
 * does not shrink the layout viewport for the on-screen keyboard; it shrinks the visual one and
 * may scroll it down to show the focused field, so an element that must stay above the keyboard
 * is placed at this offset with the visual viewport's height. 0 on the server and without the API;
 * while not `enabled` it reads the offset only when its component renders, without following it.
 * https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport/offsetTop
 */
export const useVisualViewportTop = (enabled = true) =>
  useSyncExternalStore(enabled ? subscribe : ignore, read, () => 0);
