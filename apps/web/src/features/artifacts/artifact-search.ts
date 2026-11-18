import { redirect, useLocation, useRouter } from "@tanstack/react-router";
import { z } from "zod";

import { loadArtifactsOn } from "./artifacts-on.functions";

export const artifactSearchShape = {
  doc: z.uuid().optional().catch(undefined),
  docFull: z.boolean().optional().catch(undefined),
};

export type ArtifactSearch = z.output<z.ZodObject<typeof artifactSearchShape>>;

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

export const openArtifactSearch = (artifactId: string): ArtifactSearch => ({
  doc: artifactId,
});

export const closedArtifactSearch: ArtifactSearch = {
  doc: undefined,
  docFull: undefined,
};

const ARTIFACT_PAGE_REST = /^\/artifacts\/([^/?#]+)(?:[/?#]|$)/;

export const artifactIdOfWorkspaceRest = (rest: string | undefined) => {
  const id = rest === undefined ? undefined : ARTIFACT_PAGE_REST.exec(rest)?.[1];
  return id !== undefined && z.uuid().safeParse(id).success ? id : undefined;
};

export const artifactPageRoute = (workspaceSlug: string, artifactId: string) =>
  ({
    to: "/w/$workspaceSlug/artifacts/$artifactId",
    params: { workspaceSlug, artifactId },
  }) as const;

const DOC_LINK_FIELDS = ["doc", "docFull"] as const;

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

declare module "@tanstack/react-router" {
  interface HistoryState {
    artifactFrom?: "gallery";
  }
}

export const galleryEntryState = { artifactFrom: "gallery" } as const;

export function useArrivedFromGallery(): boolean {
  return useLocation({ select: (location) => location.state.artifactFrom === "gallery" });
}
