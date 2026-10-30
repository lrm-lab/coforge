import { Trash01 } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import { AttachmentTile, type PendingAttachment } from "./composer-attachments";
import { cannotAttach } from "./upload-failure";

/**
 * The files chosen for the next send, under the composer's text: one row of compact cards, as
 * Slack's composer has, that scrolls sideways when it outgrows the width, so the composer keeps
 * one height however many files there are. A file that cannot be attached keeps its card saying
 * why, and one button at the row's end clears all such files.
 */
export function ComposerAttachmentTray({
  attachments,
  retry,
  remove,
}: {
  attachments: PendingAttachment[];
  retry: (item: PendingAttachment) => Promise<void>;
  remove: (localIds: readonly string[]) => void;
}) {
  const unattachable = attachments.filter((item) => cannotAttach(item.failure));
  return (
    <div className="col-span-full row-start-2 flex min-w-0 items-center gap-1 pe-2">
      <ul
        aria-label={m.conversation_attachment_tray()}
        // Room above for the cards' corner buttons, which the sideways scroll would clip.
        className="flex min-w-0 flex-1 gap-2 overflow-x-auto overflow-y-hidden px-3 pt-2.5 pb-1.5"
      >
        {attachments.map((item) => (
          <AttachmentTile
            key={item.localId}
            attachment={item}
            onRemove={() => remove([item.localId])}
            onRetry={() => void retry(item)}
          />
        ))}
      </ul>
      {unattachable.length > 0 && (
        <ButtonUtility
          icon={Trash01}
          size="sm"
          color="tertiary"
          tooltip={m.conversation_attachment_remove_not_attached()}
          onClick={() => remove(unattachable.map((item) => item.localId))}
          className="shrink-0"
        />
      )}
    </div>
  );
}
