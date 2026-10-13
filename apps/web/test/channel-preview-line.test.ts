import { expect, test } from "bun:test";

import {
  channelMentionShown,
  channelPreviewLine,
} from "#src/features/conversations/channel-preview-line";

/**
 * A channel row's second line: the last message's preview, prefixed by who sent it. The viewer's
 * own messages use the viewer label; a system message has no prefix.
 */
const youLabel = "You";

test("another member's message is prefixed by their name", () => {
  expect(
    channelPreviewLine({
      sender: { kind: "user", name: "Ada", mine: false },
      preview: "Ship it",
      youLabel,
    }),
  ).toBe("Ada: Ship it");
});

test("an Agent's message is prefixed by its name", () => {
  expect(
    channelPreviewLine({
      sender: { kind: "agent", name: "Helper", mine: false },
      preview: "Done",
      youLabel,
    }),
  ).toBe("Helper: Done");
});

test("the viewer's own message is prefixed by the viewer label", () => {
  expect(
    channelPreviewLine({
      sender: { kind: "user", name: "Frank", mine: true },
      preview: "On it",
      youLabel: "我",
    }),
  ).toBe("我: On it");
});

test("a system message has no prefix", () => {
  expect(
    channelPreviewLine({
      sender: { kind: "system", name: "", mine: false },
      preview: "Ada joined",
      youLabel,
    }),
  ).toBe("Ada joined");
});

test("an empty preview yields no line", () => {
  expect(
    channelPreviewLine({
      sender: { kind: "user", name: "Ada", mine: false },
      preview: "",
      youLabel,
    }),
  ).toBeNull();
});

test("the mention badge shows only while the mention is still unread", () => {
  expect(channelMentionShown({ mentioned: true, unreadCount: 2 })).toBe(true);
  expect(channelMentionShown({ mentioned: true, unreadCount: 0 })).toBe(false);
  expect(channelMentionShown({ mentioned: true, unreadCount: undefined })).toBe(false);
  expect(channelMentionShown({ mentioned: false, unreadCount: 2 })).toBe(false);
});
