import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { artifactLinkSharingQuery } from "./artifact-queries";
import { setArtifactLinkSharing } from "./artifacts.functions";

/** An artifact's public link as its page and Share read it (task #646). */
export type ArtifactLinkSharing = {
  /** Whether this artifact can have one at all. */
  available: boolean;
  url: string | null;
  /** The state a change in flight goes to, shown meanwhile. */
  pending: boolean | undefined;
  /** What a change that failed says. */
  error: string | null;
  change: (enabled: boolean) => void;
  /** Reads it again as Share opens: someone else may have turned it on or off. */
  refresh: () => void;
  /** Forgets a failed change as Share closes. */
  dismiss: () => void;
};

/**
 * An artifact's public link and the switch for it (task #539): beside who can see it, not one of
 * those levels, so turning it off leaves the level as it was.
 */
export function useArtifactLinkSharing(artifactId: string, enabled: boolean): ArtifactLinkSharing {
  const queryClient = useQueryClient();
  const query = artifactLinkSharingQuery(artifactId);
  const { data, refetch } = useQuery({ ...query, enabled });
  const write = useMutation({
    mutationFn: (next: boolean) => setArtifactLinkSharing({ data: { artifactId, enabled: next } }),
    onSuccess: (result) =>
      queryClient.setQueryData(query.queryKey, (read) =>
        read ? { ...read, url: result.enabled ? result.url : null } : read,
      ),
    onError: () => void refetch(),
  });
  const cause = write.error;
  return {
    available: data?.available === true,
    url: data?.url ?? null,
    pending: write.isPending ? write.variables : undefined,
    error: !cause
      ? null
      : isAppError(cause) && cause.code === "ACCESS_DENIED"
        ? m.doc_share_denied()
        : m.doc_share_failed(),
    change: (next) => write.mutate(next),
    refresh: () => void refetch(),
    dismiss: () => write.reset(),
  };
}
