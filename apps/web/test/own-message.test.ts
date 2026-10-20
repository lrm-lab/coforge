import { describe, expect, test } from "bun:test";

import { isViewerMessage } from "#src/features/conversations/own-message";

describe("isViewerMessage", () => {
  test("in a DM between people, only the viewer's member row is theirs", () => {
    expect(isViewerMessage({ senderMemberId: "member-ada" }, "member-ada")).toBe(true);
    // Both sides are people (`senderKind: "user"`); the other person's message is not the viewer's.
    expect(isViewerMessage({ senderMemberId: "member-grace" }, "member-ada")).toBe(false);
    // The other side's own view of the same two messages.
    expect(isViewerMessage({ senderMemberId: "member-ada" }, "member-grace")).toBe(false);
    expect(isViewerMessage({ senderMemberId: "member-grace" }, "member-grace")).toBe(true);
  });

  test("in a DM with an Agent, the person's messages are theirs and the Agent's are not", () => {
    expect(isViewerMessage({ senderMemberId: "member-ada" }, "member-ada")).toBe(true);
    expect(isViewerMessage({ senderMemberId: "member-agent" }, "member-ada")).toBe(false);
  });

  test("in a channel, a system message (no sender member) is nobody's", () => {
    expect(isViewerMessage({ senderMemberId: "member-ada" }, "member-ada")).toBe(true);
    expect(isViewerMessage({ senderMemberId: "member-bob" }, "member-ada")).toBe(false);
    expect(isViewerMessage({ senderMemberId: null }, "member-ada")).toBe(false);
  });

  test("a viewer with no member row owns nothing, even a message without a sender member", () => {
    expect(isViewerMessage({ senderMemberId: "member-ada" }, undefined)).toBe(false);
    expect(isViewerMessage({}, undefined)).toBe(false);
    expect(isViewerMessage({ senderMemberId: null }, "")).toBe(false);
  });

  test("a message stored before DMs carried a sender member is not the viewer's", () => {
    expect(isViewerMessage({}, "member-ada")).toBe(false);
  });
});
