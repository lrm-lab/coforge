import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { useWorkspaceDirectory } from "#src/features/conversations/workspace-directory-query";
import {
  listArtifacts,
  loadArtifactCards,
  loadArtifactDocument,
  loadArtifactHistory,
} from "./artifacts.functions";
import { loadArtifactsOn } from "./artifacts-on.functions";

/** A document as a list row and a card show it (`listArtifacts`, `loadArtifactCards`). */
export type ArtifactCard = Awaited<ReturnType<typeof listArtifacts>>[number];
export type ArtifactDocument = Awaited<ReturnType<typeof loadArtifactDocument>>;
export type ArtifactHistoryPage = Awaited<ReturnType<typeof loadArtifactHistory>>;
export type ArtifactHistoryVersion = ArtifactHistoryPage["versions"][number];
/** Who published or wrote: a person or an Agent, or nobody left (a deleted account). */
export type ArtifactActorRef = { userId: string } | { agentId: string } | null;

/** Every documents query, to refresh after a save, a revert, a delete or a published version. */
export const ARTIFACTS_KEY = ["artifacts"] as const;

/** Whether documents are on in the Workspace; read again on a page's next use after a minute. */
export const artifactsOnQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: [...ARTIFACTS_KEY, "on", workspaceId],
    queryFn: async () => (await loadArtifactsOn()).on,
    staleTime: 60_000,
  });

/** Whether documents are on here: `true` or `false` once read, `undefined` until then. */
export function useArtifactsOn(): boolean | undefined {
  return useQuery(artifactsOnQuery(useCurrentWorkspaceId())).data;
}

export const artifactListQuery = (conversationId: string) =>
  queryOptions({
    queryKey: [...ARTIFACTS_KEY, "list", conversationId],
    queryFn: () => listArtifacts({ data: { conversationId } }),
    staleTime: 0,
  });

/** One card per query, so every message naming the same document shares one read. */
export const artifactCardQuery = (artifactId: string) =>
  queryOptions({
    queryKey: [...ARTIFACTS_KEY, "card", artifactId],
    queryFn: async () =>
      (await loadArtifactCards({ data: { artifactIds: [artifactId] } })).at(0) ?? null,
    staleTime: 30_000,
  });

/** A document at a version, or at its current one when `version` is absent. */
export const artifactDocumentQuery = (artifactId: string, version?: number) =>
  queryOptions({
    queryKey: [...ARTIFACTS_KEY, "document", artifactId, version ?? "current"],
    queryFn: () => loadArtifactDocument({ data: { artifactId, version } }),
    staleTime: version === undefined ? 0 : Infinity,
  });

export const artifactHistoryQuery = (artifactId: string, before?: number) =>
  queryOptions({
    queryKey: [...ARTIFACTS_KEY, "history", artifactId, before ?? "latest"],
    queryFn: () => loadArtifactHistory({ data: { artifactId, before, limit: 30 } }),
    staleTime: 0,
  });

/** After a document changed: its current read, its history, its cards and its home's list. A
 * kept version's read never changes, so it stays. */
export function refreshArtifact(queryClient: QueryClient, artifactId: string) {
  void queryClient.invalidateQueries({
    predicate: ({ queryKey: [root, kind, id, version] }) => {
      if (root !== ARTIFACTS_KEY[0]) return false;
      if (kind === "list") return true;
      if (id !== artifactId) return false;
      return (
        kind === "card" || kind === "history" || (kind === "document" && version === "current")
      );
    },
  });
}

/** The home conversation a document's `homeKey` names, or null for a Workspace document. */
export function artifactHomeConversation(homeKey: string): string | null {
  return homeKey.startsWith("conversation:") ? homeKey.slice("conversation:".length) : null;
}

/** A publisher or author as a document shows them: their name and face, and whether it is the
 * viewer. */
export type ArtifactActorView = { name: string; avatarUrl?: string; viewer: boolean };

/** Names publishers and authors from the Workspace directory, read once for every document; an
 * actor it does not list (deleted, or not yet read) is undefined. */
export function useArtifactActor() {
  const { data } = useWorkspaceDirectory();
  return (actor: ArtifactActorRef): ArtifactActorView | undefined => {
    if (!actor || !data) return undefined;
    const found =
      "agentId" in actor
        ? data.agents.find((agent) => agent.id === actor.agentId)
        : data.people.find((person) => person.id === actor.userId);
    if (!found) return undefined;
    return {
      name: found.name,
      avatarUrl: found.avatarUrl ?? undefined,
      viewer: "userId" in actor && actor.userId === data.viewerId,
    };
  };
}
