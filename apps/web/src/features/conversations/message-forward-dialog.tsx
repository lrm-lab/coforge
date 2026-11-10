import { useServerFn } from "@tanstack/react-start";

import { isAppError, isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { ConversationShareDialog, type ShareDialogCopy } from "./conversation-share-dialog";
import { FORWARD_NOTE_MAX_LENGTH } from "./message-forward";
import { forwardMessage } from "./message-forward.functions";
import { ForwardedMessageCard } from "./message-forward-card";
import { forwardedPreview, type ForwardSource } from "./message-forward-model";

/** Read per render: the messages follow the current locale. */
const forwardCopy = (): ShareDialogCopy => ({
  title: m.message_forward_action(),
  send: m.message_forward_send(),
  joinAndSend: m.message_forward_join_and_send(),
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
      copy={forwardCopy()}
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
