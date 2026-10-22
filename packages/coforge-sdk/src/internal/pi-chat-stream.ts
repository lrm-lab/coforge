import type { PiChatEvent, PiChatResult } from "./pi-chat";

export function applyPiChatEvent(current: PiChatResult, event: PiChatEvent): PiChatResult {
  const messages = new Map((current.messages ?? []).map((message) => [message.id, message]));
  for (const id of event.removeIds ?? []) messages.delete(id);
  for (const message of event.messages ?? []) messages.set(message.id, message);
  return {
    ...current,
    session: event.session ?? current.session,
    messages: [...messages.values()],
    stream: event.stream,
  };
}

/** Orders live observation against native reads. The native read's cursor is a conservative lower bound. */
export class PiChatLiveHistory {
  #streamId?: string;
  #sequence = 0;
  readonly #retired = new Set<string>();
  readonly #events: PiChatEvent[] = [];
  #bytes = 0;
  #lostThrough = 0;
  constructor(private readonly sessionId: string) {}
  accept(event: PiChatEvent): "ignored" | "observed" | "changed" | "recover" {
    if (this.#retired.has(event.stream.id)) return "ignored";
    const changedWorker = !!this.#streamId && this.#streamId !== event.stream.id;
    if (changedWorker) this.#replace(event.stream.id);
    this.#streamId ??= event.stream.id;
    if (event.stream.sequence <= this.#sequence) return "ignored";
    let recover = changedWorker || event.stream.sequence > this.#sequence + 1;
    this.#sequence = event.stream.sequence;
    if (event.sessionId !== this.sessionId) return recover ? "recover" : "observed";
    const size = JSON.stringify(event).length;
    if (this.#events.length >= 512 || this.#bytes + size > 32_000_000) {
      this.#lostThrough = this.#events.at(-1)?.stream.sequence ?? this.#sequence;
      this.#events.length = 0;
      this.#bytes = 0;
      recover = true;
    }
    this.#events.push(event);
    this.#bytes += size;
    return recover ? "recover" : "changed";
  }
  merge(snapshot: PiChatResult): PiChatResult {
    if (!snapshot.stream) return snapshot;
    if (this.#retired.has(snapshot.stream.id))
      throw new Error("Pi chat worker was replaced; read current history");
    if (!this.#streamId) this.#streamId = snapshot.stream.id;
    if (snapshot.stream.id !== this.#streamId) this.#replace(snapshot.stream.id);
    if (snapshot.stream.sequence < this.#lostThrough)
      throw new Error("Pi chat needs a fresh native snapshot after overflow");
    this.#sequence = Math.max(this.#sequence, snapshot.stream.sequence);
    while (this.#events[0] && this.#events[0].stream.sequence <= snapshot.stream.sequence)
      this.#bytes -= JSON.stringify(this.#events.shift()!).length;
    return this.#events.reduce(applyPiChatEvent, snapshot);
  }
  #replace(streamId: string) {
    if (this.#streamId) this.#retired.add(this.#streamId);
    if (this.#retired.size > 16) this.#retired.delete(this.#retired.values().next().value!);
    this.#streamId = streamId;
    this.#sequence = 0;
    this.#events.length = 0;
    this.#bytes = 0;
    this.#lostThrough = 0;
  }
}
