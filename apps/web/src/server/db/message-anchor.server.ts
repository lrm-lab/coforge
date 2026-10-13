import { UUID_LIKE_SOURCE } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";

/** What an anchor may be: six to twelve hex characters (the twelve-hex display form carries the
 * first dash: `xxxxxxxx-xxxx`), or a whole UUID, in any case. */
const MESSAGE_ANCHOR = new RegExp(
  `^(?:[0-9a-f]{6,12}|[0-9a-f]{8}-[0-9a-f]{4}|${UUID_LIKE_SOURCE})$`,
  "i",
);
const WHOLE_ID = new RegExp(`^${UUID_LIKE_SOURCE}$`);

/**
 * How a Message is addressed by a short anchor. `Message.id` is a native `uuid` column, so a
 * prefix cannot be matched with the usual string operators — `startsWith` (which compiles to a
 * `LIKE`/`ILIKE` pattern) does not apply to a `uuid`. The only form that works is the id **range**
 * a hex prefix names, so every lookup by anchor shares this one.
 *
 * An anchor is a whole UUID, which is the id itself, or a prefix of six to twelve hex characters.
 * Since ids are UUIDv7 (#127), the first twelve hex characters are the millisecond timestamp, so
 * an eight-character anchor (the old display width, still accepted) repeats for every id minted
 * within the same ~65 seconds; twelve covers the full timestamp (the same truncation the pi
 * project moved to after hitting the identical collision, earendil-works/pi#6242). Same-millisecond
 * ids can still share twelve characters; the "at most one match" rule keeps such a rare anchor
 * refusing loudly instead of guessing. Agent targets and reminder ids take twelve; a thread
 * reference written in a message takes six to twelve. Anything else is refused here
 * (`INVALID_INPUT`) rather than widened into a range, so a caller that forgets to check its own
 * grammar can never resolve a message by a shorter prefix.
 */
export function messageAnchorWhere(anchor: string): string | { gte: string; lte: string } {
  if (!MESSAGE_ANCHOR.test(anchor)) throw new AppError("INVALID_INPUT");
  const lower = anchor.toLowerCase();
  // A whole id names itself. Decided by shape, not length: the twelve-hex display form
  // (`xxxxxxxx-xxxx`) is thirteen characters and is still a prefix.
  if (WHOLE_ID.test(lower)) return lower;
  // The hex prefix, dashes dropped (the twelve-hex display form carries the first dash). Padded
  // with `0` / `f` to 32 hex characters and then dashed into uuid shape: for a prefix longer than
  // the first group this must re-insert the dashes, so plain concatenation would not produce a
  // comparable uuid literal. The id column's index still applies.
  const hex = lower.replace(/-/g, "");
  const dashed = (hex32: string) =>
    `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
  return {
    gte: dashed(`${hex}${"0".repeat(32 - hex.length)}`),
    lte: dashed(`${hex}${"f".repeat(32 - hex.length)}`),
  };
}

/**
 * The top-level messages of one channel (or other conversation) an anchor names: the one rule a
 * thread is found by, whether an Agent targets it (`#name:<8 hex>`) or a message refers to it. More
 * than one match means the anchor is ambiguous.
 */
export function channelThreadRootWhere(conversationId: string, anchor: string) {
  return { conversationId, threadRootId: null, id: messageAnchorWhere(anchor) };
}

/**
 * The top-level messages of one conversation that any of several anchors name, in one read — the
 * `channelThreadRootWhere` rule for a batch. Which anchor a row answers is `messageIdMatchesAnchor`;
 * more than one row for an anchor means it is ambiguous. There is no row limit: an anchor names at
 * least a one-in-16.7-million slice of the id space (six hex characters), so a batch reads a
 * handful of rows, and a limit could hide the second row that makes an anchor ambiguous.
 */
export function channelThreadRootsWhere(conversationId: string, anchors: readonly string[]) {
  return {
    conversationId,
    threadRootId: null,
    OR: anchors.map((anchor) => ({ id: messageAnchorWhere(anchor) })),
  };
}

/** Whether a message id (as stored, lower-case) is one an anchor names. */
export function messageIdMatchesAnchor(id: string, anchor: string): boolean {
  return id.toLowerCase().startsWith(anchor.toLowerCase());
}
