import { useMutation, useQueryClient } from "@tanstack/react-query";

import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { changeArtifactAccess } from "./artifacts.functions";
import { refreshArtifact } from "./artifact-queries";

/**
 * Who can see an artifact (task #514, Frank: two levels, no public link): the people who can read
 * the conversation it lives in, or every member of the Workspace. An artifact of the Workspace
 * itself (no conversation) has only the second.
 */
export type ArtifactAccess = "conversation" | "workspace";

/** An artifact's access as its page and Share read it (task #529). */
export type ArtifactAccessState = {
  access: ArtifactAccess;
  /** Whether the viewer may change it: its human author, the owner of the Agent that made it, or
   * a Workspace owner or admin, as the server judges it; undefined until read. */
  canChange: boolean | undefined;
  /** Whether the viewer reads it only through the Workspace level (its read names no home), so
   * the conversation level would leave them unable to open it. */
  locksOut: boolean;
  change: (access: ArtifactAccess) => Promise<void>;
  /** The level a change in flight goes to, shown chosen meanwhile. */
  pending: ArtifactAccess | undefined;
  /** What a change that failed says. */
  error: string | null;
  /** Forgets the change, saving or failed, as Share closes; one still saving goes on. */
  dismiss: () => void;
};

/**
 * An artifact's access level, from its read, and the change of it (task #529). Every change reads
 * the artifact again before it stops showing as saving, so the level never shows the old one in
 * between; a refused one reads it too, as who may change it may have changed. A change that shuts
 * the viewer out calls `onLockedOut` (leaving the page) before that read, which would find the
 * artifact no longer theirs.
 */
export function useArtifactAccess(
  artifactId: string,
  read: { access: string; canChange: boolean; homeKey: string | null } | undefined,
  onLockedOut: () => Promise<void>,
): ArtifactAccessState {
  const queryClient = useQueryClient();
  const locksOut = read?.homeKey === null;
  const write = useMutation({
    mutationFn: (access: ArtifactAccess) => changeArtifactAccess({ data: { artifactId, access } }),
    onSettled: async (_data, error, access) => {
      if (!error && access === "conversation" && locksOut) await onLockedOut();
      await refreshArtifact(queryClient, artifactId);
    },
  });
  const cause = write.error;
  return {
    access: read?.access === "workspace" ? "workspace" : "conversation",
    canChange: read?.canChange,
    locksOut,
    change: async (access) => {
      write.reset();
      await write.mutateAsync(access);
    },
    pending: write.isPending ? write.variables : undefined,
    error: !cause
      ? null
      : isAppError(cause) && cause.code === "ACCESS_DENIED"
        ? m.doc_share_denied()
        : m.doc_share_failed(),
    dismiss: () => write.reset(),
  };
}
