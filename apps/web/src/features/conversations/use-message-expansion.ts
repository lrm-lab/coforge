import { toggleExpanded, useExpandedMessages } from "./conversation-view-memory";

export function useMessageExpansion() {
  return { expandedMessages: useExpandedMessages(), toggleExpandedMessage: toggleExpanded };
}
