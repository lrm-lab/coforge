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

export function agentReadMessageId(input: {
  root: boolean;
  hasNewer?: boolean;
  messages: readonly {
    id: string;
    sequence: number;
    senderKind: string;
    senderUserId?: string;
    weeklyReportHidden?: boolean;
  }[];
  agentReadThroughSequence?: number;
  viewerId?: string;
}) {
  const message = input.messages.filter((item) => item.weeklyReportHidden !== true).at(-1);
  return !input.root &&
    !input.hasNewer &&
    input.agentReadThroughSequence !== undefined &&
    input.viewerId !== undefined &&
    message?.senderKind === "user" &&
    message.senderUserId === input.viewerId &&
    message.sequence <= input.agentReadThroughSequence
    ? message.id
    : undefined;
}
