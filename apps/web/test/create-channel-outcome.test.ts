import { describe, expect, test } from "bun:test";

import { createChannelOutcome } from "#src/features/conversations/create-channel-outcome";

describe("createChannelOutcome", () => {
  test("a create with nothing to show (no channel result) just closes the dialog", () => {
    expect(createChannelOutcome(undefined)).toEqual({ kind: "closed" });
  });

  test("a channel created with every picked member opens at once", () => {
    expect(
      createChannelOutcome({ id: "c1", membersAddFailed: false, sidebarRefreshed: true }),
    ).toEqual({ kind: "open", channelId: "c1" });
  });

  test("a channel whose picked members could not be added stays in the dialog with that notice", () => {
    expect(
      createChannelOutcome({ id: "c1", membersAddFailed: true, sidebarRefreshed: true }),
    ).toEqual({ kind: "result", channelId: "c1", notice: "members" });
  });

  test("a channel created but not listed yet is kept in the dialog, never offered for retry", () => {
    expect(
      createChannelOutcome({ id: "c1", membersAddFailed: false, sidebarRefreshed: false }),
    ).toEqual({ kind: "result", channelId: "c1", notice: "created" });
  });

  test("the members notice wins when both the add and the sidebar refresh failed", () => {
    expect(
      createChannelOutcome({ id: "c1", membersAddFailed: true, sidebarRefreshed: false }),
    ).toEqual({ kind: "result", channelId: "c1", notice: "members" });
  });
});
