const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SEMANTIC_COLOR_RE =
  /^var\(--color-utility-(?:neutral|red|orange|yellow|green|blue|purple|pink)-600\)$/;

export const NOTE_FONT_SIZES = ["14", "16", "18", "20", "24"] as const;
export type NoteFontSize = (typeof NOTE_FONT_SIZES)[number];

const FONT_SIZE_REM_BY_KEY: Record<NoteFontSize, string> = {
  "14": "0.875rem",
  "16": "1rem",
  "18": "1.125rem",
  "20": "1.25rem",
  "24": "1.5rem",
};

const FONT_SIZE_KEY_BY_REM: Record<string, NoteFontSize> = {
  "0.875rem": "14",
  "1rem": "16",
  "1.125rem": "18",
  "1.25rem": "20",
  "1.5rem": "24",
};

export interface SanitizedTextStyle {
  color?: string;
  fontSize?: string;
}

function normalizeLegacyHex(value: string): string | null {
  if (!HEX_COLOR_RE.test(value)) return null;
  const lower = value.toLowerCase();
  if (lower.length === 4) {
    return `#${lower[1]}${lower[1]}${lower[2]}${lower[2]}${lower[3]}${lower[3]}`;
  }
  return lower;
}

export function sanitizeTextStyle(style: string): SanitizedTextStyle {
  const result: SanitizedTextStyle = {};
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (prop === "color") {
      if (SEMANTIC_COLOR_RE.test(value)) {
        result.color = value;
      } else {
        const legacy = normalizeLegacyHex(value);
        if (legacy) result.color = legacy;
      }
    }
    if (prop === "font-size") {
      const size = cssToNoteFontSize(value);
      if (size) result.fontSize = fontSizeToCss(size);
    }
  }
  return result;
}

export const NOTE_COLORS = [
  "default",
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export const NOTE_COLOR_CSS: Record<Exclude<NoteColor, "default">, string> = {
  gray: "var(--color-utility-neutral-600)",
  red: "var(--color-utility-red-600)",
  orange: "var(--color-utility-orange-600)",
  yellow: "var(--color-utility-yellow-600)",
  green: "var(--color-utility-green-600)",
  blue: "var(--color-utility-blue-600)",
  purple: "var(--color-utility-purple-600)",
  pink: "var(--color-utility-pink-600)",
};

export function noteColorToCss(color: NoteColor): string | null {
  if (color === "default") return null;
  return NOTE_COLOR_CSS[color];
}

export function cssToNoteColor(value: string | null | undefined): NoteColor {
  if (!value) return "default";
  const trimmed = value.trim();
  const found = (Object.entries(NOTE_COLOR_CSS) as [Exclude<NoteColor, "default">, string][]).find(
    ([, css]) => css === trimmed,
  );
  return found?.[0] ?? "default";
}

export function fontSizeToCss(size: NoteFontSize): string {
  return FONT_SIZE_REM_BY_KEY[size];
}

export function cssToNoteFontSize(value: string | null | undefined): NoteFontSize | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (FONT_SIZE_KEY_BY_REM[trimmed]) return FONT_SIZE_KEY_BY_REM[trimmed];
  const pxMatch = /^(\d+)px$/.exec(trimmed);
  const key = pxMatch?.[1];
  return key && (NOTE_FONT_SIZES as readonly string[]).includes(key) ? (key as NoteFontSize) : null;
}
