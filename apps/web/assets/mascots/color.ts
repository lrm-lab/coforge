const NAMED: Record<string, string> = { white: "FFFFFF", black: "000000" };

/** A source colour (`#RRGGBB` or a CSS name the sources use) as Rive's `AARRGGBB`, opaque. */
export const argb = (color: string): string =>
  `FF${NAMED[color] ?? color.replace("#", "").toUpperCase()}`;

/** Blend `hex` toward a neutral grey: the muted colour a mascot wears while offline. */
export function mute(hex: string): string {
  const n = hex.replace("#", "").slice(-6);
  const mixed = [0, 2, 4].map((i) => {
    const c = Number.parseInt(n.slice(i, i + 2), 16);
    return Math.round(c + (176 - c) * 0.42)
      .toString(16)
      .padStart(2, "0");
  });
  return `FF${mixed.join("").toUpperCase()}`;
}
