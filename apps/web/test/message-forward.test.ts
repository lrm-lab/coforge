import { expect, test } from "bun:test";

import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";

import { forwardMessageInputSchema } from "#src/features/conversations/message-forward";
import { encodeAgentDelivery } from "#src/server/conversations/agent-delivery.server";
import {
  agentDeliveryView,
  agentForwarded,
  agentMessageView,
} from "#src/server/conversations/agent-message-view.server";
import {
  mapBrowserMessage,
  type BrowserMessageRow,
} from "#src/server/conversations/conversation-history.server";
import { attachForwardedAccess } from "#src/server/conversations/message-forward-view.server";
import { forwardIdempotencyKey } from "#src/server/conversations/message-forwards.server";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_CHANNEL = "22222222-2222-4222-8222-222222222222";
const SOURCE_DM = "33333333-3333-4333-8333-333333333333";
const SOURCE_MESSAGE = "44444444-4444-4444-8444-444444444444";
const VIEWER = "55555555-5555-4555-8555-555555555555";

const stored = {
  sourceConversationName: "product",
  sourceThreadRootId: null,
  sourceSenderHandle: "ada",
  sourceCreatedAt: new Date("2026-10-30T08:00:00.000Z"),
  sourceBody: "ship it",
};

test("a destination's send key is stable, distinct per destination and a UUID", () => {
  const request = "66666666-6666-4666-8666-666666666666";
  const key = forwardIdempotencyKey(request, SOURCE_CHANNEL);
  expect(key).toBe(forwardIdempotencyKey(request, SOURCE_CHANNEL));
  expect(key).not.toBe(forwardIdempotencyKey(request, SOURCE_DM));
  expect(key).not.toBe(forwardIdempotencyKey(SOURCE_DM, SOURCE_CHANNEL));
  expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("a forward names one message and distinct destinations, and its note is optional", () => {
  const input = {
    requestId: SOURCE_MESSAGE,
    sourceMessageIds: [SOURCE_MESSAGE],
    destinations: [SOURCE_CHANNEL, SOURCE_DM],
  };
  expect(forwardMessageInputSchema.safeParse(input).success).toBe(true);
  expect(forwardMessageInputSchema.safeParse({ ...input, note: "  hi  " }).data?.note).toBe("hi");
  for (const bad of [
    { ...input, sourceMessageIds: [] },
    { ...input, sourceMessageIds: [SOURCE_MESSAGE, SOURCE_DM] },
    { ...input, destinations: [] },
    { ...input, destinations: [SOURCE_DM, SOURCE_DM] },
    { ...input, destinations: ["not-a-uuid"] },
    { ...input, note: "x".repeat(8_001) },
  ])
    expect(forwardMessageInputSchema.safeParse(bad).success).toBe(false);
});

test("an Agent reads a forward's original beside its note, from a channel or a DM", () => {
  expect(agentForwarded(stored, [{ id: "a1" }])).toEqual({
    from: "#product",
    sender: "@ada",
    sentAt: "2026-10-30T08:00:00.000Z",
    body: "ship it",
    attachments: ["a1"],
  });
  expect(
    agentForwarded({ ...stored, sourceConversationName: null, sourceThreadRootId: "r1" }),
  ).toMatchObject({ from: "DM", thread: true, attachments: [] });
  const view = agentMessageView({
    body: "",
    mentions: [],
    forward: stored,
    attachments: [{ id: "a1" }],
  });
  expect(view.body as string).toBe("");
  expect(view.forwarded?.body).toBe("ship it");
  expect(agentMessageView({ body: "plain", mentions: [] })).not.toHaveProperty("forwarded");
});

test("a daemon delivery carries the original in its body, and an empty note still has a body", () => {
  const forwarded = agentForwarded(stored, [{ id: "a1" }]);
  const base = {
    requestId: "request-1",
    workspaceId: WORKSPACE_ID,
    conversationId: SOURCE_DM,
    agentId: SOURCE_CHANNEL,
    messageId: SOURCE_MESSAGE,
    deliveryId: VIEWER,
    sequence: 1,
    target: "@ada",
    latestSenderKind: "human" as const,
    latestSenderHandle: "ada",
    latestSenderDescription: "",
    mentions: [],
    createdAtMs: 1_700_000_000_000,
  };
  const live = decodeAgentMessageDelivery(encodeAgentDelivery({ ...base, body: "", forwarded }));
  expect(live.body).toBe(
    "[forwarded from #product by @ada at 2026-10-30 08:00:00Z]\n> ship it\n[forwarded attachments: a1]",
  );
  const withNote = decodeAgentMessageDelivery(
    encodeAgentDelivery({ ...base, body: "see this", forwarded }),
  );
  expect(withNote.body.startsWith("see this\n[forwarded from #product")).toBe(true);
  // A recovery reads the original into the body once, and the encoder adds nothing more.
  const recovered = agentDeliveryView({ body: "see this", mentions: [], forward: stored });
  expect(recovered).not.toHaveProperty("forwarded");
  expect(decodeAgentMessageDelivery(encodeAgentDelivery({ ...base, ...recovered })).body).toBe(
    withNote.body.replace("\n[forwarded attachments: a1]", ""),
  );
});

function forwardRow(sourceConversationId: string, sourceMessageId: string | null) {
  return {
    sourceRawBody: null,
    sourceMentions: null,
    sourceMessageId,
    sourceConversationId,
    sourceThreadRootId: null,
    sourceConversationName: sourceConversationId === SOURCE_CHANNEL ? "product" : null,
    sourceSenderHandle: "ada",
    sourceCreatedAt: new Date("2026-10-30T08:00:00.000Z"),
    sourceBody: "ship it",
  };
}

function browserRow(forward: BrowserMessageRow["forward"]): BrowserMessageRow {
  return {
    id: "m1",
    sequence: 1,
    threadRootId: null,
    senderMemberId: "member-1",
    body: "note",
    createdAt: new Date("2026-10-30T09:00:00.000Z"),
    sender: null,
    attachments: [],
    mentions: [],
    reactionVersion: 0,
    reactions: [],
    forward,
  };
}

test("a browser message carries the snapshot, unopenable until a viewer's access is settled", () => {
  const view = mapBrowserMessage(
    browserRow(forwardRow(SOURCE_CHANNEL, SOURCE_MESSAGE)),
    WORKSPACE_ID,
  );
  expect(view.forwarded).toEqual({
    sourceSenderHandle: "ada",
    sourceCreatedAt: "2026-10-30T08:00:00.000Z",
    sourceBody: "ship it",
    sourceConversation: { id: SOURCE_CHANNEL, name: "product" },
    sourceMessageId: SOURCE_MESSAGE,
    sourceAccessible: false,
  });
  expect(mapBrowserMessage(browserRow(null), WORKSPACE_ID)).not.toHaveProperty("forwarded");
});

test("a viewer opens an original in a channel, or in a DM of theirs, and only while it exists", async () => {
  const lookups: unknown[] = [];
  const db = {
    conversation: {
      findMany: async (args: unknown) => {
        lookups.push(args);
        return [
          { id: SOURCE_CHANNEL, channelName: "renamed", directKey: null, members: [] },
          { id: SOURCE_DM, channelName: null, directKey: "user:a|user:b", members: [] },
        ];
      },
    },
  } as unknown as Parameters<typeof attachForwardedAccess>[0];
  const channel = mapBrowserMessage(
    browserRow(forwardRow(SOURCE_CHANNEL, SOURCE_MESSAGE)),
    WORKSPACE_ID,
  );
  const dm = mapBrowserMessage(browserRow(forwardRow(SOURCE_DM, SOURCE_MESSAGE)), WORKSPACE_ID);
  const deleted = mapBrowserMessage(browserRow(forwardRow(SOURCE_CHANNEL, null)), WORKSPACE_ID);
  const plain = mapBrowserMessage(browserRow(null), WORKSPACE_ID);
  const [openChannel, closedDm, goneOriginal, ordinary] = await attachForwardedAccess(
    db,
    WORKSPACE_ID,
    VIEWER,
    [channel, dm, deleted, plain],
  );
  expect(openChannel!.forwarded).toMatchObject({
    sourceAccessible: true,
    sourceConversation: { id: SOURCE_CHANNEL, name: "renamed" },
  });
  // Not a member of that DM: the snapshot shows, the original does not open.
  expect(closedDm!.forwarded?.sourceAccessible).toBe(false);
  expect(goneOriginal!.forwarded?.sourceAccessible).toBe(false);
  expect(ordinary).toBe(plain);
  // One lookup for the whole page.
  expect(lookups).toHaveLength(1);
  // A page with no forward asks nothing.
  await attachForwardedAccess(db, WORKSPACE_ID, VIEWER, [plain]);
  expect(lookups).toHaveLength(1);
});

test("a forward that kept the original's body and mentions hands both to the card, and one that did not hands neither", () => {
  const mentions = [{ kind: "user", actorId: VIEWER, handle: "bob", label: "Bob" }];
  const kept = mapBrowserMessage(
    browserRow({
      ...forwardRow(SOURCE_CHANNEL, SOURCE_MESSAGE),
      sourceRawBody: `ship it <@human:${VIEWER}> see <@task:68>`,
      sourceMentions: mentions,
    }),
    WORKSPACE_ID,
  );
  expect(kept.forwarded).toMatchObject({
    sourceBody: "ship it",
    sourceRawBody: `ship it <@human:${VIEWER}> see <@task:68>`,
    sourceMentions: mentions,
  });
  const before = mapBrowserMessage(
    browserRow(forwardRow(SOURCE_CHANNEL, SOURCE_MESSAGE)),
    WORKSPACE_ID,
  );
  expect(before.forwarded).not.toHaveProperty("sourceRawBody");
  expect(before.forwarded).not.toHaveProperty("sourceMentions");
  // A body without its mentions (or the reverse) is never half-drawn.
  const half = mapBrowserMessage(
    browserRow({ ...forwardRow(SOURCE_CHANNEL, SOURCE_MESSAGE), sourceRawBody: "x" }),
    WORKSPACE_ID,
  );
  expect(half.forwarded).not.toHaveProperty("sourceRawBody");
});

test("a snapshot keeps a channel or thread token's name and drops its ids", async () => {
  const { withoutChannelIds } =
    await import("#src/server/conversations/message-forward-source.server");
  const channel = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const root = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const nil = "00000000-0000-0000-0000-000000000000";
  expect(
    withoutChannelIds(`see <@channel:${channel}:product> and <@thread:${channel}:${root}:product>`),
  ).toBe(`see <@channel:${nil}:product> and <@thread:${nil}:${nil}:product>`);
  expect(withoutChannelIds("plain <@task:7> text")).toBe("plain <@task:7> text");
});
