import { m } from "#src/paraglide/messages";
import { AttachmentTile, type PendingAttachment } from "./composer-attachments";

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
