import type { CSSProperties } from "react";

/** CSS fake-landscape: the phone stays portrait; the desktop chrome fills a rotated viewport. */
export function desktopLandscapeFrameStyle(): CSSProperties {
  return {
    position: "fixed",
    top: 0,
    left: 0,
    width: "100dvh",
    height: "100dvw",
    transform: "rotate(90deg) translateY(-100%)",
    transformOrigin: "top left",
  };
}
