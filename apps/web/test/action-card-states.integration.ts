import { expect, test } from "bun:test";
import { setupActionCards } from "./helpers/action-cards-fixture";
import { actionCardViews } from "#src/server/conversations/action-card-views.server";
import { waitingChoiceCards } from "#src/server/conversations/waiting-choice-cards.server";
import { expireActionCards } from "#src/server/conversations/action-card-expiry.server";
import { markChoiceCardsAnsweredInChat } from "#src/server/conversations/action-card-answered.server";
import { ACTION_CARD_TTL_MS } from "#src/server/conversations/action-card-view.server";

const choice = (to: string, prompt = "Which color?") => ({
  type: "choice" as const,
  prompt,
  to,
  options: [
    { id: "a", label: "Red" },
    { id: "b", label: "Blue" },
  ],
});

async function messageBy(
  ctx: Awaited<ReturnType<typeof setupActionCards>>,
  userId: string,
  sequence: number,
  threadRootId: string | null = null,
) {
  const member = await ctx.db.conversationMember.findFirstOrThrow({
    where: { conversationId: ctx.hub.id, userId },
    select: { id: true },
  });
  return ctx.db.message.create({
    data: {
      workspaceId: ctx.workspace.id,
      conversationId: ctx.hub.id,
      senderMemberId: member.id,
      sequence,
      threadRootId,
      body: "an answer in chat",
    },
    select: { id: true, sequence: true, threadRootId: true },
  });
}

test("a prepared card expires 7 days after it is posted, and reads expired before the sweep", async () => {
  const ctx = await setupActionCards();
  try {
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: choice(ctx.alice.username),
    });
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: prepared.messageId },
      select: { expiresAt: true, createdAt: true },
    });
    expect(card.expiresAt).not.toBeNull();
    const window = card.expiresAt!.getTime() - card.createdAt.getTime();
    expect(window).toBeLessThanOrEqual(ACTION_CARD_TTL_MS);
    expect(window).toBeGreaterThan(ACTION_CARD_TTL_MS - 5_000);
    await ctx.db.actionCard.update({
      where: { messageId: prepared.messageId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const views = await actionCardViews(ctx.db, ctx.workspace.id, ctx.alice.id, [
      prepared.messageId,
    ]);
    expect(views.get(prepared.messageId)?.state).toBe("expired");
    expect(views.get(prepared.messageId)?.canCommit).toBe(false);
    expect(await waitingChoiceCards(ctx.db, ctx.workspace.id, ctx.alice.id)).toEqual([]);
  } finally {
    await ctx.cleanup();
  }
});

