export const GROUPING_WINDOW_MS = 5 * 60 * 1000;

export function outboxContinuesRun(
  messages: readonly { createdAt: Date | string; senderMemberId?: string | null }[],
  isOwn: (message: { senderMemberId?: string | null }) => boolean,
  dayLabel: (value: Date | string, locale?: string, timeZone?: string) => string,
  locale: string | undefined,
  timeZone: string,
) {
  const lastMessage = messages.at(-1);
  return Boolean(
    lastMessage &&
    isOwn(lastMessage) &&
    dayLabel(lastMessage.createdAt, locale, timeZone) === dayLabel(new Date(), locale, timeZone) &&
    Date.now() - new Date(lastMessage.createdAt).getTime() <= GROUPING_WINDOW_MS,
  );
}

/**
 * The ticks an own message carries (Telegram's): one once it is sent, two once another member — a
 * person or an Agent — has read through it. None where there is no read position to go by: a
 * thread pane, whose replies keep their own read cursors.
 */
export function ownMessageReadState(
  own: boolean,
  sequence: number,
  othersReadThroughSequence: number | undefined,
): "sent" | "read" | undefined {
  if (!own || othersReadThroughSequence === undefined) return undefined;
  return sequence <= othersReadThroughSequence ? "read" : "sent";
}
