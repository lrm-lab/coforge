import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import {
  ConversationShareDialog,
  type ShareDialogCopy,
} from "#src/features/conversations/conversation-share-dialog";
import type { ForwardMessageResult } from "#src/features/conversations/message-forward";
import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { ArtifactCardFace } from "./artifact-card";
import { ArtifactIcon } from "./artifact-parts";
import { artifactCardQuery } from "./artifact-queries";
import { ARTIFACT_SHARE_NOTE_MAX_LENGTH } from "./artifact-share-input";
import { shareArtifact } from "./artifacts.functions";

/** Read per render: the messages follow the current locale. */
const sendCopy = (title: string): ShareDialogCopy => ({
  title: m.doc_send_title({ title }),
  send: m.doc_send_send(),
  sendTo: (count) => m.doc_send_send_to({ count }),
  joinAndSend: m.doc_send_join_and_send(),
  joinNotice: (channels) => m.doc_send_join_notice({ channels }),
  sentTo: (target) => m.doc_send_sent_to({ target }),
  sentToMany: (count) => m.doc_send_sent_to_many({ count }),
  partial: (delivered, total) => m.doc_send_partial({ delivered, total }),
  none: () => m.doc_send_none(),
});

/**
 * Sends an artifact into channels and DMs (artifacts task #2): Forward's picker and note
 * (`ConversationShareDialog`), with the artifact's card as what arrives. Each destination gets a
 * message with the note above the artifact's link, which reads there as its card.
 */
export function ArtifactSendDialog({
  artifactId,
  title,
  onClose,
}: {
  artifactId: string;
  title: string;
  onClose: () => void;
}) {
  const share = useServerFn(shareArtifact);
  const { data: card } = useQuery(artifactCardQuery(artifactId));
  return (
    <ConversationShareDialog
      copy={sendCopy(title || m.doc_untitled())}
      summary={
        <>
          {card && <ArtifactIcon kind={card.kind} size="sm" />}
          <span className="min-w-0 truncate font-semibold text-secondary">
            {title || m.doc_untitled()}
          </span>
        </>
      }
      preview={card ? <ArtifactCardFace card={card} /> : null}
      noteMaxLength={ARTIFACT_SHARE_NOTE_MAX_LENGTH}
      deliver={async ({ requestId, destinations, note }): Promise<ForwardMessageResult> => {
        const result = await share({ data: { artifactId, destinations, note, requestId } });
        // The share names a destination its target; the dialog reads Forward's shape.
        return {
          outcome: result.outcome,
          results: result.results.map(({ target, ...entry }) => ({
            destination: target,
            ...entry,
          })),
        };
      }}
      errorNotice={(error) =>
        isAppErrorCode(error, "NOT_FOUND")
          ? { text: m.doc_send_gone() }
          : { retry: true, text: m.doc_send_uncertain() }
      }
      onClose={onClose}
    />
  );
}
