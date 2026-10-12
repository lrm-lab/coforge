/** Markers used to resume the side-panel "assistant running" indicator after refresh. */

export type AwaitingResumeComment = {
  authorType: string;
  body: string;
  createdAt: string;
};

export type AwaitingResumeMessage = {
  author: "user" | "assistant";
  createdAt: string;
  suggestion?: unknown;
};

const AWAITING_WINDOW_MS = 180_000;

export type AwaitingAssistantResume = {
  pendingAt: number;
  /** Progress-comment text to show while waiting. Null uses the generic running label. */
  label: string | null;
};

/**
 * Returns when the side panel should show that the assistant is working, and
 * the progress comment to use as that label. Otherwise null.
 *
 * Resumes when:
 * - latest assistant progress comment still says 请稍候 and no later DM reply, or
 * - latest visible DM turn is still from the user (agent reply pending), and a
 *   later assistant comment has not already finished that wait.
 */
export function resolveAwaitingAssistantResume(
  comments: readonly AwaitingResumeComment[],
  messages: readonly AwaitingResumeMessage[],
  nowMs: number = Date.now(),
): AwaitingAssistantResume | null {
  const pendingComment = [...comments]
    .reverse()
    .find((row) => row.authorType === "assistant" && /请稍候/.test(row.body));
  if (pendingComment) {
    const pendingAt = Date.parse(pendingComment.createdAt);
    if (Number.isFinite(pendingAt) && nowMs - pendingAt <= AWAITING_WINDOW_MS) {
      const hasNewerAssistant = messages.some(
        (message) => message.author === "assistant" && Date.parse(message.createdAt) > pendingAt,
      );
      if (!hasNewerAssistant) return { pendingAt, label: pendingComment.body };
    }
  }

  const last = messages.at(-1);
  if (last?.author === "user") {
    const pendingAt = Date.parse(last.createdAt);
    const finishedAfterUser = comments.some(
      (row) =>
        row.authorType === "assistant" &&
        Date.parse(row.createdAt) > pendingAt &&
        !/请稍候/.test(row.body),
    );
    if (
      !finishedAfterUser &&
      Number.isFinite(pendingAt) &&
      nowMs - pendingAt <= AWAITING_WINDOW_MS
    ) {
      return { pendingAt, label: null };
    }
  }

  return null;
}
