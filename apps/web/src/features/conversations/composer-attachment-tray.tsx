import type { Dispatch, SetStateAction } from "react";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { AttachmentTile, type PendingAttachment } from "./composer-attachments";
import { retryableUploadFailure } from "./upload-failure";

/** A file the next send cannot carry, and no retry would change that. */
const cannotAttach = (item: PendingAttachment) =>
  item.failure !== undefined && !retryableUploadFailure(item.failure);

/**
 * The files chosen for the next send, under the composer's text. As in Raft's composer, a file
 * that cannot be attached keeps its tile, saying why, and one action clears all such files.
 */
export function ComposerAttachmentTray({
  attachments,
  setAttachments,
  onRetry,
}: {
  attachments: PendingAttachment[];
  setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  onRetry: (item: PendingAttachment) => void;
}) {
  return (
    <div className="col-span-full row-start-2 flex flex-col items-start gap-1">
      <ul
        aria-label={m.conversation_attachment_tray()}
        className="flex flex-wrap gap-2 px-3 pt-2.5 pb-1"
      >
        {attachments.map((item) => (
          <AttachmentTile
            key={item.localId}
            attachment={item}
            onRemove={() =>
              setAttachments((current) => current.filter((other) => other.localId !== item.localId))
            }
            onRetry={() => onRetry(item)}
          />
        ))}
      </ul>
      {attachments.some(cannotAttach) && (
        <Button
          color="link-gray"
          size="sm"
          className="mx-3 mb-1"
          onPress={() => setAttachments((current) => current.filter((item) => !cannotAttach(item)))}
        >
          {m.conversation_attachment_remove_not_attached()}
        </Button>
      )}
    </div>
  );
}
