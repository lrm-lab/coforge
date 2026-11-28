import type { ITheme } from "@xterm/xterm";

export function readTerminalTheme(element: HTMLElement): ITheme {
  const computed = getComputedStyle(element);
  const foreground = computed.color || undefined;
  const background = computed.backgroundColor || undefined;
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: "rgba(255, 255, 255, 0.24)",
  };
}
