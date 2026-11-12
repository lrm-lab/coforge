import { expect, test } from "bun:test";

import { AppError } from "#src/lib/app-error";
import type { MentionRef } from "#src/features/conversations/mention-text";
import { peopleReadableBody } from "#src/server/conversations/message-preview-line.server";
import {
  browserMessageFields,
  mapBrowserMessage,
} from "#src/server/conversations/browser-message-projection.server";
import { attachForwardedAccess } from "#src/server/conversations/message-forward-view.server";
import {
  AGENT_MESSAGE_INCLUDE,
  toAgentMessage,
} from "#src/server/db/repositories/direct-conversation-agent-message.server";
import {
  alice,
  archived,
  bob,
  carol,
  channels,
  db,
  dmAliceCarol,
  dmBobCarol,
  dmWithBob,
  forwardWorld,
  forwards,
  lounge,
  news,
  product,
  rawMessage,
  request,
  sourceMessage,
  storage,
  suffix,
  upload,
  workspaceId,
} from "./helpers/message-forward-world";

/**
 * Forwarding a message or a selection: the snapshots, the copied uploads, who is notified,
 * per-destination results and their retry, what cannot be forwarded, and who may open the original.
 */
forwardWorld();

test("forwards to a channel and a DM: a snapshot as plain text, the note's mentions notify, the original's do not", async () => {
  const { message, file } = await sourceMessage();
  const note = `fyi @fwd-bob-${suffix}`;
  const result = await forwards.forward({
    workspaceId,
    userId: alice.id,
    requestId: request(),
    sourceMessageIds: [message.id],
    destinations: [news.id, dmWithBob],
    note,
  });
  expect(result.outcome).toBe("success");
  expect(result.results.map((entry) => [entry.destination, entry.status])).toEqual([
    [news.id, "success"],
    [dmWithBob, "success"],
  ]);

  const toChannel = await db.message.findFirstOrThrow({
    where: { conversationId: news.id },
    include: { forwards: true, mentions: true, attachments: true },
  });
  expect(toChannel.body).toBe(`fyi <@human:${bob.id}>`);
  // The note's @mention is a real mention; the original's is text in the snapshot.
  expect(toChannel.mentions.map((mention) => mention.actorId)).toEqual([bob.id]);
  expect(toChannel.forwards[0]).toMatchObject({
    sourceMessageId: message.id,
    sourceConversationId: product.id,
    sourceConversationName: `product-${suffix}`,
    sourceSenderName: "Carol",
    sourceSenderHandle: `fwd-carol-${suffix}`,
    sourceThreadRootId: null,
    sourceBody: "ping @Bob about the plan",
  });
  expect(toChannel.forwards[0]!.sourceBody).not.toContain("<@");
  // The card draws the original's chips from the stored body and the mentions as they were, and
  // the plain text every other surface reads is computed from those same two.
  expect(toChannel.forwards[0]).toMatchObject({
    sourceRawBody: `ping <@human:${bob.id}> about the plan`,
    sourceMentions: [{ kind: "user", actorId: bob.id, handle: `fwd-bob-${suffix}`, label: "Bob" }],
  });
  expect(toChannel.forwards[0]!.sourceBody).toBe(
    peopleReadableBody(
      toChannel.forwards[0]!.sourceRawBody!,
      toChannel.forwards[0]!.sourceMentions as MentionRef[],
    ),
  );
  expect(toChannel.forwards[0]!.sourceCreatedAt).toEqual(message.createdAt);

  const toDm = await db.message.findFirstOrThrow({
    where: { conversationId: dmWithBob },
    include: { forwards: true, attachments: true },
  });
  expect(toDm.forwards[0]?.sourceBody).toBe("ping @Bob about the plan");
  // Forwarded by alice, sent as alice.
  const sender = await db.conversationMember.findUniqueOrThrow({
    where: { id: toDm.senderMemberId! },
  });
  expect(sender.userId).toBe(alice.id);

  // The uploads are copies: own rows, own objects, in the destination conversation, alice's.
  for (const [forwarded, conversationId] of [
    [toChannel, news.id],
    [toDm, dmWithBob],
  ] as const) {
    expect(forwarded.attachments).toHaveLength(1);
    const copy = forwarded.attachments[0]!;
    expect(copy.id).not.toBe(file.id);
    expect(copy.objectKey).not.toBe(file.objectKey);
    expect(copy).toMatchObject({
      conversationId,
      uploaderId: alice.id,
      fileName: "plan.txt",
      contentType: "text/plain",
      sizeBytes: file.sizeBytes,
      messageId: forwarded.id,
    });
    expect(await new Response((await storage.open(copy.objectKey))!.body).text()).toBe("the plan");
  }
});

