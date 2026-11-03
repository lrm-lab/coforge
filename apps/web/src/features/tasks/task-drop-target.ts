/** A group while a card is carried: it takes the drop, it cannot (the card may not move there), or
 * it has no part in the drag (no card is carried, or this is the card's own group). */
export type DropState = "open" | "blocked" | "idle";

/**
 * How a group reads while a card is carried (task #446), as Jira's board does and Atlassian's
 * drag-and-drop guidance asks: the places that take the card light up, and only those. An open
 * group takes a faint brand tint and a 1px brand rule; the one under the pointer, a 2px rule. Both
 * are drawn on an overlay (`::after`) above the group's contents, so the group keeps its own
 * surface and a header with a background of its own cannot hide them. A blocked group fades what
 * is on it (header and cards) to 40%, the figure Atlassian gives a carried item's empty place; its
 * pointer reads "not allowed" (`data-drop-blocked`, styles.css). A fade of the whole group read in
 * light mode but not in dark, where the group's surface is nearly the page's, so the signal is the
 * light, not the fade. The group's own classes must not set `position` other than `relative`.
 */
export function dropTargetClass(state: DropState, isOver: boolean) {
  const base = "relative *:transition-opacity";
  if (state === "blocked") return `${base} *:opacity-40`;
  if (state !== "open") return base;
  return `${base} after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:bg-brand-solid/8 after:ring-inset dark:after:bg-brand-solid/15 ${
    isOver ? "after:ring-2 after:ring-brand" : "after:ring-1 after:ring-brand/60"
  }`;
}
