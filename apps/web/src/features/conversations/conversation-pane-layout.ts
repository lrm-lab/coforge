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

/** What a conversation's own messages read their ticks from. */
export type ReadPositions = {
  /** How far the furthest-reading other member has read the top-level messages. */
  othersReadThroughSequence: number;
  /** The viewer's newest top-level message: its ticks always show, the others' on hover. */
  latestOwnSequence?: number;
};

/** An own message's ticks: two once read, and whether they show without a hover. */
export type ReadState = { read: boolean; latest: boolean };

/**
 * The ticks an own message carries (Telegram's): one once it is sent, two once another member — a
 * person or an Agent — has read through it. None where there is no read position to go by: a
 * thread pane, whose replies keep their own read cursors.
 */
export function ownMessageReadState(
  own: boolean,
  sequence: number,
  ticks: ReadPositions | undefined,
): ReadState | undefined {
  if (!own || !ticks) return undefined;
  return READ_STATES[Number(sequence <= ticks.othersReadThroughSequence)]![
    Number(sequence === ticks.latestOwnSequence)
  ];
}

/** Every `ReadState`, made once: a row keeps the same object while its ticks do not change, so a
 * memoized message row is not re-rendered by every pane render. */
const READ_STATES = [false, true].map((read) =>
  [false, true].map((latest) => Object.freeze({ read, latest })),
);
