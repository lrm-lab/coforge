export const LIGHT_THEME_COLOR = "#ffffff";
export const DARK_THEME_COLOR = "#0a0a0a";

export function themeColorFor(dark: boolean): string {
  return dark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
}

export function setThemeColor(color: string): void {
  if (typeof document === "undefined") return;
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  for (const meta of metas) {
    meta.setAttribute("content", color);
  }
}

export function syncThemeColor(dark: boolean): void {
  setThemeColor(themeColorFor(dark));
}
