import { createContext, useContext, type ReactNode } from "react";

import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import {
  artifactPageRoute,
  conversationSearchWithArtifact,
  openArtifactSearch,
  type ArtifactSearch,
} from "./artifact-search";

const BesideChat = createContext(false);

export function ArtifactsBesideChat({ children }: { children: ReactNode }) {
  return <BesideChat value>{children}</BesideChat>;
}

export function useArtifactLink() {
  const besideChat = useContext(BesideChat);
  const workspaceSlug = useWorkspaceSlug();
  return (artifactId: string) =>
    besideChat
      ? ({
          to: ".",
          resetScroll: false,
          search: (previous: ArtifactSearch) =>
            conversationSearchWithArtifact(previous, openArtifactSearch(artifactId)),
        } as const)
      : artifactPageRoute(workspaceSlug, artifactId);
}
