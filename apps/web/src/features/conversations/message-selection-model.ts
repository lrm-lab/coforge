import { KeyedListeners } from "./keyed-listeners";
import { FORWARD_SOURCES_MAX } from "./message-forward";
import type { ForwardSourceMessage } from "./message-forward-model";

export type MessageSelectionState = {
  conversationId: string;
  picked: ReadonlyMap<string, ForwardSourceMessage>;
};

export const MESSAGE_SELECTION_MAX = FORWARD_SOURCES_MAX;

export function toggleSelected(
  state: MessageSelectionState | null,
  conversationId: string,
  entry: ForwardSourceMessage,
): { state: MessageSelectionState; full: boolean } {
  const picked = new Map(state?.conversationId === conversationId ? state.picked : []);
  const id = entry.message.id;
  if (picked.has(id)) picked.delete(id);
  else if (picked.size >= MESSAGE_SELECTION_MAX)
    return { state: { conversationId, picked }, full: true };
  else picked.set(id, entry);
  return { state: { conversationId, picked }, full: false };
}

export class MessageSelectionStore {
  #state: MessageSelectionState | null = null;
  readonly #anyListeners = new Set<() => void>();
  readonly #stateListeners = new KeyedListeners();
  readonly #activeListeners = new KeyedListeners();
  readonly #pickedListeners = new KeyedListeners();

  get state(): MessageSelectionState | null {
    return this.#state;
  }

  get anyActive(): boolean {
    return this.#state !== null;
  }

  stateFor(conversationId: string): MessageSelectionState | null {
    return this.#state?.conversationId === conversationId ? this.#state : null;
  }

  isConversationActive(conversationId: string): boolean {
    return this.#state?.conversationId === conversationId;
  }

  isMessageSelected(conversationId: string, messageId: string): boolean {
    return this.#state?.conversationId === conversationId && this.#state.picked.has(messageId);
  }

  readonly subscribeAnyActive = (listener: () => void) => {
    this.#anyListeners.add(listener);
    return () => {
      this.#anyListeners.delete(listener);
    };
  };

  subscribeConversationState(conversationId: string, listener: () => void) {
    return this.#stateListeners.add(conversationId, listener);
  }

  subscribeConversationActive(conversationId: string, listener: () => void) {
    return this.#activeListeners.add(conversationId, listener);
  }

  subscribeMessageSelected(conversationId: string, messageId: string, listener: () => void) {
    return this.#pickedListeners.add(`${conversationId}:${messageId}`, listener);
  }

  toggle(conversationId: string, entry: ForwardSourceMessage): { full: boolean } {
    const previous = this.#state;
    const next = toggleSelected(previous, conversationId, entry);
    if (next.full) return { full: true };
    this.#apply(previous, next.state);
    return { full: false };
  }

  exit() {
    if (this.#state === null) return;
    this.#apply(this.#state, null);
  }

  #apply(previous: MessageSelectionState | null, next: MessageSelectionState | null) {
    this.#state = next;
    const prevConv = previous?.conversationId;
    const nextConv = next?.conversationId;
    if ((previous !== null) !== (next !== null)) {
      for (const listener of this.#anyListeners) listener();
    }
    if (prevConv !== nextConv) {
      if (prevConv) {
        this.#activeListeners.notify(prevConv);
        this.#stateListeners.notify(prevConv);
        for (const id of previous.picked.keys()) {
          this.#pickedListeners.notify(`${prevConv}:${id}`);
        }
      }
      if (nextConv) {
        this.#activeListeners.notify(nextConv);
        this.#stateListeners.notify(nextConv);
        for (const id of next.picked.keys()) {
          this.#pickedListeners.notify(`${nextConv}:${id}`);
        }
      }
      return;
    }
    if (!nextConv || !previous || !next) return;
    this.#stateListeners.notify(nextConv);
    for (const id of previous.picked.keys()) {
      if (!next.picked.has(id)) this.#pickedListeners.notify(`${nextConv}:${id}`);
    }
    for (const id of next.picked.keys()) {
      if (!previous.picked.has(id)) this.#pickedListeners.notify(`${nextConv}:${id}`);
    }
  }
}

export function selectedInOrder(state: MessageSelectionState): ForwardSourceMessage[] {
  return [...state.picked.values()].sort(
    (a, b) => new Date(a.message.createdAt).getTime() - new Date(b.message.createdAt).getTime(),
  );
}

export function selectedLinks(
  messages: readonly ForwardSourceMessage[],
  linkOf: (messageId: string) => string,
): string {
  return messages.map(({ message }) => linkOf(message.id)).join("\n");
}

export function selectedMarkdown(messages: readonly ForwardSourceMessage[]): string {
  return messages
    .map(({ message, plainBody }) => `**${message.senderName}**: ${plainBody}`)
    .join("\n\n");
}
