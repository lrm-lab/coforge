import { expect, test } from "bun:test";

import {
  conversationRowMenuEnabled,
  conversationRowMenuItems,
} from "#src/features/conversations/conversation-row-menu-model";

/**
 * P3a (#126) of the saved/pinned plan: the conversation row's right-click menu. The mockup
 * (#122, boss's reference image) fixes the item set and their order — Mark as Unread, Pin, then
 * Close Chat behind a separator; "Move to section" was removed from the plan with the schema
 * field itself. Only an active member may open it: the P2b mutations all guard membership
 * server-side, so an unjoined row offering them would only ever fail with ACCESS_DENIED.
 */
test("only an active member's row opens the menu", () => {
  expect(conversationRowMenuEnabled({ joined: true })).toBe(true);
  expect(conversationRowMenuEnabled({ joined: false })).toBe(false);
});

test("items follow the mockup's order, with mute after pin and close-chat last", () => {
  expect(conversationRowMenuItems({ pinned: false, muted: false }).map((item) => item.id)).toEqual([
    "mark-unread",
    "pin",
    "mute",
    "close-chat",
  ]);
});

test("the pin item carries the row's pinned state so the label can read Pin or Unpin", () => {
  const unpinned = conversationRowMenuItems({ pinned: false, muted: false });
  const pinned = conversationRowMenuItems({ pinned: true, muted: false });
  expect(unpinned.find((item) => item.id === "pin")?.pinned).toBe(false);
  expect(pinned.find((item) => item.id === "pin")?.pinned).toBe(true);
});

test("the mute item carries the row's muted state so the label can read Mute or Unmute", () => {
  const audible = conversationRowMenuItems({ pinned: false, muted: false });
  const muted = conversationRowMenuItems({ pinned: false, muted: true });
  expect(audible.find((item) => item.id === "mute")?.muted).toBe(false);
  expect(muted.find((item) => item.id === "mute")?.muted).toBe(true);
});
