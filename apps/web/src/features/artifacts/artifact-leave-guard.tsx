import { useEffect, useEffectEvent, useState } from "react";
import { useBlocker } from "@tanstack/react-router";

import { UnsavedChangesDialog } from "#src/components/ui/unsaved-changes-dialog";
import { m } from "#src/paraglide/messages";
import type { ArtifactSearch } from "./artifact-search";

/**
 * Leaving a document (or a draft) with unsaved edits (task #385): closing it, opening another or
 * going back saves them first (`save`, Frank, 11-05: edits save by themselves) and goes on; only
 * a save that does not go through asks. Closing the tab asks, as nothing can wait for a save
 * there. An address the edits survive (`stays`: full screen) asks nothing. Render the returned
 * prompt with the editor.
 */
export function useArtifactLeaveGuard({
  dirty,
  stays,
  save,
}: {
  dirty: () => boolean;
  /** The address the edits survive: the same artifact, in full screen or not. */
  stays: (next: { pathname: string; search: ArtifactSearch }) => boolean;
  /** Saves the edits; true once nothing is left unsaved. */
  save?: () => Promise<boolean>;
}) {
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) =>
      dirty() && !stays({ pathname: next.pathname, search: next.search as ArtifactSearch }),
    enableBeforeUnload: dirty,
    withResolver: true,
  });
  const [asking, setAsking] = useState(false);
  const blocked = blocker.status === "blocked";
  const leave = useEffectEvent(async () => {
    if (save && (await save())) blocker.proceed?.();
    else setAsking(true);
  });
  useEffect(() => {
    if (!blocked) return setAsking(false);
    void leave();
  }, [blocked]);
  return (
    <UnsavedChangesDialog
      open={blocked && asking}
      description={m.doc_unsaved_leave()}
      onKeepEditing={() => blocker.reset?.()}
      onDiscard={() => blocker.proceed?.()}
    />
  );
}
