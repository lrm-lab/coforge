import { Fragment, type ReactNode } from "react";

/** Stands in for a placeholder while a translated sentence is split around what replaces it. */
const MARK = "\u0000";

/**
 * A translated sentence with nodes where its placeholders are: `message` is called with a marker
 * for each slot, and the text around the markers is kept as the translation wrote it, so each
 * language orders its words, and the nodes, its own way. For a name with its face inside a
 * sentence (`ActorName`), a link, or a time.
 */
export function messageSlots<Slot extends string>(
  message: (slots: Record<Slot, string>) => string,
  nodes: Record<Slot, ReactNode>,
): ReactNode {
  const slots = Object.fromEntries(
    Object.keys(nodes).map((slot) => [slot, `${MARK}${slot}${MARK}`]),
  ) as Record<Slot, string>;
  const parts = message(slots).split(MARK);
  // Split on the marker, the slots' names fall on the odd indexes.
  return parts.map((part, index) =>
    index % 2 === 1 && part in nodes ? (
      <Fragment key={index}>{nodes[part as Slot]}</Fragment>
    ) : (
      part
    ),
  );
}
