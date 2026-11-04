import { useBlocker } from "@tanstack/react-router";

import { UnsavedChangesDialog } from "#src/components/ui/unsaved-changes-dialog";
import { m } from "#src/paraglide/messages";
import type { ArtifactSearch } from "./artifact-search";

/**
 * Leaving a document (or a draft) with unsaved edits asks first (task #385): closing it, opening
 * another, going back, or closing the tab. An address the edits survive (`stays`: another
 * version, full screen, the history) asks nothing. Render the returned prompt with the editor.
 */
export function useArtifactLeaveGuard({
  dirty,
  stays,
}: {
  dirty: () => boolean;
  /** The address the edits survive: the same page at another version, or with the history. */
  stays: (next: { pathname: string; search: ArtifactSearch }) => boolean;
}) {
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) =>
      dirty() && !stays({ pathname: next.pathname, search: next.search as ArtifactSearch }),
    enableBeforeUnload: dirty,
    withResolver: true,
  });
  return (
    <UnsavedChangesDialog
      open={blocker.status === "blocked"}
      description={m.doc_unsaved_leave()}
      onKeepEditing={() => blocker.reset?.()}
      onDiscard={() => blocker.proceed?.()}
    />
  );
}
