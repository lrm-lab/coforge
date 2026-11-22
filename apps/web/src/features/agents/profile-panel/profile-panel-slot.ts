export type ConversationSlot = "thread" | "profile" | "details";

export function resolveVisibleConversationSlot(input: {
  threadOpen: boolean;
  profileOpen: boolean;
  detailsOpen?: boolean;
}): ConversationSlot | undefined {
  if (input.detailsOpen) return "details";
  if (input.threadOpen && input.profileOpen) {
    return "thread";
  }
  if (input.threadOpen) return "thread";
  if (input.profileOpen) return "profile";
  return undefined;
}
