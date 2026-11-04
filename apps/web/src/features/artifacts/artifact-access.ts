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
  change: (access: ArtifactAccess) => Promise<void>;
  /** The level a change in flight goes to, shown chosen meanwhile. */
  pending: ArtifactAccess | undefined;
  /** What a change that failed says. */
  error: string | null;
  /** Forgets a failed change, as Share closes. */
  dismiss: () => void;
};

/**
 * An artifact's access level, from its read, and the change of it (task #529). A change that
 * finds the artifact gone reads it again, so the page shows it is not there; one refused reads it
 * again too, as who may change it may have changed.
 */
export function useArtifactAccess(
  artifactId: string,
  read: { access: string; canChange: boolean } | undefined,
): ArtifactAccessState {
  const queryClient = useQueryClient();
  const write = useMutation({
    mutationFn: (access: ArtifactAccess) => changeArtifactAccess({ data: { artifactId, access } }),
    onSettled: () => refreshArtifact(queryClient, artifactId),
  });
  const cause = write.error;
  return {
    access: read?.access === "workspace" ? "workspace" : "conversation",
    canChange: read?.canChange,
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
    dismiss: () => {
      if (write.isError) write.reset();
    },
  };
}
