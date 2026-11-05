import { createContext, useContext, type ReactNode } from "react";

import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { artifactPageRoute, openArtifactSearch, type ArtifactSearch } from "./artifact-search";

/** Set inside a conversation's page, where an artifact opens beside the chat. */
const BesideChat = createContext(false);

export function ArtifactsBesideChat({ children }: { children: ReactNode }) {
  return <BesideChat value>{children}</BesideChat>;
}

/**
 * Where an artifact's card or row goes (Frank, 11-05, as Claude opens an artifact beside the
 * conversation): beside the chat inside a conversation, its own page anywhere else.
 */
export function useArtifactLink() {
  const besideChat = useContext(BesideChat);
  const workspaceSlug = useWorkspaceSlug();
  return (artifactId: string) =>
    besideChat
      ? ({
          to: ".",
          resetScroll: false,
          search: (previous: ArtifactSearch) => ({
            ...previous,
            ...openArtifactSearch(artifactId),
          }),
        } as const)
      : artifactPageRoute(workspaceSlug, artifactId);
}
