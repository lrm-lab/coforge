import { expect, test } from "bun:test";
import { z } from "zod";

import {
  hostedConversationOpenParam,
  hostedConversationSearchShape,
  parseHostedConversation,
} from "#src/features/conversations/conversation-page-search";

const id = "01991890-89ec-7000-8000-000000000001";
const msg = "01991890-89ec-7000-8000-000000000002";

/** The hosted pane's part of a host's address, as Activity's `validateSearch` spreads it. */
const hostedAddress = z.object(hostedConversationSearchShape);

test("a thread opened alone survives the hosted pane's address", () => {
  for (const kind of ["channel", "dm"] as const) {
    const open = hostedConversationOpenParam({ kind, id, threadAlone: true });
    expect(open).toBe(`thread:${kind}:${id}`);
    const address = hostedAddress.parse({ open, msg });
    expect(parseHostedConversation(address.open, address.msg)).toEqual({
      kind,
      id,
      messageId: msg,
      threadAlone: true,
    });
  }
});

test("a malformed thread address opens nothing", () => {
  for (const open of [`thread:${id}`, `thread:agent:${id}`, `thread:channel:`, "thread:channel:x"])
    expect(hostedAddress.parse({ open }).open).toBeUndefined();
  // Read outside the schema too, a value naming no conversation kind parses to nothing.
  expect(parseHostedConversation(`thread:agent:${id}`)).toBeUndefined();
  expect(parseHostedConversation(`thread:${id}`)).toBeUndefined();
});