test("deleting the original leaves the forward, its copied files and its snapshot", async () => {
  const { message, file } = await sourceMessage("keep this");
  await forwards.forward({
    workspaceId,
    userId: alice.id,
    requestId: request(),
    sourceMessageIds: [message.id],
    destinations: [news.id],
  });
  const forwarded = await db.message.findFirstOrThrow({
    where: { conversationId: news.id, forwards: { some: { sourceMessageId: message.id } } },
    include: { attachments: true },
  });
  // A forward with no note has an empty body.
  expect(forwarded.body).toBe("");

  await db.attachment.delete({ where: { id: file.id } });
  await storage.remove(file.objectKey);
  await db.message.delete({ where: { id: message.id } });

  const after = await db.messageForward.findUniqueOrThrow({
    where: { messageId_position: { messageId: forwarded.id, position: 0 } },
  });
  expect(after.sourceMessageId).toBeNull();
  expect(after.sourceBody).toBe("keep this");
  const copy = forwarded.attachments[0]!;
  expect(await new Response((await storage.open(copy.objectKey))!.body).text()).toBe("the plan");

  // The card no longer opens the original, for anyone.
  const row = await db.message.findUniqueOrThrow({
    where: { id: forwarded.id },
    select: browserMessageFields,
  });
  const [view] = await attachForwardedAccess(db, workspaceId, alice.id, [
    mapBrowserMessage(row, workspaceId),
  ]);
  expect(view!.forwarded?.[0]).toMatchObject({
    sourceSenderHandle: `fwd-carol-${suffix}`,
    sourceAccessible: false,
  });
  expect(view!.forwarded?.[0]).not.toHaveProperty("sourceMessageId");
});

test("a retry under the same request id replays what succeeded and sends only what failed", async () => {
  const { message } = await sourceMessage("retry me");
  const requestId = request();
  const input = {
    workspaceId,
    userId: alice.id,
    requestId,
    sourceMessageIds: [message.id],
    note: "again",
  };
  // Not joined, archived: each refused with its own reason, and the rest still go through.
  const first = await forwards.forward({
    ...input,
    destinations: [news.id, archived.id, lounge.id, crypto.randomUUID()],
  });
  expect(first.outcome).toBe("partial_failure");
  expect(first.results.map((entry) => entry.status)).toEqual([
    "success",
    "failed",
    "failed",
    "failed",
  ]);
  expect(
    first.results.slice(1).map((entry) => (entry.status === "failed" ? entry.error.code : "")),
  ).toEqual(["archived", "not_joined", "no_access"]);
  // Nothing half-made: the refused destinations have no message and no copied upload.
  expect(
    await db.message.count({ where: { conversationId: { in: [archived.id, lounge.id] } } }),
  ).toBe(0);
  expect(
    await db.attachment.count({ where: { conversationId: { in: [archived.id, lounge.id] } } }),
  ).toBe(0);

  // Joining is the person's call; the client does it and sends again.
  await db.conversationMember.create({
    data: { workspaceId, conversationId: lounge.id, userId: alice.id },
  });
  const second = await forwards.forward({ ...input, destinations: [news.id, lounge.id] });
  expect(second.outcome).toBe("success");
  expect(second.results[0]).toEqual(first.results[0]!);
  expect(second.results[1]!.status).toBe("success");
  expect(
    await db.message.count({
      where: { conversationId: news.id, forwards: { some: { sourceMessageId: message.id } } },
    }),
  ).toBe(1);
  expect(
    await db.attachment.count({ where: { conversationId: news.id, fileName: "plan.txt" } }),
  ).toBeGreaterThan(0);

  const copiesBefore = await db.attachment.count({ where: { workspaceId } });
  const third = await forwards.forward({ ...input, destinations: [news.id, lounge.id] });
  expect(third.outcome).toBe("idempotent_replay");
  expect(third.results).toEqual(second.results);
  expect(await db.attachment.count({ where: { workspaceId } })).toBe(copiesBefore);
});

