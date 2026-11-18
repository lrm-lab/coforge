/** Phone fake-landscape only: the maximized title chrome overlays and auto-hides. */
export const DESKTOP_CHROME_AUTOHIDE_MS = 2500;

export function desktopChromeAutoHides(landscape: boolean): boolean {
  return landscape;
}
