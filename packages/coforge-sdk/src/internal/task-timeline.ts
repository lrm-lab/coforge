export type TimelineEntry<Message, Event> =
  | { kind: "message"; message: Message }
  | { kind: "event"; event: Event };

type TimelineMessage = { createdAt: string; sequence: number };
type TimelineEvent = { createdAt: string; seq: number };

/**
 * A Task's messages and history events as one stream, oldest first: by time, an event before a
 * message at the same instant, then by sequence within each kind.
 */
export function mergeTimeline<Message extends TimelineMessage, Event extends TimelineEvent>(
  messages: readonly Message[],
  events: readonly Event[],
): TimelineEntry<Message, Event>[] {
  const keyed = [
    ...events.map((event) => ({
      entry: { kind: "event", event } as TimelineEntry<Message, Event>,
      at: Date.parse(event.createdAt),
      rank: 0,
      order: event.seq,
    })),
    ...messages.map((message) => ({
      entry: { kind: "message", message } as TimelineEntry<Message, Event>,
      at: Date.parse(message.createdAt),
      rank: 1,
      order: message.sequence,
    })),
  ];
  return keyed
    .sort((a, b) => a.at - b.at || a.rank - b.rank || a.order - b.order)
    .map(({ entry }) => entry);
}
