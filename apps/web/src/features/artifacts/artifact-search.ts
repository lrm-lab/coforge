import { redirect, useRouter } from "@tanstack/react-router";
import { z } from "zod";

import { loadArtifactsOn } from "./artifacts-on.functions";

/**
 * An artifact's fields on a conversation page's address (task #385; Frank, 11-05): `doc` the one
 * open beside the chat, `docDraft` a new document not saved yet, `docFull` either in full screen. Each falls back to absent when
 * malformed.
 */
export const artifactSearchShape = {
  doc: z.uuid().optional().catch(undefined),
  docFull: z.boolean().optional().catch(undefined),
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

/** The address of a new document, unsaved until its first save. */
export const draftArtifactSearch: ArtifactSearch = {
  doc: undefined,
  docDraft: true,
};

/** The address of an artifact beside the chat (Frank, 11-05), at its latest version. */
export const openArtifactSearch = (artifactId: string): ArtifactSearch => ({
  doc: artifactId,
  docDraft: undefined,
});

export const closedArtifactSearch: ArtifactSearch = {
  doc: undefined,
  docFull: undefined,
  docDraft: undefined,
};

/** The route of an artifact's own page, for a `Link`, `navigate` or `buildLocation`. */
export const artifactPageRoute = (workspaceSlug: string, artifactId: string) =>
  ({
    to: "/w/$workspaceSlug/artifacts/$artifactId",
    params: { workspaceSlug, artifactId },
  }) as const;

/** The fields of a `?doc=` link, which a conversation page drops when it opens without it. */
const DOC_LINK_FIELDS = ["doc", "docVersion", "docHistory", "docFull"] as const;

/**
 * A `?doc=` link, for its route's `beforeLoad`. A channel or DM opens it beside its chat
 * (`besideChat`, Frank, 11-05); where no chat is beside it (Activity) it goes to the artifact's
 * own page (task #514), which decides what the reader sees. Where artifacts are off it opens the
 * page as it did, without the document.
 */
export async function redirectDocLink(
  workspaceSlug: string,
  search: ArtifactSearch,
  location: { href: string },
  { besideChat = false } = {},
) {
  if (search.doc === undefined) return;
  if ((await loadArtifactsOn()).on) {
    if (besideChat) return;
    throw redirect({
      ...artifactPageRoute(workspaceSlug, search.doc),
      replace: true,
    });
  }
  const url = new URL(location.href, "http://local");
  for (const field of DOC_LINK_FIELDS) url.searchParams.delete(field);
  throw redirect({ href: `${url.pathname}${url.search}${url.hash}`, replace: true });
}
