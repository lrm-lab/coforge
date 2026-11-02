import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { HandoffRuntimeProvider } from "@lrm/coforge-sdk/internal";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { useDebouncedValue } from "#src/lib/use-debounced-value";
import { readLocalSessionExcerpt, searchLocalSessions } from "./local-session-handoff.functions";
import {
  sessionExcerptState,
  sessionListState,
  type SessionExcerptState,
  type SessionListState,
} from "./local-session-state";

/** Content search runs on the Computer, so it waits for a pause in typing. */
const SEARCH_DEBOUNCE_MS = 250;

/** A read of the Computer is never reused: its answer is the Computer's state right now. */
const FRESH = {
  staleTime: 0,
  gcTime: 0,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

export type LocalSessionSearch = {
  state: SessionListState;
  /** The typed query is not the one the list shows yet. */
  searching: boolean;
  retry: () => void;
};

/** The sessions on one Computer matching `query` (all recent ones when empty), as the picker lists them. */
export function useLocalSessionSearch(
  computerId: string | undefined,
  query: string,
): LocalSessionSearch {
  const workspaceId = useCurrentWorkspaceId();
  const search = useServerFn(searchLocalSessions);
  const settled = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const result = useQuery({
    ...FRESH,
    queryKey: ["local-session-handoff", "search", workspaceId, computerId, settled],
    queryFn: () => search({ data: { computerId: computerId!, query: settled } }),
    enabled: Boolean(computerId),
    // The list stays while the next query loads, so typing does not blank it.
    placeholderData: keepPreviousData,
  });
  const state = sessionListState(result.data, result.isError);
  return {
    // A read in flight replaces a refusal (Retry), not a list: a list stays while the next loads.
    state: result.isFetching && state.kind !== "ready" ? { kind: "loading" } : state,
    searching: query.trim() !== settled || (result.isFetching && settled !== ""),
    retry: () => void result.refetch(),
  };
}

export type LocalSessionExcerpt = { state: SessionExcerptState; retry: () => void };

/** The opening request and recent turns of one session, for its briefing. */
export function useLocalSessionExcerpt(
  computerId: string,
  session: { provider: HandoffRuntimeProvider; sessionId: string; cwd: string },
): LocalSessionExcerpt {
  const workspaceId = useCurrentWorkspaceId();
  const read = useServerFn(readLocalSessionExcerpt);
  const result = useQuery({
    ...FRESH,
    queryKey: [
      "local-session-handoff",
      "excerpt",
      workspaceId,
      computerId,
      session.provider,
      session.sessionId,
      session.cwd,
    ],
    queryFn: () =>
      read({
        data: {
          computerId,
          provider: session.provider,
          sessionId: session.sessionId,
          cwd: session.cwd,
        },
      }),
  });
  return {
    // A refetch in flight (Retry) reads as loading again, not as the answer it replaces.
    state: result.isFetching
      ? { kind: "loading" }
      : sessionExcerptState(result.data, result.isError),
    retry: () => void result.refetch(),
  };
}
