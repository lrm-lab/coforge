import { describe, expect, test } from "bun:test";
import { countsAsNewMessage } from "#src/features/conversations/pushed-new-messages";
import type { MessageAvailableEvent } from "#src/features/conversations/conversation-realtime";

const event = (overrides: Partial<MessageAvailableEvent> = {}): MessageAvailableEvent => ({
  type: "message.available.v1",
  conversationId: "c1",
  messageId: "m1",
  sequence: 41,
  senderUserId: "someone",
  ...overrides,
});
const pane = { conversationId: "c1", rootId: undefined, viewerId: "me" };

describe("countsAsNewMessage", () => {
  test("another person's or an Agent's top-level message in this conversation counts", () => {
    expect(countsAsNewMessage(event(), pane)).toBe(true);
    expect(countsAsNewMessage(event({ senderUserId: undefined }), pane)).toBe(true);
  });

  test("the viewer's own message never counts", () => {
    expect(countsAsNewMessage(event({ senderUserId: "me" }), pane)).toBe(false);
  });

  test("another conversation's message does not count", () => {
    expect(countsAsNewMessage(event({ conversationId: "c2" }), pane)).toBe(false);
  });

  test("a thread reply counts in its own thread pane only", () => {
    expect(countsAsNewMessage(event({ threadRootId: "r1" }), pane)).toBe(false);
    expect(countsAsNewMessage(event({ threadRootId: "r1" }), { ...pane, rootId: "r1" })).toBe(true);
    expect(countsAsNewMessage(event(), { ...pane, rootId: "r1" })).toBe(false);
  });
});
