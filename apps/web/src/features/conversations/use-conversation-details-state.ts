import { useCallback } from "react";
import { useRouter, useSearch } from "@tanstack/react-router";

import type { AgentProfileTab } from "#src/features/agents/profile-panel/profile-panel-search";

import { useConversationFocus } from "./conversation-focus";
import {
  conversationSearchWithDetails,
  conversationSearchWithoutDetails,
  detailsMembersView,
  detailsParamSchema,
  type ConversationDetailsParam,
} from "./conversation-details-search";

type DetailsSearch = {
  details?: ConversationDetailsParam;
  threadRootId?: string;
  profile?: string;
  agentTab?: AgentProfileTab;
};

export function useConversationDetailsState({ enabled = true }: { enabled?: boolean } = {}) {
  const router = useRouter();
  const focus = useConversationFocus();
  const rawDetails = useSearch({
    strict: false,
    select: (search) => detailsParamSchema.parse((search as { details?: unknown }).details),
  });
  const details = enabled ? rawDetails : undefined;
  const open = details !== undefined;
  const membersView = detailsMembersView(details);

  const openDetails = useCallback(
    (view: ConversationDetailsParam = "panel") => {
      if (focus?.focused === "chat") focus.toggle("chat");
      void router.navigate({
        to: ".",
        replace: details !== undefined,
        resetScroll: false,
        search: (previous: DetailsSearch) => conversationSearchWithDetails(previous, view),
      });
    },
    [details, focus, router],
  );

  const setMembersView = useCallback(
    (view: "members" | "add" | null) => {
      void router.navigate({
        to: ".",
        replace: true,
        resetScroll: false,
        search: (previous: DetailsSearch) =>
          conversationSearchWithDetails(previous, view ?? "panel"),
      });
    },
    [router],
  );

  const closeDetails = useCallback(() => {
    void router.navigate({
      to: ".",
      replace: true,
      resetScroll: false,
      search: (previous: DetailsSearch) => conversationSearchWithoutDetails(previous),
    });
  }, [router]);

  const toggleDetails = useCallback(() => {
    if (open) closeDetails();
    else openDetails("panel");
  }, [closeDetails, open, openDetails]);

  return {
    details,
    open,
    membersView,
    openDetails,
    setMembersView,
    closeDetails,
    toggleDetails,
  };
}
