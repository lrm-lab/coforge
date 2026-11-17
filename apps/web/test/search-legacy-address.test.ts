import { expect, test } from "bun:test";

import { parseHostedConversation } from "#src/features/conversations/conversation-page-search";
import { activityChatLink } from "#src/features/inbox/activity-open-target";
import { searchQuerySchema } from "#src/features/search/search.schemas";

const MESSAGE = "11111111-1111-4111-8111-111111111111";

/** Where `beforeLoad` of the `/search` route sends an old address. */
function redirectFor(search: unknown) {
  const parsed = searchQuerySchema.parse(search);
  const target = parseHostedConversation(parsed.open, parsed.msg);
  return target && activityChatLink("acme", target);
}

test("an old search address opens its conversation at the message", () => {
  const link = redirectFor({ open: "channel:c1", msg: MESSAGE });
  expect(link).toMatchObject({
    to: "/w/$workspaceSlug/channel/$channelId",
    params: { workspaceSlug: "acme", channelId: "c1" },
    search: { message: MESSAGE },
  });
  expect(redirectFor({ open: "dm:d1", msg: MESSAGE })).toMatchObject({
    to: "/w/$workspaceSlug/dm/$dmId",
    params: { workspaceSlug: "acme", dmId: "d1" },
  });
});

test("an address naming no conversation stays the search dialog", () => {
  expect(redirectFor({ q: "legacy" })).toBeUndefined();
  expect(redirectFor({ open: "channel:" })).toBeUndefined();
  expect(redirectFor({ open: "computer:c1" })).toBeUndefined();
});

test("a conversation without a usable message still opens", () => {
  expect(redirectFor({ open: "channel:c1", msg: "not-a-uuid" })).toMatchObject({
    params: { channelId: "c1" },
    search: { message: undefined },
  });
});
