import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { m } from "#src/paraglide/messages";

/** What the document pane is asking the person to confirm. */
export type ArtifactConfirming = "delete" | "discard" | null;

/**
 * The document pane's confirmations (task #385): discarding unsaved edits and deleting the
 * document.
 */
export function ArtifactPaneConfirms({
  confirming,
  onDone,
  title,
  onDiscard,
  onDelete,
}: {
  confirming: ArtifactConfirming;
  onDone: () => void;
  title: string;
  onDiscard: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const open = (which: ArtifactConfirming) => confirming === which;
  const shared = { onOpenChange: (next: boolean) => !next && onDone() };
  return (
    <>
      <ConfirmDialog
        {...shared}
        open={open("discard")}
        title={m.doc_conflict_discard_title()}
        description={m.doc_conflict_discard_body()}
        confirmLabel={m.doc_conflict_discard()}
        errorMessage={m.doc_save_error()}
        onConfirm={async () => {
          await onDiscard();
          onDone();
        }}
      />
      <ConfirmDialog
        {...shared}
        open={open("delete")}
        title={m.doc_delete_title({ title })}
        description={m.doc_delete_body()}
        confirmLabel={m.doc_delete()}
        errorMessage={m.doc_delete_failed()}
        onConfirm={async () => {
          await onDelete();
          onDone();
        }}
      />
    </>
  );
}
