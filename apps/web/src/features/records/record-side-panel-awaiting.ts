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

export const AWAITING_WINDOW_MS = 180_000;
export const AWAITING_FALLBACK_POLL_MS = 4_000;

export type AwaitingAssistantResume = {
  pendingAt: number;
  label: string | null;
};

export function awaitingAssistantPollIntervalMs(input: {
  realtimeConnected: boolean;
  assistantConversationId: string | null;
}): number | null {
  if (input.realtimeConnected && Boolean(input.assistantConversationId)) return null;
  return AWAITING_FALLBACK_POLL_MS;
}

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
