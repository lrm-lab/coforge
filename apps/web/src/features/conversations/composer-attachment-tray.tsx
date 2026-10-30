import { m } from "#src/paraglide/messages";
import { AttachmentTile, type PendingAttachment } from "./composer-attachments";

/**
 * The files chosen for the next send, under the composer's text: one row of compact cards, as
 * Slack's composer has, that scrolls sideways when it outgrows the width, so the composer keeps
 * one height however many files there are. A file that cannot be attached keeps its card saying
 * why until it is removed.
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
  return (
    <ul
      aria-label={m.conversation_attachment_tray()}
      // Room above for the cards' corner buttons, which the sideways scroll would clip.
      className="col-span-full row-start-2 flex min-w-0 gap-2 overflow-x-auto overflow-y-hidden px-3 pt-2.5 pb-1.5"
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
  );
}
