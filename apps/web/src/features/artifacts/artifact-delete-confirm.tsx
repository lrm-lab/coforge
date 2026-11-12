import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { m } from "#src/paraglide/messages";

/** The confirmation before an artifact is deleted. */
export function ArtifactDeleteConfirm({
  open,
  onClose,
  title,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  onDelete: () => Promise<void>;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={m.doc_delete_title({ title })}
      description={m.doc_delete_body()}
      confirmLabel={m.doc_delete()}
      errorMessage={m.doc_delete_failed()}
      onConfirm={async () => {
        await onDelete();
        onClose();
      }}
    />
  );
}
