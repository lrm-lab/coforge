import { createContext, useContext } from "react";

import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";

/**
 * How the result rows reach the page's preview: the previewed target (to mark its row) and a way
 * to preview another. `preview` is undefined when there is no room beside the list, so rows open
 * their conversation instead.
 */
export const SearchPreviewContext = createContext<{
  previewed?: HostedConversationTarget;
  preview?: (target: HostedConversationTarget) => void;
}>({});

export function useSearchPreview() {
  return useContext(SearchPreviewContext);
}

/** Whether `target` is the one being previewed, message included. */
export function isPreviewed(
  previewed: HostedConversationTarget | undefined,
  target: HostedConversationTarget,
) {
  return (
    previewed?.kind === target.kind &&
    previewed.id === target.id &&
    previewed.messageId === target.messageId
  );
}

/**
 * The preview for a message result: its channel or its direct conversation, at the row
 * the stream shows it on, with a thread reply's thread open at the reply (the stream stays at its
 * root), as Activity opens a thread.
 * Undefined when its place cannot be previewed.
 */
export function messagePreviewTarget(
  conversation: { id: string; channelName: string | null; directKey: string | null },
  message: { id: string; threadRootId?: string },
): HostedConversationTarget | undefined {
  const messageId = message.threadRootId ?? message.id;
  const thread = message.threadRootId
    ? { threadRootId: message.threadRootId, threadReplyId: message.id }
    : {};
  if (conversation.channelName)
    return { kind: "channel", id: conversation.id, messageId, ...thread };
  return conversation.directKey
    ? { kind: "dm", id: conversation.id, messageId, ...thread }
    : undefined;
}
