/** How much of a quota is left, in Raft's three meter levels. */
export type UsageLevel = "plenty" | "low" | "empty";

const LOW_FROM_LEFT_PERCENT = 20;

/**
 * The one rule for every used share the product shows, a runtime usage window and an Agent's
 * context window alike, as Raft's meter: more than 20% left is plenty, 20% or less is low, and
 * nothing left is empty, as is a window the provider already reports at its limit.
 */
export function usageLevel(usedPercent: number, limitReached = false): UsageLevel {
  const left = 100 - Math.min(100, Math.max(0, usedPercent));
  if (limitReached || left <= 0) return "empty";
  if (left <= LOW_FROM_LEFT_PERCENT) return "low";
  return "plenty";
}

/** The meter's track, fill and value text for each level. An empty meter has no fill to show,
 * so its track turns warning and takes a warning edge. */
export const USAGE_LEVEL_CLASS: Record<UsageLevel, { track: string; fill: string; value: string }> =
  {
    plenty: { track: "bg-quaternary", fill: "bg-utility-blue-500", value: "text-primary" },
    low: { track: "bg-quaternary", fill: "bg-warning-solid", value: "text-warning-primary" },
    empty: {
      track: "bg-utility-yellow-100 ring-1 ring-utility-yellow-500 ring-inset",
      fill: "bg-warning-solid",
      value: "text-warning-primary",
    },
  };