test("refuses the whole request for a source that is a forward, a notice, an action card or unseen", async () => {
  const { message } = await sourceMessage("original");
  const forwarded = await forwards.forward({
    workspaceId,
    userId: alice.id,
    requestId: request(),
    sourceMessageIds: [message.id],
    destinations: [news.id],
  });
  const forwardId =
    forwarded.results[0]!.status === "success" ? forwarded.results[0]!.message.id : "";
  const notice = await rawMessage(product.id, null, "Task #1 created");
  const hidden = await rawMessage(dmBobCarol, bob.id, "between bob and carol");
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `fwd-bot-${suffix}`,
      displayName: "Bot",
      ownerId: alice.id,
      runtimeConfig: {},
    },
  });
  await db.conversationMember.create({
    data: { workspaceId, conversationId: product.id, agentId: agent.id },
  });
  const card = await rawMessage(product.id, null, "create it");
  const botMember = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: product.id, agentId: agent.id },
  });
  await db.message.update({ where: { id: card.id }, data: { senderMemberId: botMember.id } });
  await db.actionCard.create({
    data: {
      messageId: card.id,
      conversationId: product.id,
      workspaceId,
      kind: "channel:create",
      payload: {},
      preparedByAgentId: agent.id,
    },
  });

  const refuse = async (messageId: string, code: AppError["code"]) => {
    const error = await forwards
      .forward({
        workspaceId,
        userId: alice.id,
        requestId: request(),
        sourceMessageIds: [messageId],
        destinations: [news.id],
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  };
  await refuse(forwardId, "INVALID_INPUT");
  await refuse(notice.id, "INVALID_INPUT");
  await refuse(card.id, "INVALID_INPUT");
  // A DM alice is not in reads as missing, not as forbidden.
  await refuse(hidden.id, "NOT_FOUND");
  await refuse(crypto.randomUUID(), "NOT_FOUND");
  // Nothing was written by any refused request.
  expect(
    await db.message.count({
      where: {
        conversationId: news.id,
        forwards: { some: { sourceMessageId: { in: [forwardId, notice.id, card.id, hidden.id] } } },
      },
    }),
  ).toBe(0);
});

test("a thread reply, a Task's message and an Agent's message forward as snapshots", async () => {
  const root = await rawMessage(product.id, carol.id, "the root");
  const reply = await rawMessage(product.id, carol.id, "a reply", { threadRootId: root.id });
  const result = await forwards.forward({
    workspaceId,
    userId: alice.id,
    requestId: request(),
    sourceMessageIds: [reply.id],
    destinations: [dmWithBob],
  });
  expect(result.outcome).toBe("success");
  const forwarded = await db.message.findFirstOrThrow({
    where: { conversationId: dmWithBob, forwards: { some: { sourceMessageId: reply.id } } },
    include: { forwards: true },
  });
  expect(forwarded.forwards[0]).toMatchObject({
    sourceThreadRootId: root.id,
    sourceBody: "a reply",
  });
});

test("only a viewer who can read the source's conversation can open the original", async () => {
  // Alice forwards from her DM with carol into #news; bob reads #news but is not in that DM.
  const secret = await rawMessage(dmAliceCarol, carol.id, "just us");
  const result = await forwards.forward({
    workspaceId,
    userId: alice.id,
    requestId: request(),
    sourceMessageIds: [secret.id],
    destinations: [news.id],
    note: "look",
  });
  expect(result.outcome).toBe("success");
  const id = result.results[0]!.status === "success" ? result.results[0].message.id : "";
  const row = await db.message.findUniqueOrThrow({ where: { id }, select: browserMessageFields });
  const mapped = mapBrowserMessage(row, workspaceId);
  // Unsettled, a card opens nothing.
  expect(mapped.forwarded?.[0]).toMatchObject({
    sourceBody: "just us",
    sourceConversation: { id: dmAliceCarol, name: null },
    sourceMessageId: secret.id,
    sourceAccessible: false,
  });
  const accessible = async (userId: string) =>
    (await attachForwardedAccess(db, workspaceId, userId, [mapped]))[0]!.forwarded?.[0]
      ?.sourceAccessible;
  expect(await accessible(alice.id)).toBe(true);
  expect(await accessible(carol.id)).toBe(true);
  expect(await accessible(bob.id)).toBe(false);
});

