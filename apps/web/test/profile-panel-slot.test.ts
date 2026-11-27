import { describe, expect, test } from "bun:test";

import {
  nextNarrowTopSlot,
  resolveConversationSlots,
  shouldSuppressOuterOverlay,
} from "#src/features/agents/profile-panel/profile-panel-slot";

describe("resolveConversationSlots", () => {
  test("returns both slots undefined when neither panel is open", () => {
    expect(resolveConversationSlots({ threadOpen: false, profileOpen: false })).toEqual({
      inner: undefined,
      outer: undefined,
    });
  });

  test("places thread in the inner slot and profile in the outer slot independently", () => {
    expect(resolveConversationSlots({ threadOpen: true, profileOpen: false })).toEqual({
      inner: "thread",
      outer: undefined,
    });
    expect(resolveConversationSlots({ threadOpen: false, profileOpen: true })).toEqual({
      inner: undefined,
      outer: "profile",
    });
    expect(resolveConversationSlots({ threadOpen: true, profileOpen: true })).toEqual({
      inner: "thread",
      outer: "profile",
    });
  });

  test("shows details alone in the inner slot when detailsOpen is true", () => {
    expect(
      resolveConversationSlots({ threadOpen: true, profileOpen: true, detailsOpen: true }),
    ).toEqual({
      inner: "details",
      outer: undefined,
    });
  });

  test("shows task alone in the inner slot when taskOpen is true and detailsOpen is false", () => {
    expect(
      resolveConversationSlots({ threadOpen: true, profileOpen: true, taskOpen: true }),
    ).toEqual({
      inner: "task",
      outer: undefined,
    });
    expect(
      resolveConversationSlots({
        threadOpen: false,
        profileOpen: false,
        detailsOpen: true,
        taskOpen: true,
      }),
    ).toEqual({
      inner: "details",
      outer: undefined,
    });
  });

  test("suppresses both slots when a document occupies the right slot", () => {
    expect(
      resolveConversationSlots({
        threadOpen: true,
        profileOpen: true,
        detailsOpen: true,
        taskOpen: true,
        docOpen: true,
      }),
    ).toEqual({
      inner: undefined,
      outer: undefined,
    });
  });
});

describe("nextNarrowTopSlot", () => {
  test("puts profile on top when profile opens after thread", () => {
    const afterThread = nextNarrowTopSlot({ top: "profile" }, { threadKey: "root-1" });
    expect(afterThread.top).toBe("thread");

    const afterProfile = nextNarrowTopSlot(afterThread, {
      threadKey: "root-1",
      profileKey: "agent:a1",
    });
    expect(afterProfile.top).toBe("profile");
  });

  test("puts thread on top when thread opens or switches while profile is already open", () => {
    const afterProfile = nextNarrowTopSlot({ top: "profile" }, { profileKey: "agent:a1" });
    expect(afterProfile.top).toBe("profile");

    const afterThread = nextNarrowTopSlot(afterProfile, {
      threadKey: "root-1",
      profileKey: "agent:a1",
    });
    expect(afterThread.top).toBe("thread");

    const afterSecondProfile = nextNarrowTopSlot(afterThread, {
      threadKey: "root-1",
      profileKey: "agent:a2",
    });
    expect(afterSecondProfile.top).toBe("profile");

    const afterSecondThread = nextNarrowTopSlot(afterSecondProfile, {
      threadKey: "root-2",
      profileKey: "agent:a2",
    });
    expect(afterSecondThread.top).toBe("thread");
  });

  test("defaults to profile when both open simultaneously from a deep link", () => {
    expect(
      nextNarrowTopSlot({ top: "profile" }, { threadKey: "root-1", profileKey: "agent:a1" }).top,
    ).toBe("profile");
  });

  test("returns to the remaining open panel when the top panel closes", () => {
    const both = { threadKey: "root-1", profileKey: "agent:a1", top: "profile" as const };
    expect(nextNarrowTopSlot(both, { threadKey: "root-1" }).top).toBe("thread");
    expect(nextNarrowTopSlot(both, { profileKey: "agent:a1" }).top).toBe("profile");
  });
});

describe("shouldSuppressOuterOverlay", () => {
  test("suppresses the outer profile overlay only in single-column mode when thread was clicked last", () => {
    expect(
      shouldSuppressOuterOverlay({
        outerSplitShown: false,
        innerSlot: "thread",
        outerSlot: "profile",
        narrowTop: "thread",
      }),
    ).toBe(true);

    expect(
      shouldSuppressOuterOverlay({
        outerSplitShown: false,
        innerSlot: "thread",
        outerSlot: "profile",
        narrowTop: "profile",
      }),
    ).toBe(false);

    expect(
      shouldSuppressOuterOverlay({
        outerSplitShown: true,
        innerSlot: "thread",
        outerSlot: "profile",
        narrowTop: "thread",
      }),
    ).toBe(false);
  });
});
