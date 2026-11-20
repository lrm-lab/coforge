import {
  areHotkeysEqual,
  matchesKeyboardEvent,
  type HotkeyChord,
  type HotkeyPlatform,
} from "@tanstack/react-hotkeys";

export const HOTKEYS = {
  shortcuts: "?",
  search: "Mod+K",
  sidebar: "Mod+B",
  sendAsTask: "Mod+Shift+Enter",
  activityNext: "J",
  activityPrev: "K",
  activityDone: "E",
  activityRead: "R",
  previewFind: "Mod+F",
  draftUndo: "Mod+Z",
  draftRedo: "Mod+Shift+Z",
} as const;

export type ConfigurableShortcutId = keyof typeof HOTKEYS;

export const CONFIGURABLE_SHORTCUT_IDS = Object.keys(HOTKEYS) as readonly ConfigurableShortcutId[];

export const DEFAULT_HOTKEY_BINDINGS: Record<ConfigurableShortcutId, readonly string[]> = {
  shortcuts: [HOTKEYS.shortcuts],
  search: [HOTKEYS.search],
  sidebar: [HOTKEYS.sidebar],
  sendAsTask: [HOTKEYS.sendAsTask],
  activityNext: [HOTKEYS.activityNext],
  activityPrev: [HOTKEYS.activityPrev],
  activityDone: [HOTKEYS.activityDone],
  activityRead: [HOTKEYS.activityRead],
  previewFind: [HOTKEYS.previewFind],
  draftUndo: [HOTKEYS.draftUndo],
  draftRedo: [HOTKEYS.draftRedo, "Mod+Y"],
};

export type KeyLikeEvent = {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
};

const MODIFIERS = {
  apple: { Mod: "⌘", Control: "⌃", Shift: "⇧", Alt: "⌥", Meta: "⌘" },
  other: { Mod: "Ctrl", Control: "Ctrl", Shift: "Shift", Alt: "Alt", Meta: "Win" },
} as const;

const KEYCAPS: Record<string, string> = {
  Enter: "↵",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backspace: "⌫",
  Delete: "⌦",
  Space: "Space",
};

const ARIA_MODIFIERS = {
  apple: { Mod: "Meta", Control: "Control", Meta: "Meta" },
  other: { Mod: "Control", Control: "Control", Meta: "Meta" },
} as const;

const IGNORED_RECORD_KEYS = new Set([
  "Meta",
  "Control",
  "Shift",
  "Alt",
  "AltGraph",
  "OS",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Dead",
  "Process",
  "Unidentified",
]);

const PRIMARY_MODIFIERS = new Set(["Mod", "Control", "Alt", "Meta"]);

const CODE_PUNCTUATION: Record<string, string> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

function parts(hotkey: string): string[] {
  return hotkey.split(/\+(?!$)/);
}

function platform(apple: boolean) {
  return apple ? "apple" : "other";
}

export function hotkeyPlatform(apple: boolean): HotkeyPlatform {
  return apple ? "mac" : "linux";
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

export function hasPrimaryModifier(hotkey: string): boolean {
  return parts(hotkey).some((part) => PRIMARY_MODIFIERS.has(part));
}

export function hotkeysEqual(a: string, b: string, apple: boolean): boolean {
  return areHotkeysEqual(a as HotkeyChord, b as HotkeyChord, hotkeyPlatform(apple));
}

export function hotkeyMatchesEvent(hotkey: string, event: KeyLikeEvent, apple: boolean): boolean {
  if (!hotkey || event.isComposing) return false;
  return matchesKeyboardEvent(event as KeyboardEvent, hotkey as HotkeyChord, hotkeyPlatform(apple));
}

function keyFromCode(code: string | undefined): string | null {
  if (!code) return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit?.[1]) return digit[1];
  return CODE_PUNCTUATION[code] ?? null;
}

export function recordHotkeyFromEvent(event: KeyLikeEvent, apple: boolean): string | null {
  if (event.isComposing || !event.key || IGNORED_RECORD_KEYS.has(event.key)) return null;

  const mod = Boolean(apple ? event.metaKey : event.ctrlKey);
  const control = Boolean(apple ? event.ctrlKey : false);
  const meta = Boolean(apple ? false : event.metaKey);
  const alt = Boolean(event.altKey);
  const shift = Boolean(event.shiftKey);

  if (!mod && !control && !alt && !meta && event.key === "?") return "?";

  let keyToken: string;
  if (event.key === " ") {
    keyToken = "Space";
  } else if (alt || (event.key.length === 1 && !/^[\x21-\x7e]$/.test(event.key))) {
    keyToken = keyFromCode(event.code) ?? event.key;
  } else if (/^[a-zA-Z]$/.test(event.key)) {
    keyToken = event.key.toUpperCase();
  } else {
    keyToken = event.key;
  }

  if (!keyToken || IGNORED_RECORD_KEYS.has(keyToken)) return null;

  const tokens: string[] = [];
  if (mod) tokens.push("Mod");
  if (control) tokens.push("Control");
  if (alt) tokens.push("Alt");
  if (shift) tokens.push("Shift");
  if (meta) tokens.push("Meta");
  tokens.push(keyToken);
  return tokens.join("+");
}
