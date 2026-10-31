import type { PendingMentionActionView } from "#src/server/conversations/pending-mention-views.server";

/** One pending mention of a person outside `#triage`, as a sender's message reports it; a test
 * names only what it checks. */
export function pendingMentionView(
  fields: Partial<PendingMentionActionView> = {},
): PendingMentionActionView {
  return {
    resolutionId: "22222222-2222-4222-8222-222222222222",
    messageId: "11111111-1111-4111-8111-111111111111",
    targetType: "user",
    targetId: "33333333-3333-4333-8333-333333333333",
    targetHandle: "bob",
    targetLabel: "Bob",
    targetAvatarUrl: null,
    channelName: "triage",
    visibility: "public",
    availableActions: ["notify", "add"],
    expiresAt: new Date("2026-10-01T00:00:00Z"),
    ...fields,
  };
}