test("the expiry sweep hands each card to only one instance", async () => {
  const ctx = await setupActionCards();
  try {
    const prepared = await Promise.all(
      [1, 2].map((n) =>
        ctx.actionCards.prepare(ctx.principal, {
          target: `#${ctx.hub.channelName}`,
          action: choice(ctx.alice.username, `Which ${n}?`),
        }),
      ),
    );
    await ctx.db.actionCard.updateMany({
      where: { messageId: { in: prepared.map((card) => card.messageId) } },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    // Two sweeps at once, as a blue/green switch runs them; the UPDATE…RETURNING splits the rows.
    const [first, second] = await Promise.all([
      expireActionCards(ctx.db),
      expireActionCards(ctx.db),
    ]);
    expect(first + second).toBe(2);
    expect(
      await ctx.db.actionCard.count({
        where: { messageId: { in: prepared.map((card) => card.messageId) }, state: "expired" },
      }),
    ).toBe(2);
    expect(
      await ctx.db.agentMessageDelivery.count({
        where: { agentId: ctx.agent.id, reason: "expired" },
      }),
    ).toBe(2);
  } finally {
    await ctx.cleanup();
  }
});

test("the asked person's first message answers the card, in its own thread too", async () => {
  const ctx = await setupActionCards();
  try {
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: choice(ctx.alice.username),
    });
    const cardMessage = await ctx.db.message.findUniqueOrThrow({
      where: { id: prepared.messageId },
      select: { sequence: true },
    });
    const first = await messageBy(ctx, ctx.alice.id, cardMessage.sequence + 1);
    const marked = await ctx.db.$transaction((tx) =>
      markChoiceCardsAnsweredInChat(tx, {
        workspaceId: ctx.workspace.id,
        conversationId: ctx.hub.id,
        userId: ctx.alice.id,
        messageId: first.id,
        sequence: first.sequence,
        threadRootId: first.threadRootId,
      }),
    );
    expect(marked).toEqual([prepared.messageId]);
    const answered = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: prepared.messageId },
    });
    expect(answered.state).toBe("answered_in_chat");
    expect(answered.answeredInChatMessageId).toBe(first.id);
    // A later message of theirs does not replace the first one.
    const second = await messageBy(ctx, ctx.alice.id, cardMessage.sequence + 2);
    expect(
      await ctx.db.$transaction((tx) =>
        markChoiceCardsAnsweredInChat(tx, {
          workspaceId: ctx.workspace.id,
          conversationId: ctx.hub.id,
          userId: ctx.alice.id,
          messageId: second.id,
          sequence: second.sequence,
          threadRootId: second.threadRootId,
        }),
      ),
    ).toEqual([]);
    expect(
      (await ctx.db.actionCard.findUniqueOrThrow({ where: { messageId: prepared.messageId } }))
        .answeredInChatMessageId,
    ).toBe(first.id);

    // A top-level card is answered by a reply in the card's own thread, but not by another thread.
    const threaded = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: choice(ctx.alice.username, "Threaded?"),
    });
    const threadedCard = await ctx.db.message.findUniqueOrThrow({
      where: { id: threaded.messageId },
      select: { sequence: true },
    });
    const otherThreadRoot = await messageBy(ctx, ctx.alice.id, threadedCard.sequence + 1);
    await ctx.db.$transaction((tx) =>
      markChoiceCardsAnsweredInChat(tx, {
        workspaceId: ctx.workspace.id,
        conversationId: ctx.hub.id,
        userId: ctx.alice.id,
        messageId: otherThreadRoot.id,
        sequence: otherThreadRoot.sequence,
        threadRootId: otherThreadRoot.id,
      }),
    );
    expect(
      (await ctx.db.actionCard.findUniqueOrThrow({ where: { messageId: threaded.messageId } }))
        .state,
    ).toBe("pending");
    const reply = await messageBy(ctx, ctx.alice.id, threadedCard.sequence + 2, threaded.messageId);
    expect(
      await ctx.db.$transaction((tx) =>
        markChoiceCardsAnsweredInChat(tx, {
          workspaceId: ctx.workspace.id,
          conversationId: ctx.hub.id,
          userId: ctx.alice.id,
          messageId: reply.id,
          sequence: reply.sequence,
          threadRootId: reply.threadRootId,
        }),
      ),
    ).toEqual([threaded.messageId]);
  } finally {
    await ctx.cleanup();
  }
});

test("cancelling records who did it, and the view names them", async () => {
  const ctx = await setupActionCards();
  try {
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: choice(ctx.alice.username),
    });
    await ctx.actionCards.cancel(
      { workspaceId: ctx.workspace.id, actorUserId: ctx.alice.id },
      prepared.messageId,
    );
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: prepared.messageId },
    });
    expect(card.state).toBe("cancelled");
    expect(card.committedByUserId).toBe(ctx.alice.id);
    const view = (
      await actionCardViews(ctx.db, ctx.workspace.id, ctx.alice.id, [prepared.messageId])
    ).get(prepared.messageId);
    expect(view).toMatchObject({ state: "cancelled", committedBy: { isViewer: true } });
  } finally {
    await ctx.cleanup();
  }
});
