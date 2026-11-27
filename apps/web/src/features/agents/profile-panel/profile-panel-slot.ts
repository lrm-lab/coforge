export type ConversationSlot = "thread" | "profile" | "details" | "task";
export type InnerConversationSlot = "thread" | "details" | "task";
export type OuterConversationSlot = "profile";
export type NarrowTopSlot = "thread" | "profile";

export type NarrowTopState = {
  threadKey?: string;
  profileKey?: string;
  top: NarrowTopSlot;
};

export function resolveConversationSlots(input: {
  threadOpen: boolean;
  profileOpen: boolean;
  detailsOpen?: boolean;
  taskOpen?: boolean;
  docOpen?: boolean;
}): {
  inner: InnerConversationSlot | undefined;
  outer: OuterConversationSlot | undefined;
} {
  if (input.docOpen) return { inner: undefined, outer: undefined };
  if (input.detailsOpen) return { inner: "details", outer: undefined };
  if (input.taskOpen) return { inner: "task", outer: undefined };
  return {
    inner: input.threadOpen ? "thread" : undefined,
    outer: input.profileOpen ? "profile" : undefined,
  };
}

export function nextNarrowTopSlot(
  previous: NarrowTopState,
  next: { threadKey?: string; profileKey?: string },
): NarrowTopState {
  const { threadKey, profileKey } = next;
  if (threadKey && !profileKey) return { threadKey, profileKey, top: "thread" };
  if (!threadKey && profileKey) return { threadKey, profileKey, top: "profile" };
  if (!threadKey && !profileKey) return { threadKey, profileKey, top: "profile" };

  const threadChanged = threadKey !== previous.threadKey;
  const profileChanged = profileKey !== previous.profileKey;
  if (profileChanged && !threadChanged) return { threadKey, profileKey, top: "profile" };
  if (threadChanged && !profileChanged) return { threadKey, profileKey, top: "thread" };
  if (threadChanged && profileChanged) return { threadKey, profileKey, top: "profile" };
  return { threadKey, profileKey, top: previous.top };
}

export function shouldSuppressOuterOverlay(input: {
  outerSplitShown: boolean;
  innerSlot: InnerConversationSlot | undefined;
  outerSlot: OuterConversationSlot | undefined;
  narrowTop: NarrowTopSlot;
}): boolean {
  return (
    !input.outerSplitShown &&
    input.innerSlot === "thread" &&
    input.outerSlot === "profile" &&
    input.narrowTop === "thread"
  );
}
