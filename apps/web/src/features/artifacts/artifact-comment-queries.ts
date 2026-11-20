import { useMemo } from "react";
import {
  queryOptions,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";

import type { Mentionable } from "#src/features/conversations/mention-text";
import { ARTIFACTS_KEY, type ArtifactDocument } from "./artifact-queries";
import {
  loadArtifactComments,
  loadArtifactCommentsById,
  loadArtifactMentionCandidates,
} from "./artifact-comments.functions";
import type { ArtifactCommentsChangedEvent } from "./artifact-realtime";

type CommentsPage = Awaited<ReturnType<typeof loadArtifactComments>>;

export type ArtifactCommentView = CommentsPage["comments"][number];

type CommentChange = ArtifactCommentsChangedEvent["change"];

const OWN_CHANGE_TTL_MS = 10_000;

const ownChanges = new Map<string, number>();

export const artifactCommentsKey = (artifactId: string) =>
  [...ARTIFACTS_KEY, "comments", artifactId] as const;

export const artifactMentionCandidatesQuery = (artifactId: string) =>
  queryOptions({
    queryKey: [...ARTIFACTS_KEY, "mentionable", artifactId],
    queryFn: () => loadArtifactMentionCandidates({ data: { artifactId } }),
    staleTime: 30_000,
  });

export function useArtifactMentionables(artifactId: string) {
  const { data } = useQuery(artifactMentionCandidatesQuery(artifactId));
  return useMemo(() => {
    if (!data) return { offered: undefined, known: undefined };
    const toMentionable =
      (kind: Mentionable["kind"]) =>
      (candidate: { id: string; handle: string; name: string }): Mentionable => ({
        kind,
        id: candidate.id,
        handle: candidate.handle,
        label: candidate.name,
        description: "",
        mentionScore: 0,
      });
    const people = data.people.map(toMentionable("user"));
    const agents = data.agents.map(toMentionable("agent"));
    return {
      offered: {
        people: people.filter((person) => person.id !== data.viewerId),
        agents,
      },
      known: [...people, ...agents],
    };
  }, [data]);
}

const byTime = (left: ArtifactCommentView, right: ArtifactCommentView) =>
  new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
  left.id.localeCompare(right.id);

export function useArtifactComments(artifactId: string, enabled = true) {
  const query = useInfiniteQuery({
    queryKey: artifactCommentsKey(artifactId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => loadArtifactComments({ data: { artifactId, before: pageParam } }),
    getNextPageParam: (page) => page.before,
    staleTime: 30_000,
    enabled,
  });
  const comments = useMemo(() => {
    const seen = new Map<string, ArtifactCommentView>();
    for (const page of query.data?.pages ?? [])
      for (const comment of page.comments) seen.set(comment.id, comment);
    return [...seen.values()].sort(byTime);
  }, [query.data]);
  return { query, comments };
}

function withComments(
  data: InfiniteData<CommentsPage, string | undefined>,
  views: readonly ArtifactCommentView[],
): InfiniteData<CommentsPage, string | undefined> {
  const pages = data.pages.map((page) => ({ ...page, comments: [...page.comments] }));
  for (const view of views) {
    const holder = pages.find((page) => page.comments.some((comment) => comment.id === view.id));
    if (holder)
      holder.comments = holder.comments.map((comment) => (comment.id === view.id ? view : comment));
    else pages[0]?.comments.push(view);
  }
  return { ...data, pages };
}

function adjustCount(queryClient: QueryClient, artifactId: string, delta: number) {
  if (delta === 0) return;
  queryClient.setQueriesData<ArtifactDocument>(
    { queryKey: [...ARTIFACTS_KEY, "document", artifactId] },
    (document) =>
      document && {
        ...document,
        commentCount: Math.max(0, document.commentCount + delta),
      },
  );
}

const countDelta = (change: CommentChange, ids: readonly string[]) =>
  change === "posted" ? ids.length : change === "deleted" ? -ids.length : 0;

async function syncComments(
  queryClient: QueryClient,
  artifactId: string,
  change: CommentChange,
  ids: readonly string[],
) {
  adjustCount(queryClient, artifactId, countDelta(change, ids));
  const key = artifactCommentsKey(artifactId);
  if (ids.length === 0 || !queryClient.getQueryData(key)) return;
  const views = await loadArtifactCommentsById({ data: { artifactId, ids: [...ids] } });
  queryClient.setQueryData<InfiniteData<CommentsPage, string | undefined>>(key, (data) =>
    data ? withComments(data, views) : data,
  );
}

const ownKey = (change: CommentChange, id: string) => `${change}:${id}`;

export async function syncOwnComments(
  queryClient: QueryClient,
  artifactId: string,
  change: CommentChange,
  ids: readonly string[],
) {
  const expires = Date.now() + OWN_CHANGE_TTL_MS;
  for (const id of ids) ownChanges.set(ownKey(change, id), expires);
  await syncComments(queryClient, artifactId, change, ids);
}

export function syncCommentsChange(queryClient: QueryClient, event: ArtifactCommentsChangedEvent) {
  const now = Date.now();
  const others = event.commentIds.filter((id) => {
    const expires = ownChanges.get(ownKey(event.change, id));
    ownChanges.delete(ownKey(event.change, id));
    return expires === undefined || expires < now;
  });
  if (others.length === 0) return Promise.resolve();
  return syncComments(queryClient, event.artifactId, event.change, others);
}
