import { expect, test } from "bun:test";

import { splitLayout } from "#src/features/conversations/conversation-split";

/**
 * Task #36: the conversation and its thread or profile pane sit side by side only while both fit
 * at their minimum widths (24rem and 22rem: 736px at 16px). On a desktop the Chat list gives way
 * first, so a laptop keeps both; and the call is made from the whole Chat area, so hiding the list
 * (which widens the pane) never brings it back.
 */
const rem = 16;
const list = { list: 288, gap: 8 };

test("a wide screen keeps the list, the chat and the thread", () => {
  expect(splitLayout({ rem, pane: 760, beside: { area: 1056, ...list } })).toEqual({
    splitFits: true,
    listCrowds: false,
  });
});

test("a laptop hides the list so the chat and the thread both fit", () => {
  // 1100px window: the Chat area is 856px, 560px beside the list.
  expect(splitLayout({ rem, pane: 560, beside: { area: 856, ...list } })).toEqual({
    splitFits: true,
    listCrowds: true,
  });
});

test("once the list is hidden, the wider pane does not bring it back", () => {
  expect(splitLayout({ rem, pane: 856, beside: { area: 856, ...list } }).listCrowds).toBe(true);
});

test("a wider list gives way sooner", () => {
  const area = 1056;
  expect(splitLayout({ rem, pane: 0, beside: { area, list: 400, gap: 8 } }).listCrowds).toBe(true);
});

test("where even the whole area is too narrow, the pane covers the chat and the list gives way", () => {
  // 200% text: the minimums are 1472px.
  expect(splitLayout({ rem: 32, pane: 400, beside: { area: 1100, ...list } })).toEqual({
    splitFits: false,
    listCrowds: true,
  });
});

test("without a list beside (below lg) only the pane's own width counts", () => {
  expect(splitLayout({ rem, pane: 736 })).toEqual({ splitFits: true, listCrowds: false });
  expect(splitLayout({ rem, pane: 735 })).toEqual({ splitFits: false, listCrowds: false });
});
