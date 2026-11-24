import type { ComponentProps, ReactNode } from "react";

import { NotificationActivationBanner } from "#src/features/notifications/notification-activation-banner";
import { MESSAGE_COLUMN_CLASS } from "#src/features/settings/message-width";
import type { DirectConversationView } from "./conversation-types";
import { ConversationUpdateNotice } from "./conversation-update-notice";
import { useQuotedDraft } from "./conversation-ui-store";
import { useMentionCandidates } from "./mention-candidates";
import { MessageComposer } from "./message-composer";
import { useSelectionIn } from "./message-selection";
import { MessageSelectionBar } from "./message-selection-bar";
import { useRecentConversationHandles } from "./use-recent-conversation-handles";

type ComposerProps = ComponentProps<typeof MessageComposer>;

export function ConversationComposerFooter({
  conversation,
  root,
  narrow,
  column,
  readOnlyNotice,
  mentionCompletion,
  composerTarget,
  channels,
  onSend,
  canSendAsTask,
  autoFocus,
  hostRef,
}: {
  conversation: Omit<DirectConversationView, "agent">;
  root?: { id: string };
  narrow: boolean;
  column: boolean;
  readOnlyNotice?: ReactNode;
  mentionCompletion: boolean;
  composerTarget?: string;
  channels?: ComposerProps["channels"];
  onSend: ComposerProps["onSend"];
  canSendAsTask?: boolean;
  autoFocus?: boolean;
  hostRef?: ComposerProps["hostRef"];
}) {
  const mentionCandidates = useMentionCandidates(
    conversation.mentionables,
    conversation.viewerId,
    mentionCompletion,
  );
  const recentHandles = useRecentConversationHandles(conversation.messages);
  const selecting = useSelectionIn(conversation.conversationId) !== null && !root;
  const quotedDraft = useQuotedDraft();
  return (
    <div className={column ? MESSAGE_COLUMN_CLASS : undefined}>
      {!narrow && <ConversationUpdateNotice conversation={conversation} />}
      {!readOnlyNotice && !narrow && !selecting && (
        <div data-conversation-notification-banner="">
          <NotificationActivationBanner />
        </div>
      )}
      {selecting && <MessageSelectionBar conversationId={conversation.conversationId} />}
      <div className={selecting ? "hidden" : "contents"}>
        {readOnlyNotice ?? (
          <MessageComposer
            conversationId={conversation.conversationId}
            threadRootId={root?.id}
            inThread={narrow}
            target={narrow ? undefined : composerTarget}
            mentionables={mentionCandidates}
            mentionOutsiders={conversation.mentionOutsiders}
            recentHandles={recentHandles}
            channels={channels}
            onSend={onSend}
            canSendAsTask={canSendAsTask}
            quotedDraft={quotedDraft}
            autoFocus={autoFocus}
            hostRef={hostRef}
          />
        )}
      </div>
    </div>
  );
}
