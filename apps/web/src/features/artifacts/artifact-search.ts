import { redirect, useLocation, useRouter } from "@tanstack/react-router";
import { z } from "zod";

export const artifactSearchShape = {
  doc: z.uuid().optional().catch(undefined),
  docFull: z.boolean().optional().catch(undefined),
};

export type ArtifactSearch = z.output<z.ZodObject<typeof artifactSearchShape>>;

export function conversationSearchWithArtifact<
  T extends {
    threadRootId?: string;
    profile?: string;
    agentTab?: unknown;
    details?: unknown;
    doc?: string;
    docFull?: boolean;
  },
>(previous: T, patch: ArtifactSearch) {
  if (patch.doc === undefined) {
    const { doc: _doc, docFull: _docFull, ...rest } = previous;
    return {
      ...rest,
      doc: "doc" in patch ? patch.doc : _doc,
      docFull: "docFull" in patch ? patch.docFull : _docFull,
    };
  }
  const {
    threadRootId: _threadRootId,
    profile: _profile,
    agentTab: _agentTab,
    details: _details,
    doc: _doc,
    docFull: _docFull,
    ...rest
  } = previous;
  return {
    ...rest,
    doc: patch.doc,
    docFull: "docFull" in patch ? patch.docFull : _docFull,
  };
}

export function useArtifactNavigation() {
  const router = useRouter();
  return (patch: ArtifactSearch, options: { replace?: boolean } = {}) =>
    void router.navigate({
      to: ".",
      replace: options.replace,
      resetScroll: false,
      search: (previous) => conversationSearchWithArtifact(previous, patch),
    });
}

export const openArtifactSearch = (artifactId: string): ArtifactSearch => ({
  doc: artifactId,
  docFull: undefined,
});

export const closedArtifactSearch: ArtifactSearch = {
  doc: undefined,
  docFull: undefined,
};

export const artifactPageRoute = (workspaceSlug: string, artifactId: string) =>
  ({
    to: "/w/$workspaceSlug/artifacts/$artifactId",
    params: { workspaceSlug, artifactId },
  }) as const;

export function redirectDocLink(
  workspaceSlug: string,
  search: ArtifactSearch,
  _location: { href: string },
  { besideChat = false } = {},
) {
  if (search.doc === undefined || besideChat) return;
  throw redirect({
    ...artifactPageRoute(workspaceSlug, search.doc),
    replace: true,
  });
}

declare module "@tanstack/react-router" {
  interface HistoryState {
    artifactFrom?: "gallery";
  }
}

export type ArtifactPageSearch = {
  review?: string | undefined;
  comment?: string | undefined;
  version?: number | undefined;
};

export const clearReviewSearch = (previous: ArtifactPageSearch): ArtifactPageSearch => ({
  ...previous,
  review: undefined,
});

export const galleryEntryState = { artifactFrom: "gallery" } as const;

export function useArrivedFromGallery(): boolean {
  return useLocation({ select: (location) => location.state.artifactFrom === "gallery" });
}