test("an Agent reads a forward as its note and a structured original with the copied attachment ids", async () => {
  const { message } = await sourceMessage("read by an agent");
  const result = await forwards.forward({
    workspaceId,
    userId: alice.id,
    requestId: request(),
    sourceMessageIds: [message.id],
    destinations: [news.id],
  });
  const id = result.results[0]!.status === "success" ? result.results[0].message.id : "";
  const row = await db.message.findUniqueOrThrow({ where: { id }, include: AGENT_MESSAGE_INCLUDE });
  const agentView = toAgentMessage(row, `#news-${suffix}`);
  expect(agentView.body as string).toBe("");
  expect(agentView.forwardedMessages).toEqual([
    {
      from: `#product-${suffix}`,
      sender: `@fwd-carol-${suffix}`,
      sentAt: message.createdAt.toISOString(),
      body: "read by an agent",
      attachments: row.attachments.map((attachment) => attachment.id),
    },
  ]);
  expect(agentView.forwardedMessages![0]!.attachments).toHaveLength(1);
  expect(agentView.forwarded).toEqual(agentView.forwardedMessages![0]!);
});

test("a normal send still refuses an empty body", async () => {
  await expect(
    channels.send({
      workspaceId,
      userId: alice.id,
      channelId: news.id,
      idempotencyKey: crypto.randomUUID(),
      body: "   ",
    }),
  ).rejects.toThrow();
});

test("a selection forwards as one message carrying its originals oldest first, each with its own copies", async () => {
  // Picked newest first: the forward still reads as the conversation did.
  const { message: first, file } = await sourceMessage();
  const second = await rawMessage(product.id, carol.id, "and the budget");
  const budget = await upload(product.id, carol.id, "budget.txt", "the budget");
  await db.attachment.update({ where: { id: budget.id }, data: { messageId: second.id } });
  const result = await forwards.forward({
    workspaceId,
    userId: alice.id,
    requestId: request(),
    sourceMessageIds: [second.id, first.id],
    destinations: [news.id],
  });
  expect(result.outcome).toBe("success");
  const id = result.results[0]!.status === "success" ? result.results[0].message.id : "";
  const forwarded = await db.message.findUniqueOrThrow({
    where: { id },
    include: {
      forwards: { orderBy: { position: "asc" } },
      attachments: { orderBy: { position: "asc" } },
    },
  });
  expect(forwarded.body).toBe("");
  expect(forwarded.forwards.map((row) => [row.position, row.sourceMessageId])).toEqual([
    [0, first.id],
    [1, second.id],
  ]);
  // Each copy names the original it is of.
  expect(
    forwarded.attachments.map((attachment) => [attachment.fileName, attachment.forwardPosition]),
  ).toEqual([
    [file.fileName, 0],
    ["budget.txt", 1],
  ]);
  const [planCopy, budgetCopy] = forwarded.attachments.map((attachment) => attachment.id);
  // The browser reads both, in order, each with its own copy.
  const row = await db.message.findUniqueOrThrow({ where: { id }, select: browserMessageFields });
  expect(
    mapBrowserMessage(row, workspaceId).forwarded?.map((original) => [
      original.sourceBody,
      original.attachmentIds,
    ]),
  ).toEqual([
    ["ping @Bob about the plan", [planCopy]],
    ["and the budget", [budgetCopy]],
  ]);
  // So does an Agent.
  const agentRow = await db.message.findUniqueOrThrow({
    where: { id },
    include: AGENT_MESSAGE_INCLUDE,
  });
  expect(
    toAgentMessage(agentRow, `#news-${suffix}`).forwardedMessages?.map(
      (original) => original.attachments,
    ),
  ).toEqual([[planCopy], [budgetCopy]]);
});

test("one original that cannot be forwarded refuses the whole selection, and nothing is sent", async () => {
  const { message } = await sourceMessage();
  const notice = await rawMessage(product.id, null, "a server notice");
  await expect(
    forwards.forward({
      workspaceId,
      userId: alice.id,
      requestId: request(),
      sourceMessageIds: [message.id, notice.id],
      destinations: [lounge.id],
    }),
  ).rejects.toThrow();
  expect(
    await db.message.count({
      where: { conversationId: lounge.id, forwards: { some: { sourceMessageId: message.id } } },
    }),
  ).toBe(0);
});
