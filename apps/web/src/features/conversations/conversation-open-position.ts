/**
 * Where a conversation pane lands when it opens, and where its unread divider sits.
 *
 * A channel pane and a thread pane ask the same question against different bookkeeping: the
 * channel keeps one read cursor per member, a thread keeps one per root message. Both answer
 * "the oldest message past the cursor", so the decision lives here as a framework-free
 * function that the pane, its divider snapshot and the tests all share.
 */

/** The unread boundary: the oldest message the viewer has not read in this pane. */
export type UnreadBoundary = { id: string; sequence: number };

/**
 * The oldest message past `readThroughSequence`, or `undefined` when the pane has nothing
 * unread — or no cursor at all.
 *
 * A missing cursor reads as "everything here has been seen", never as "everything is unread".
 * A thread the viewer has never opened in the thread pane has no `thread_reads` row, and
 * landing such a thread on its very first reply would bury the conversation the viewer just
 * clicked into. The channel cursor behaves the same way for a conversation opened for the
 * first time.
 */
export function unreadBoundary(
  messages: readonly UnreadBoundary[],
  readThroughSequence: number | undefined,
): UnreadBoundary | undefined {
  if (readThroughSequence === undefined) return undefined;
  return messages.find((message) => message.sequence > readThroughSequence);
}

/** The oldest unread message to open on, or `undefined` to open at the latest. */
export function conversationOpenPosition(boundary: UnreadBoundary | undefined): string | undefined {
  return boundary?.id;
}
