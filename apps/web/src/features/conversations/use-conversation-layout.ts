import { useCallback, useMemo, useState } from "react";

import {
  nextNarrowTopSlot,
  resolveConversationSlots,
  shouldSuppressOuterOverlay,
  type NarrowTopState,
} from "#src/features/agents/profile-panel/profile-panel-slot";
import type {
  OpenAgentProfile,
  OpenPersonProfile,
} from "#src/features/agents/profile-panel/open-agent-profile";

import { useResponsiveSplitLayout } from "./conversation-split";

export const INNER_MAIN_MIN_REM = 22;
export const INNER_SIDE_MIN_REM = 20;
export const OUTER_MAIN_MIN_REM = 20;
export const OUTER_PROFILE_MIN_REM = 20;
export const OUTER_PROFILE_DEFAULT_PCT = 34;

export function useConversationLayout({
  selectedThreadId,
  profileAgentId,
  profilePersonId,
  detailsOpen,
  taskInSplit,
  isTaskExpanded,
  docOpen,
  threadAlone,
  desktop,
  detailVisible,
  focused,
  onOpenAgentProfile,
  onOpenPersonProfile,
  openThread,
}: {
  selectedThreadId: string | undefined;
  profileAgentId: string | undefined;
  profilePersonId: string | undefined;
  detailsOpen: boolean;
  taskInSplit: boolean;
  isTaskExpanded: boolean;
  docOpen: boolean;
  threadAlone: boolean;
  desktop: boolean;
  detailVisible: boolean;
  focused: "chat" | "thread" | undefined;
  onOpenAgentProfile?: OpenAgentProfile;
  onOpenPersonProfile?: OpenPersonProfile;
  openThread: (rootId: string, options?: { replace?: boolean }) => void;
}) {
  const profileOpen = Boolean(profileAgentId || profilePersonId);
  const slots = resolveConversationSlots({
    threadOpen: Boolean(selectedThreadId),
    profileOpen,
    detailsOpen,
    taskOpen: taskInSplit,
    docOpen,
  });
  const innerSplitLayout = useResponsiveSplitLayout({
    active: Boolean(slots.inner) && !threadAlone && !(slots.inner === "task" && isTaskExpanded),
    mainMinRem: INNER_MAIN_MIN_REM,
    sideMinRem: INNER_SIDE_MIN_REM,
    reportListCrowd: false,
  });
  const outerSplitLayout = useResponsiveSplitLayout({
    active: Boolean(slots.outer),
    mainMinRem: OUTER_MAIN_MIN_REM,
    sideMinRem: OUTER_PROFILE_MIN_REM,
    reportListCrowd: false,
  });
  const innerSplitShown = innerSplitLayout.splitShown;
  const outerSplitShown = outerSplitLayout.splitShown;
  const profileKey = profileAgentId
    ? `agent:${profileAgentId}`
    : profilePersonId
      ? `user:${profilePersonId}`
      : undefined;
  const [narrowTop, setNarrowTop] = useState<NarrowTopState>(() =>
    nextNarrowTopSlot({ top: "profile" }, { threadKey: selectedThreadId, profileKey }),
  );
  const nextNarrowTop = nextNarrowTopSlot(narrowTop, { threadKey: selectedThreadId, profileKey });
  if (
    nextNarrowTop.top !== narrowTop.top ||
    nextNarrowTop.threadKey !== narrowTop.threadKey ||
    nextNarrowTop.profileKey !== narrowTop.profileKey
  ) {
    setNarrowTop(nextNarrowTop);
  }
  const suppressOuterOverlay = shouldSuppressOuterOverlay({
    outerSplitShown,
    innerSlot: slots.inner,
    outerSlot: slots.outer,
    narrowTop: nextNarrowTop.top,
  });
  const outerVisibleSlot = suppressOuterOverlay ? undefined : slots.outer;
  const profileCoversInner = !outerSplitShown && outerVisibleSlot === "profile";
  const handleOpenAgentProfile = useMemo(
    () =>
      onOpenAgentProfile
        ? (...args: Parameters<typeof onOpenAgentProfile>) => {
            setNarrowTop((current) => ({ ...current, top: "profile" }));
            onOpenAgentProfile(...args);
          }
        : undefined,
    [onOpenAgentProfile],
  );
  const handleOpenPersonProfile = useMemo(
    () =>
      onOpenPersonProfile
        ? (...args: Parameters<typeof onOpenPersonProfile>) => {
            setNarrowTop((current) => ({ ...current, top: "profile" }));
            onOpenPersonProfile(...args);
          }
        : undefined,
    [onOpenPersonProfile],
  );
  const handleOpenThread = useCallback(
    (rootId: string, options?: { replace?: boolean }) => {
      setNarrowTop((current) => ({ ...current, top: "thread" }));
      openThread(rootId, options);
    },
    [openThread],
  );
  const threadShowBack = threadAlone ? !desktop : !innerSplitShown;
  const mainPaneVisible =
    detailVisible &&
    !threadAlone &&
    !profileCoversInner &&
    (!slots.inner || innerSplitShown) &&
    focused !== "thread";
  const profileOverlay = !outerSplitShown;

  return {
    slots,
    innerSplitLayout,
    outerSplitLayout,
    outerVisibleSlot,
    profileCoversInner,
    threadShowBack,
    mainPaneVisible,
    profileOverlay,
    handleOpenAgentProfile,
    handleOpenPersonProfile,
    handleOpenThread,
  };
}
