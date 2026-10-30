import type { Dispatch, SetStateAction } from "react";

import { m } from "#src/paraglide/messages";
import { AttachmentTile, type PendingAttachment } from "./composer-attachments";
import { MAX_ATTACHMENTS } from "./use-composer-attachments";

/** The files chosen for the next send, under the composer's text. */
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
    <div className="col-span-full row-start-2 flex flex-col gap-1">
      <ul
        aria-label={m.conversation_attachment_tray()}
        className="flex flex-wrap gap-2 px-3 pt-1 pb-1"
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
      {attachments.length > MAX_ATTACHMENTS && (
        <p className="px-2 text-sm text-error-primary">
          {m.conversation_attachment_limit({ max: MAX_ATTACHMENTS })}
        </p>
      )}
    </div>
  );
}
