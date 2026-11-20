import { MEMBER_DIRECTORY_KEY } from "#src/features/agents/member-directory-queries";
import { AGENT_MODELS_KEY } from "#src/features/agents/agent-models";
import { type Query, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect } from "react";
import { isRedirect, useRouter } from "@tanstack/react-router";
import { isAppErrorCode } from "#src/lib/app-error";

import { getAgentEnvironment, getAgentProfile } from "#src/features/agents/agents.functions";
import { getAgentChannels } from "#src/features/agents/agent-channels.functions";
import { getAgentPeerConversations } from "#src/features/agents/agent-peer-conversations.functions";

const agentProfileKey = (agentId: string) => ["agent-profile", agentId] as const;
const attemptedProfileDeadlines = new WeakMap<Query, number>();

export const agentEnvironmentKey = (agentId: string) => ["agent-environment", agentId] as const;

/** The Agent profile panel's own data seam: a light server read shared by the Members
 * directory panel and every conversation panel. */
async function readAgentProfile(agentId: string) {
  try {
    return { profile: await getAgentProfile({ data: agentId }) };
  } catch (error) {
    if (
      isRedirect(error) ||
      error instanceof TypeError ||
      isAppErrorCode(error, "TEMPORARILY_UNAVAILABLE", "RATE_LIMITED", "INTERNAL_ERROR")
    ) {
      throw error;
    }
    return { profile: null, notVisible: isAppErrorCode(error, "AGENT_NOT_VISIBLE") };
  }
}

function agentProfileReadQuery(agentId: string | undefined) {
  return queryOptions({
    queryKey: agentProfileKey(agentId ?? ""),
    queryFn: () => readAgentProfile(agentId!),
    enabled: Boolean(agentId),
    staleTime: (query) => (query.state.data?.profile === null ? 0 : 15_000),
  });
}

export function agentProfileQuery(agentId: string | undefined) {
  return queryOptions({
    ...agentProfileReadQuery(agentId),
    select: (read) => read.profile,
  });
}

export function useAgentProfile(agentId: string, visible: boolean) {
  const queryClient = useQueryClient();
  const query = useQuery(agentProfileReadQuery(agentId));
  const { data, dataUpdatedAt } = query;
  const profile = data?.profile;
  const redirecting = isRedirect(query.error);
  const refreshAfterMs =
    profile && !profile.deletedAt ? profile.readiness.upgradeRefreshAfterMs : undefined;

  useLayoutEffect(() => {
    if (!visible || redirecting || refreshAfterMs === undefined) return;
    const queryKey = agentProfileKey(agentId);
    const cache = queryClient.getQueryCache();
    const cached = cache.find({ queryKey, exact: true });
    if (!cached || cached.state.data !== data || cached.state.dataUpdatedAt !== dataUpdatedAt)
      return;
    const { dataUpdateCount } = cached.state;
    if (attemptedProfileDeadlines.get(cached) === dataUpdateCount) return;

    let stopWaiting: (() => void) | undefined;
    const refreshAtDeadline = () => {
      const state = cached.state;
      if (
        cached !== cache.find({ queryKey, exact: true }) ||
        !cached.isActive() ||
        state.dataUpdateCount !== dataUpdateCount ||
        isRedirect(state.error) ||
        attemptedProfileDeadlines.get(cached) === dataUpdateCount
      ) {
        return;
      }
      if (state.fetchStatus !== "idle") {
        stopWaiting = cache.subscribe((event) => {
          if (
            event.query !== cached ||
            event.type !== "updated" ||
            cached.state.fetchStatus !== "idle"
          )
            return;
          stopWaiting?.();
          timer = setTimeout(refreshAtDeadline, 0);
        });
        return;
      }
      attemptedProfileDeadlines.set(cached, dataUpdateCount);
      void queryClient.refetchQueries(
        { queryKey, exact: true, type: "active" },
        { cancelRefetch: false },
      );
    };
    let timer = setTimeout(
      refreshAtDeadline,
      Math.max(0, dataUpdatedAt + refreshAfterMs - Date.now()),
    );
    return () => {
      clearTimeout(timer);
      stopWaiting?.();
    };
  }, [agentId, data, dataUpdatedAt, queryClient, redirecting, refreshAfterMs, visible]);

  return {
    profile,
    unavailable: profile === null || redirecting || (query.isError && !profile),
    notVisible: query.data?.notVisible ?? false,
  };
}

/** The Chat tab's Agent DMs cards: the last message of each of the Agent's conversations with other Agents. */
export function agentPeerConversationsQuery(agentId: string) {
  return queryOptions({
    queryKey: ["agent-peer-conversations", agentId] as const,
    queryFn: async () => getAgentPeerConversations({ data: agentId }),
    staleTime: 15_000,
  });
}

/** The Chat tab's Channels rows: the open channels the Agent is an active member of. */
export function agentChannelsQuery(agentId: string) {
  return queryOptions({
    queryKey: ["agent-channels", agentId] as const,
    queryFn: async () => getAgentChannels({ data: agentId }),
    staleTime: 15_000,
  });
}

/** Whether the viewer manages this Agent (its creator, or a Workspace owner/admin): who gets the
 * panel's manager tabs, Activity among them, and the Agent card's recent Activity. */
export function canManageAgent(profile: {
  canManageAgentRole: boolean;
  ownedByCurrentUser: boolean;
  /** An app's bot is changed only by granting and revoking it in Settings → Applications. */
  appBot?: { appKey: string } | null;
}): boolean {
  return !profile.appBot && (profile.canManageAgentRole || profile.ownedByCurrentUser);
}

/**
 * The RUNTIME CONFIG section's masked env chips and the Runtime config dialog's Advanced rows
 * share this one load: owner-only (the GET itself enforces it; `enabled` just avoids firing the
 * request for a viewer who can never get anything back), short `staleTime` since it reflects a
 * value that can change from another surface (deferred save + external restart).
 */
export function agentEnvironmentQuery(agentId: string | undefined, enabled: boolean) {
  return queryOptions({
    queryKey: agentEnvironmentKey(agentId ?? ""),
    queryFn: async () => getAgentEnvironment({ data: agentId! }),
    enabled: Boolean(agentId) && enabled,
    staleTime: 15_000,
  });
}

/**
 * Re-fetches every surface that still shows this Agent after a panel edit.
 * The panel itself is query-cached (`agent-profile`); the DM list and conversation
 * header come from the Workspace layout loader (`listAgents` → LiveAgents); message
 * `senderName` lives on the conversation query; the Members grid lives on `member-directory`. The full Agent detail page uses
 * `router.invalidate` for the loader; settings avatar upload also invalidates
 * `["conversation"]` so already-open threads pick up the new identity.
 */
export function useInvalidateAgentProfile(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const router = useRouter();
  return async () => {
    if (!agentId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: agentProfileKey(agentId) }),
      queryClient.invalidateQueries({ queryKey: ["conversation"] }),
      // The Members grid pages its cards through the Query cache, not the route loader.
      queryClient.invalidateQueries({ queryKey: MEMBER_DIRECTORY_KEY }),
      // The message headers' description line (`agent-models.ts`).
      queryClient.invalidateQueries({ queryKey: AGENT_MODELS_KEY }),
      router.invalidate({ sync: true }),
    ]);
  };
}
