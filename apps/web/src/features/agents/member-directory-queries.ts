import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { MEMBER_PAGE_SIZE } from "#src/features/workspaces/member-directory";
import {
  loadMemberAgentPage,
  loadMemberPeoplePage,
  loadMemberPersonProfile,
} from "#src/features/workspaces/workspaces.functions";

export type MemberAgentFilters = {
  owner: "all" | "mine";
  query: string;
};

/** Every Members page query in every Workspace; invalidate it after any change to an Agent or
 * member (create, delete, invite, a profile-panel edit). */
export const MEMBER_DIRECTORY_KEY = ["member-directory"] as const;

/** Scoped by Workspace so a Workspace switch never shows the previous Workspace's cards. */
const workspaceDirectoryKey = (workspaceId: string) =>
  [...MEMBER_DIRECTORY_KEY, workspaceId] as const;

/** The Agent tab: one page per scroll step, restarted whenever a filter or the search changes. */
export const memberAgentsQuery = (workspaceId: string, filters: MemberAgentFilters) =>
  infiniteQueryOptions({
    queryKey: [...workspaceDirectoryKey(workspaceId), "agents", filters],
    queryFn: ({ pageParam }) =>
      loadMemberAgentPage({ data: { ...filters, cursor: pageParam, limit: MEMBER_PAGE_SIZE } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/** The Collaborators tab, paged the same way. */
export const memberPeopleQuery = (workspaceId: string, query: string) =>
  infiniteQueryOptions({
    queryKey: [...workspaceDirectoryKey(workspaceId), "people", query],
    queryFn: ({ pageParam }) =>
      loadMemberPeoplePage({ data: { query, cursor: pageParam, limit: MEMBER_PAGE_SIZE } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/** One person's profile panel, under the directory key so a member change refreshes it too. */
export const memberPersonQuery = (workspaceId: string, userId: string) =>
  queryOptions({
    queryKey: [...workspaceDirectoryKey(workspaceId), "person", userId],
    queryFn: () => loadMemberPersonProfile({ data: { userId } }),
  });
