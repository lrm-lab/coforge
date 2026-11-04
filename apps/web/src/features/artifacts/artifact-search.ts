import { useRouter } from "@tanstack/react-router";
import { z } from "zod";

/**
 * The open document's address on a conversation page (task #385): `doc` names it, `docVersion`
 * an older version shown read-only, `docFull` the full-screen view, `docHistory` its version
 * history beside it, `docDraft` a new document not saved yet. Each falls back to absent when malformed.
 */
export const artifactSearchShape = {
  doc: z.uuid().optional().catch(undefined),
  docVersion: z.coerce.number().int().positive().optional().catch(undefined),
  docFull: z.boolean().optional().catch(undefined),
  docHistory: z.boolean().optional().catch(undefined),
  docDraft: z.boolean().optional().catch(undefined),
};

export type ArtifactSearch = z.output<z.ZodObject<typeof artifactSearchShape>>;

/** Changes the open document's address; a field set to undefined leaves the URL. */
export function useArtifactNavigation() {
  const router = useRouter();
  return (patch: ArtifactSearch, options: { replace?: boolean } = {}) =>
    void router.navigate({
      to: ".",
      replace: options.replace,
      resetScroll: false,
      search: (previous: ArtifactSearch) => ({ ...previous, ...patch }),
    });
}

/** The address that opens a document at its latest version, closing whatever else was open. */
export const openArtifactSearch = (artifactId: string): ArtifactSearch => ({
  doc: artifactId,
  docVersion: undefined,
  docHistory: undefined,
  docDraft: undefined,
});

/** The address of a new document, unsaved until its first save. */
export const draftArtifactSearch: ArtifactSearch = {
  doc: undefined,
  docVersion: undefined,
  docHistory: undefined,
  docDraft: true,
};

export const closedArtifactSearch: ArtifactSearch = {
  doc: undefined,
  docVersion: undefined,
  docFull: undefined,
  docHistory: undefined,
  docDraft: undefined,
};
