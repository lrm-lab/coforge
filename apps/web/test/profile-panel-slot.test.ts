import { describe, expect, test } from "bun:test";

import { resolveVisibleConversationSlot } from "#src/features/agents/profile-panel/profile-panel-slot";

describe("resolveVisibleConversationSlot", () => {
  test("shows nothing when neither panel is open", () => {
    expect(
      resolveVisibleConversationSlot({ threadOpen: false, profileOpen: false }),
    ).toBeUndefined();
  });

  test("shows the only open panel", () => {
    expect(resolveVisibleConversationSlot({ threadOpen: true, profileOpen: false })).toBe("thread");
    expect(resolveVisibleConversationSlot({ threadOpen: false, profileOpen: true })).toBe(
      "profile",
    );
  });

  test("legacy URLs containing both params default to thread", () => {
    expect(resolveVisibleConversationSlot({ threadOpen: true, profileOpen: true })).toBe("thread");
  });

  test("has no visible panel when the active panel has been closed", () => {
    expect(
      resolveVisibleConversationSlot({ threadOpen: false, profileOpen: false }),
    ).toBeUndefined();
  });

  test("shows details when detailsOpen is true, taking precedence over thread or profile", () => {
    expect(
      resolveVisibleConversationSlot({ threadOpen: false, profileOpen: false, detailsOpen: true }),
    ).toBe("details");
    expect(
      resolveVisibleConversationSlot({ threadOpen: true, profileOpen: false, detailsOpen: true }),
    ).toBe("details");
    expect(
      resolveVisibleConversationSlot({ threadOpen: false, profileOpen: true, detailsOpen: true }),
    ).toBe("details");
  });

  test("suppresses the inner side slot when a document occupies the right slot", () => {
    expect(
      resolveVisibleConversationSlot({
        threadOpen: true,
        profileOpen: true,
        detailsOpen: true,
        taskOpen: true,
        docOpen: true,
      }),
    ).toBeUndefined();
  });

  test("shows task when taskOpen is true, taking precedence over thread and profile but not details", () => {
    expect(
      resolveVisibleConversationSlot({ threadOpen: false, profileOpen: false, taskOpen: true }),
    ).toBe("task");
    expect(
      resolveVisibleConversationSlot({ threadOpen: true, profileOpen: false, taskOpen: true }),
    ).toBe("task");
    expect(
      resolveVisibleConversationSlot({ threadOpen: false, profileOpen: true, taskOpen: true }),
    ).toBe("task");
    expect(
      resolveVisibleConversationSlot({
        threadOpen: false,
        profileOpen: false,
        detailsOpen: true,
        taskOpen: true,
      }),
    ).toBe("details");
  });
});
