export const HOTKEYS = {
  shortcuts: "Mod+/",
  search: "Mod+K",
  sidebar: "Mod+B",
  sendAsTask: "Mod+Shift+Enter",
} as const;

const MODIFIERS = {
  apple: { Mod: "⌘", Shift: "⇧", Alt: "⌥" },
  other: { Mod: "Ctrl", Shift: "Shift", Alt: "Alt" },
} as const;

const KEYCAPS: Record<string, string> = {
  Enter: "↵",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

const ARIA_MODIFIERS = { apple: { Mod: "Meta" }, other: { Mod: "Control" } } as const;

function parts(hotkey: string): string[] {
  return hotkey.split(/\+(?!$)/);
}

function platform(apple: boolean) {
  return apple ? "apple" : "other";
}

export function hotkeyKeycaps(hotkey: string, apple: boolean): string[] {
  const modifiers: Record<string, string> = MODIFIERS[platform(apple)];
  return parts(hotkey).map((part) => modifiers[part] ?? KEYCAPS[part] ?? part);
}

export function hotkeyLabel(hotkey: string, apple: boolean): string {
  const modifiers: Record<string, string> = MODIFIERS[platform(apple)];
  const named = parts(hotkey).map((part) => modifiers[part] ?? part);
  return apple ? named.join("") : named.join("+");
}

export function hotkeyAria(hotkey: string, apple: boolean): string {
  const modifiers: Record<string, string> = ARIA_MODIFIERS[platform(apple)];
  return parts(hotkey)
    .map((part) => modifiers[part] ?? part)
    .join("+");
}
