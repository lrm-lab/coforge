import { useMutation } from "@tanstack/react-query";

/**
 * Who can see an artifact (task #514, Frank: two levels, no public link): the people who can read
 * the conversation it lives in, or every member of the Workspace. An artifact of the Workspace
 * itself (no conversation) has only the second.
 */
export type ArtifactAccess = "conversation" | "workspace";

/** An artifact's access as its page and Share read it, shaped as task #529 will answer it. */
export type ArtifactAccessState = {
  access: ArtifactAccess;
  /** Whether the viewer may change it: its human author, the owner of the Agent that made it, or
   * a Workspace owner or admin (task #529 decides); undefined until known. */
  canChange: boolean | undefined;
  /** False until the level is stored and enforced (task #529): nothing may be changed yet. */
  ready: boolean;
  change: (access: ArtifactAccess) => Promise<void>;
  pending: boolean;
  error: Error | null;
};

/**
 * An artifact's access level.
 *
 * STAND-IN until task #529: the level is not stored or enforced yet, so it reads as its home's
 * default and is not `ready`: Share shows it, greyed, as coming soon, and nothing changes it. When
 * #529 lands, `access` and `canChange` come from the artifact's read and `change` is its write;
 * nothing else changes.
 */
export function useArtifactAccess(home: { kind: "channel" | "dm" | "workspace" } | undefined) {
  const write = useMutation({
    mutationFn: async (_access: ArtifactAccess) => {
      throw new Error("Sharing is not available yet");
    },
  });
  return {
    access: home?.kind === "workspace" ? "workspace" : "conversation",
    canChange: undefined,
    ready: false,
    change: (access: ArtifactAccess) => write.mutateAsync(access),
    pending: write.isPending,
    error: write.error,
  } satisfies ArtifactAccessState;
}
