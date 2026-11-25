export type ConversationSlot = "thread" | "profile" | "details" | "task";

export function resolveVisibleConversationSlot(input: {
  threadOpen: boolean;
  profileOpen: boolean;
  detailsOpen?: boolean;
  taskOpen?: boolean;
  docOpen?: boolean;
}): ConversationSlot | undefined {
  if (input.docOpen) return undefined;
  if (input.detailsOpen) return "details";
  if (input.taskOpen) return "task";
  if (input.threadOpen && input.profileOpen) {
    return "thread";
  }
  if (input.threadOpen) return "thread";
  if (input.profileOpen) return "profile";
  return undefined;
}
