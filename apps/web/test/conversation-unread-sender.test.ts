import { describe, expect, test } from "bun:test";

import { applyUnreadEvent } from "#src/features/conversations/conversation-unread";

describe("the sender's own DM message", () => {
  test("never bumps the sender's own DM badge, whether the DM is with an Agent or a member", () => {
    const agentDm = {
      conversationId: "dm-agent",
      sequence: 3,
      kind: "direct" as const,
      senderUserId: "viewer",
    };
    const memberDm = {
      conversationId: "dm-member",
      sequence: 2,
      kind: "direct" as const,
      senderUserId: "viewer",
    };
    expect(applyUnreadEvent({}, agentDm, { conversations: new Set(), viewerId: "viewer" })).toEqual(
      {
        "dm-agent:seq": 3,
      },
    );
    expect(
      applyUnreadEvent({}, memberDm, { conversations: new Set(), viewerId: "viewer" }),
    ).toEqual({
      "dm-member:seq": 2,
    });
    // The other member's copy of the same message still counts.
    expect(
      applyUnreadEvent({}, { ...memberDm }, { conversations: new Set(), viewerId: "grace" }),
    ).toEqual({ "dm-member": 1, "dm-member:seq": 2 });
  });
});
