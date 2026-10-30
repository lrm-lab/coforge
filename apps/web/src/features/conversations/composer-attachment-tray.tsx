import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { AttachmentTile, type PendingAttachment } from "./composer-attachments";
import { cannotAttach } from "./upload-failure";

/**
 * The files chosen for the next send, under the composer's text. As in Raft's composer, a file
 * that cannot be attached keeps its tile, saying why, and one action clears all such files.
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
    <div className="col-span-full row-start-2 flex flex-col items-start gap-1">
      <ul
        aria-label={m.conversation_attachment_tray()}
        className="flex flex-wrap gap-2 px-3 pt-2.5 pb-1"
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
        <Button
          color="link-gray"
          size="sm"
          className="mx-3 mb-1"
          onPress={() => remove(unattachable.map((item) => item.localId))}
        >
          {m.conversation_attachment_remove_not_attached()}
        </Button>
      )}
    </div>
  );
}
