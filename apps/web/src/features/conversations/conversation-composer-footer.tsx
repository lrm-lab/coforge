import type { ComponentProps, ReactNode } from "react";

import { NotificationActivationBanner } from "#src/features/notifications/notification-activation-banner";
import { MESSAGE_COLUMN_CLASS } from "#src/features/settings/message-width";
import type { DirectConversationView } from "./conversation-types";
import { ConversationUpdateNotice } from "./conversation-update-notice";
import { useMentionCandidates } from "./mention-candidates";
import { MessageComposer } from "./message-composer";
import { useRecentConversationHandles } from "./use-recent-conversation-handles";

type ComposerProps = ComponentProps<typeof MessageComposer>;

/**
 * The foot of a conversation pane: its composer, or the read-only notice in its place, and in the
 * main stream the notification prompt above it, under a notice when the newest messages could not
 * be read. The composer's @-candidates and recent senders
 * come from the conversation it writes to.
 */
export function ConversationComposerFooter({
  conversation,
  root,
  readOnlyNotice,
  mentionCompletion,
  composerTarget,
  channels,
  onSend,
  canSendAsTask,
  onSent,
  quotedDraft,
}: {
  conversation: Omit<DirectConversationView, "agent">;
  /** The thread root this pane replies to; absent for the main stream. */
  root?: { id: string };
  readOnlyNotice?: ReactNode;
  mentionCompletion: boolean;
  composerTarget?: string;
  channels?: ComposerProps["channels"];
  onSend: ComposerProps["onSend"];
  canSendAsTask?: boolean;
  onSent: ComposerProps["onSent"];
  quotedDraft?: ComposerProps["quotedDraft"];
}) {
  const mentionCandidates = useMentionCandidates(
    conversation.mentionables,
    conversation.viewerId,
    mentionCompletion,
  );
  // Handles that recently sent a message here, most-recent first: the mention completion popup
  // ranks these candidates ahead of alphabetical order within a match tier. Deduplicated by
  // handle so the same person's older messages don't push their own recent one down.
  const recentHandles = useRecentConversationHandles(conversation.messages);
  return (
    <div className={root ? undefined : MESSAGE_COLUMN_CLASS}>
      {!root && <ConversationUpdateNotice conversationId={conversation.conversationId} />}
      {!readOnlyNotice && !root && <NotificationActivationBanner />}
      {readOnlyNotice ?? (
        <MessageComposer
          conversationId={conversation.conversationId}
          threadRootId={root?.id}
          inThread={Boolean(root)}
          target={root ? undefined : composerTarget}
          mentionables={mentionCandidates}
          mentionOutsiders={conversation.mentionOutsiders}
          recentHandles={recentHandles}
          channels={channels}
          onSend={onSend}
          canSendAsTask={canSendAsTask}
          onSent={onSent}
          quotedDraft={quotedDraft}
        />
      )}
    </div>
  );
}
