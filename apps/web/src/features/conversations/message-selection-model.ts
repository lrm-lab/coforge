import { FORWARD_SOURCES_MAX } from "./message-forward";
import type { ForwardSourceMessage } from "./message-forward-model";

/** Select mode in one conversation's stream: the messages picked so far, by id. */
export type MessageSelectionState = {
  conversationId: string;
  picked: ReadonlyMap<string, ForwardSourceMessage>;
};

/** Most messages select mode holds: what one forward can carry. */
export const MESSAGE_SELECTION_MAX = FORWARD_SOURCES_MAX;

/**
 * `entry` picked or unpicked. Starting in another conversation starts over there; a pick past the
 * limit changes nothing (`full` says so, for the bar to tell the person).
 */
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

/** The picked messages as the conversation shows them: oldest first, whatever order they were
 * picked in. */
export function selectedInOrder(state: MessageSelectionState): ForwardSourceMessage[] {
  return [...state.picked.values()].sort(
    (a, b) => new Date(a.message.createdAt).getTime() - new Date(b.message.createdAt).getTime(),
  );
}

/** "Copy link": one link per message, oldest first, a line each. */
export function selectedLinks(
  messages: readonly ForwardSourceMessage[],
  linkOf: (messageId: string) => string,
): string {
  return messages.map(({ message }) => linkOf(message.id)).join("\n");
}

/** "Copy Markdown": each message as `**Name**: text`, oldest first, a blank line between them. */
export function selectedMarkdown(messages: readonly ForwardSourceMessage[]): string {
  return messages
    .map(({ message, plainBody }) => `**${message.senderName}**: ${plainBody}`)
    .join("\n\n");
}
