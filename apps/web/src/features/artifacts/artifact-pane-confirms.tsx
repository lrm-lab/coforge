import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";

/** What the document pane is asking the person to confirm. */
export type ArtifactConfirming = "delete" | "discard" | { revert: number } | null;

/**
 * The document pane's confirmations (task #385): discarding unsaved edits, deleting the document, and going back to an older version.
 */
export function ArtifactPaneConfirms({
  confirming,
  onDone,
  title,
  latest,
  dirty,
  onDiscard,
  onDelete,
  onRevert,
}: {
  confirming: ArtifactConfirming;
  onDone: () => void;
  title: string;
  latest: number;
  dirty: boolean;
  onDiscard: () => Promise<void>;
  onDelete: () => Promise<void>;
  onRevert: (to: number) => Promise<void>;
}) {
  const open = (which: string) =>
    typeof confirming === "string"
      ? confirming === which
      : which === "revert" && confirming !== null;
  const revertTo = typeof confirming === "object" && confirming ? confirming.revert : 0;
  const shared = { onOpenChange: (next: boolean) => !next && onDone() };
  return (
    <>
      <ConfirmDialog
        {...shared}
        open={open("discard")}
        title={m.doc_conflict_discard_title()}
        description={m.doc_conflict_discard_body({ number: String(latest) })}
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
      <ConfirmDialog
        {...shared}
        open={open("revert")}
        title={m.doc_revert_title({ number: String(revertTo) })}
        description={
          m.doc_revert_body({ number: String(revertTo), next: String(latest + 1) }) +
          // Unsaved edits stay; the next save merges them over the version this makes.
          (dirty ? ` ${m.doc_revert_keeps_unsaved()}` : "")
        }
        confirmLabel={m.doc_revert()}
        errorMessage={(cause) =>
          cause instanceof Error && !isAppError(cause) ? cause.message : m.doc_revert_failed()
        }
        onConfirm={async () => {
          await onRevert(revertTo);
          onDone();
        }}
      />
    </>
  );
}
