import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { useWorkspaceDirectory } from "#src/features/conversations/workspace-directory-query";
import { loadArtifactMarksBatched } from "./artifact-marks-batch";
import {
  loadArtifactFilePreview,
  loadArtifactFollowing,
  loadArtifactVersions,
  loadArtifactViewers,
} from "./artifact-viewer.functions";
import {
  listArtifacts,
  loadArtifactCards,
  loadArtifactDocument,
  loadArtifactLinkSharing,
} from "./artifacts.functions";

export type ArtifactCard = Awaited<ReturnType<typeof listArtifacts>>[number];
type ArtifactActorRef = { agentId: string } | null;

export const ARTIFACTS_KEY = ["artifacts"] as const;

export const artifactListQuery = (conversationId: string) =>
  queryOptions({
    queryKey: [...ARTIFACTS_KEY, "list", conversationId],
    queryFn: () => listArtifacts({ data: { conversationId } }),
    staleTime: 0,
  });

export const artifactCardQuery = (artifactId: string) =>
  queryOptions({
    queryKey: [...ARTIFACTS_KEY, "card", artifactId],
    queryFn: async () =>
      (await loadArtifactCards({ data: { artifactIds: [artifactId] } })).at(0) ?? null,
    staleTime: 30_000,
  });

export const artifactDocumentQuery = (artifactId: string, version?: number) =>
  queryOptions({
    queryKey: [...ARTIFACTS_KEY, "document", artifactId, version ?? "latest"],
    queryFn: () => loadArtifactDocument({ data: { artifactId, version } }),
    staleTime: 0,
  });

export type ArtifactDocument = Awaited<ReturnType<typeof loadArtifactDocument>>;

export const artifactVersionsQuery = (artifactId: string) =>
  queryOptions({
    queryKey: [...ARTIFACTS_KEY, "versions", artifactId],
    queryFn: () => loadArtifactVersions({ data: { artifactId } }),
    staleTime: 0,
  });

export const artifactViewersQuery = (artifactId: string) =>
  queryOptions({
    queryKey: [...ARTIFACTS_KEY, "viewers", artifactId],
    queryFn: () => loadArtifactViewers({ data: { artifactId } }),
    staleTime: 0,
  });

export type ArtifactViewers = Awaited<ReturnType<typeof loadArtifactViewers>>;

export const artifactFollowingQuery = (artifactId: string) =>
  queryOptions({
    queryKey: [...ARTIFACTS_KEY, "following", artifactId],
    queryFn: () => loadArtifactFollowing({ data: { artifactId } }),
  });

export const artifactMarksQuery = (artifactId: string) =>
  queryOptions({
    queryKey: [...ARTIFACTS_KEY, "marks", artifactId],
    queryFn: () => loadArtifactMarksBatched(artifactId),
    staleTime: 30_000,
  });

export const artifactFilePreviewQuery = (artifactId: string, version: number, path: string) =>
  queryOptions({
    queryKey: [...ARTIFACTS_KEY, "file", artifactId, version, path],
    queryFn: () => loadArtifactFilePreview({ data: { artifactId, version, path } }),
    staleTime: Infinity,
  });

export const artifactLinkSharingQuery = (artifactId: string) =>
  queryOptions({
    queryKey: [...ARTIFACTS_KEY, "link-sharing", artifactId],
    queryFn: () => loadArtifactLinkSharing({ data: { artifactId } }),
  });

export function refreshArtifact(
  queryClient: QueryClient,
  artifactId: string,
  homeId: string | null,
  options: { document?: boolean } = {},
): Promise<void> {
  const document = options.document ?? true;
  return queryClient.invalidateQueries({
    predicate: ({ queryKey: [root, kind, id] }) => {
      if (root !== ARTIFACTS_KEY[0]) return false;
      if (kind === "list") return id === homeId;
      if (id !== artifactId) return false;
      return kind === "document"
        ? document
        : [
            "card",
            "versions",
            "marks",
            "viewers",
            "comments",
            "mentionable",
            "link-sharing",
          ].includes(String(kind));
    },
  });
}

export function artifactHomeConversation(homeKey: string): string | null {
  return homeKey.startsWith("conversation:") ? homeKey.slice("conversation:".length) : null;
}

export type ArtifactActorView = { name: string; avatarUrl?: string };

export function useArtifactActor() {
  const { data } = useWorkspaceDirectory();
  return (actor: ArtifactActorRef): ArtifactActorView | undefined => {
    if (!actor || !data) return undefined;
    const found = data.agents.find((agent) => agent.id === actor.agentId);
    if (!found) return undefined;
    return { name: found.name, avatarUrl: found.avatarUrl ?? undefined };
  };
}
