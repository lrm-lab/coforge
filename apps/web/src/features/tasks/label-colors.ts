import type { BadgeColors } from "#src/components/base/badges/badge-types";
import { m } from "#src/paraglide/messages";

/**
 * The colors a person may give a label, in the order the swatches show them. Slate and brand are
 * valid label colors too (older labels and the server accept them) but are not offered: they read
 * as near-twins of gray and blue.
 */
export const LABEL_PALETTE = [
  "gray",
  "error",
  "orange",
  "warning",
  "success",
  "sky",
  "blue",
  "indigo",
  "purple",
  "pink",
] as const;
export type LabelPaletteColor = (typeof LABEL_PALETTE)[number];

/** A label color's dot, as the chip draws it; every key the server accepts is here. */
export const LABEL_DOT: Record<string, string> = {
  gray: "bg-utility-neutral-500",
  brand: "bg-utility-brand-500",
  error: "bg-utility-red-500",
  warning: "bg-utility-yellow-500",
  success: "bg-utility-green-500",
  slate: "bg-utility-slate-500",
  sky: "bg-utility-sky-500",
  blue: "bg-utility-blue-500",
  indigo: "bg-utility-indigo-500",
  purple: "bg-utility-purple-500",
  pink: "bg-utility-pink-500",
  orange: "bg-utility-orange-500",
};

/** Every label color the server accepts: the palette, then the two that are not offered. */
export const LABEL_COLOR_KEYS: readonly string[] = Object.keys(LABEL_DOT);

/** A label's color as a Badge takes it; an unknown key (a newer server) reads as gray. */
export const badgeColor = (color: string) => (color in LABEL_DOT ? color : "gray") as BadgeColors;

/** A color's name as a person reads it (a tooltip, a screen reader). */
export const labelColorName = (color: string): string => {
  switch (color) {
    case "gray":
      return m.tasks_label_color_gray();
    case "error":
      return m.tasks_label_color_error();
    case "orange":
      return m.tasks_label_color_orange();
    case "warning":
      return m.tasks_label_color_warning();
    case "success":
      return m.tasks_label_color_success();
    case "sky":
      return m.tasks_label_color_sky();
    case "blue":
      return m.tasks_label_color_blue();
    case "indigo":
      return m.tasks_label_color_indigo();
    case "purple":
      return m.tasks_label_color_purple();
    case "pink":
      return m.tasks_label_color_pink();
    default:
      return m.tasks_label_color_gray();
  }
};

/** What a new label is given, in turn by its name: never gray, so it stands out, and always a
 * color the swatches offer, so the preselected swatch is one the person can see and move from. */
const NEW_LABEL_COLORS = LABEL_PALETTE.filter((color) => color !== "gray");

/** The color a label created by `name` gets: the same name always gets the same one. */
export function newLabelColor(name: string): LabelPaletteColor {
  let hash = 0;
  for (const char of name.trim().toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return NEW_LABEL_COLORS[hash % NEW_LABEL_COLORS.length]!;
}
