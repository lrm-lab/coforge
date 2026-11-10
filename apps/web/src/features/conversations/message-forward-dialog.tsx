import { useServerFn } from "@tanstack/react-start";

import { isAppError, isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { ConversationShareDialog, type ShareDialogCopy } from "./conversation-share-dialog";
import { FORWARD_NOTE_MAX_LENGTH } from "./message-forward";
import { forwardMessage } from "./message-forward.functions";
import { ForwardedMessageCard } from "./message-forward-card";
import { forwardedPreview, type ForwardSource } from "./message-forward-model";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";

/** Read per render: the messages follow the current locale. */
const forwardCopy = (count: number): ShareDialogCopy => ({
  title: count > 1 ? m.message_forward_title_several({ count }) : m.message_forward_title_one(),
  send: m.message_forward_send(),
  sendTo: (targets) => m.message_forward_send_to({ count: targets }),
  joinAndSend: m.message_forward_join_and_send(),
  joinNotice: (channels) => m.message_forward_join_notice({ channels }),
  sentTo: (target) => m.message_forward_sent_to({ target }),
  sentToMany: (count) => m.message_forward_sent_to_many({ count }),
  partial: (delivered, total) => m.message_forward_partial({ delivered, total }),
  none: (count) => m.message_forward_none({ count }),
});

/**
 * The Forward dialog for one message (task #237) or a selection of several, carried as one card:
 * the shared destination picker and note (`ConversationShareDialog`), with the forwarded card as
 * its preview.
 */
export function MessageForwardDialog({
  source,
  onClose,
  onForwarded,
}: {
  source: ForwardSource;
  onClose: () => void;
  /** Every destination took it; the dialog closes too. */
  onForwarded?: () => void;
}) {
  const forward = useServerFn(forwardMessage);
  return (
    <ConversationShareDialog
      copy={forwardCopy(source.messages.length)}
      summary={<ForwardSummary source={source} />}
      preview={
        <ForwardedMessageCard
          forwarded={forwardedPreview(source)}
          attachments={source.messages.flatMap(({ message }) => message.attachments)}
        />
      }
      noteMaxLength={FORWARD_NOTE_MAX_LENGTH}
      deliver={({ requestId, destinations, note }) =>
        forward({
          data: {
            requestId,
            sourceMessageIds: source.messages.map(({ message }) => message.id),
            destinations,
            note,
          },
        })
      }
      errorNotice={(error) =>
        isAppError(error) && error.errorId === "forward-not-forwardable"
          ? { text: m.message_forward_not_forwardable() }
          : isAppErrorCode(error, "NOT_FOUND")
            ? { text: m.message_forward_source_gone() }
            : { retry: true, text: m.message_forward_uncertain() }
      }
      onClose={onClose}
      onDelivered={onForwarded}
    />
  );
}

/** The first original in one line: its author's face and handle, the start of its words (or its
 * first file's name), and how many more follow. */
function ForwardSummary({ source }: { source: ForwardSource }) {
  const [first, ...rest] = source.messages;
  if (!first) return null;
  const { message, plainBody } = first;
  const text = plainBody.trim() || message.attachments[0]?.fileName || "";
  return (
    <>
      <ActorAvatar
        size="xs"
        presence={false}
        name={message.senderName}
        src={message.senderAvatarUrl ?? null}
        {...(message.senderKind === "agent" && message.senderAgentId
          ? { agentId: message.senderAgentId }
          : message.senderUserId
            ? { userId: message.senderUserId }
            : {})}
      />
      <span className="min-w-0 truncate">
        <span className="font-semibold text-secondary">
          @{message.senderHandle ?? message.senderName}
        </span>
        <span className="text-tertiary">: {text}</span>
      </span>
      {rest.length > 0 && (
        <span className="shrink-0 text-quaternary">
          {m.message_forward_summary_more({ count: rest.length })}
        </span>
      )}
    </>
  );
}
