import { expect, test } from "bun:test";
import { APP_GRANT_AGENT_CARD_KIND } from "@lrm/coforge-sdk/agent";
import { setupActionCards } from "./helpers/action-cards-fixture";
import { actionCardViews } from "#src/server/conversations/action-card-views.server";
import { waitingChoiceCards } from "#src/server/conversations/waiting-choice-cards.server";
import { commitChoiceCard } from "#src/server/conversations/action-card-choice.server";
import { actionCardBodySuffix } from "#src/server/conversations/agent-message-view.server";
import { isAppError } from "#src/lib/app-error";

const choice = (to: string, prompt = "Which color?") => ({
  type: "choice" as const,
  prompt,
  to,
  options: [
    { id: "a", label: "Red" },
    { id: "b", label: "Blue" },
  ],
});

const questions = (to: string) => ({
  type: "questions" as const,
  prompt: "A few things",
  to,
  questions: [
    {
      id: "tier",
      prompt: "Which tier?",
      select: "one" as const,
      options: [
        { id: "free", label: "Free" },
        { id: "pro", label: "Pro" },
      ],
    },
  ],
});

/** The asked person must be able to read the conversation they are asked in. */
async function seat(ctx: Awaited<ReturnType<typeof setupActionCards>>, userId: string) {
  await ctx.db.conversation.update({
    where: { id: ctx.hub.id },
    data: { members: { create: { userId } } },
  });
}

const errorCode = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return undefined;
  } catch (error) {
    return isAppError(error) ? error.code : undefined;
  }
};

test("the person a choice card asks can cancel it", async () => {
  const ctx = await setupActionCards();
  try {
    await seat(ctx, ctx.bob.id);
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: choice(ctx.bob.username),
    });
    // The view offers the asked person the cancel: the interface the ignore button takes.
    const view = (
      await actionCardViews(ctx.db, ctx.workspace.id, ctx.bob.id, [prepared.messageId])
    ).get(prepared.messageId);
    expect(view).toMatchObject({ state: "pending", canCommit: true, canCancel: true });
    expect(await waitingChoiceCards(ctx.db, ctx.workspace.id, ctx.bob.id)).toHaveLength(1);

    await ctx.actionCards.cancel(
      { workspaceId: ctx.workspace.id, actorUserId: ctx.bob.id },
      prepared.messageId,
    );
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: prepared.messageId },
      select: {
        state: true,
        committedByUserId: true,
        kind: true,
        committedByUser: { select: { username: true } },
      },
    });
    expect(card.state).toBe("cancelled");
    expect(card.committedByUserId).toBe(ctx.bob.id);
    // The asking Agent's next read names who dismissed it, in the existing suffix format.
    expect(actionCardBodySuffix(card)).toBe(`[action card: cancelled by @${ctx.bob.username}]`);
    // The card stops waiting on the asked person; the realtime publication that announces the
    // settle is what makes the browser refresh the card's state and the Activity waiting count.
    expect(await waitingChoiceCards(ctx.db, ctx.workspace.id, ctx.bob.id)).toEqual([]);
    // `prepare` published the card's own event; the cancel adds exactly one more.
    expect(ctx.realtimeEvents.length).toBeGreaterThanOrEqual(2);
    expect(ctx.realtimeEvents.at(-1)).toMatchObject({
      conversationId: ctx.hub.id,
      messageId: prepared.messageId,
    });
  } finally {
    await ctx.cleanup();
  }
});

test("the person a questions card asks can cancel it too", async () => {
  const ctx = await setupActionCards();
  try {
    await seat(ctx, ctx.bob.id);
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: questions(ctx.bob.username),
    });
    await ctx.actionCards.cancel(
      { workspaceId: ctx.workspace.id, actorUserId: ctx.bob.id },
      prepared.messageId,
    );
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: prepared.messageId },
      select: { state: true, committedByUserId: true },
    });
    expect(card.state).toBe("cancelled");
    expect(card.committedByUserId).toBe(ctx.bob.id);
  } finally {
    await ctx.cleanup();
  }
});

test("a member who can read the conversation but is not asked is denied", async () => {
  const ctx = await setupActionCards();
  try {
    await seat(ctx, ctx.bob.id);
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: choice(ctx.bob.username),
    });
    const eve = await ctx.db.user.create({
      data: { displayName: "ac-eve", username: `ac-eve-${crypto.randomUUID().slice(0, 8)}` },
    });
    await ctx.db.workspaceMembership.create({
      data: { workspaceId: ctx.workspace.id, userId: eve.id, role: "member" },
    });
    await seat(ctx, eve.id);
    const code = await errorCode(() =>
      ctx.actionCards.cancel(
        { workspaceId: ctx.workspace.id, actorUserId: eve.id },
        prepared.messageId,
      ),
    );
    expect(code).toBe("ACCESS_DENIED");
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: prepared.messageId },
      select: { state: true },
    });
    expect(card.state).toBe("pending");
  } finally {
    await ctx.cleanup();
  }
});

test("an app grant card is still refused, whoever asks", async () => {
  const ctx = await setupActionCards();
  try {
    await seat(ctx, ctx.bob.id);
    const member = await ctx.db.conversationMember.findFirstOrThrow({
      where: { conversationId: ctx.hub.id, userId: ctx.alice.id },
      select: { id: true },
    });
    const message = await ctx.db.message.create({
      data: {
        conversationId: ctx.hub.id,
        workspaceId: ctx.workspace.id,
        body: "app grant",
        sequence: 1,
        senderMemberId: member.id,
      },
      select: { id: true },
    });
    await ctx.db.actionCard.create({
      data: {
        messageId: message.id,
        conversationId: ctx.hub.id,
        workspaceId: ctx.workspace.id,
        kind: APP_GRANT_AGENT_CARD_KIND,
        payload: {
          type: APP_GRANT_AGENT_CARD_KIND,
          requestId: crypto.randomUUID(),
          agentId: ctx.agent.id,
          appKey: "ac-app",
          appName: "Acme Notes",
          scopes: ["openid"],
        },
        preparedByAgentId: ctx.agent.id,
      },
    });
    // A member who can read the card still may not cancel it: an app grant denies through
    // `AppGrantActionCards.deny`, not here. Only who could cancel an ordinary card reaches the
    // kind refusal (the owner and an admin as INVALID_INPUT); anyone else is just denied.
    const codes = await Promise.all(
      [ctx.bob.id, ctx.dave.id, ctx.alice.id].map((actor) =>
        errorCode(() =>
          ctx.actionCards.cancel({ workspaceId: ctx.workspace.id, actorUserId: actor }, message.id),
        ),
      ),
    );
    expect(codes).toEqual(["ACCESS_DENIED", "INVALID_INPUT", "INVALID_INPUT"]);
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: message.id },
      select: { state: true },
    });
    expect(card.state).toBe("pending");
  } finally {
    await ctx.cleanup();
  }
});

test("an executed card cannot be cancelled", async () => {
  const ctx = await setupActionCards();
  try {
    await seat(ctx, ctx.bob.id);
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: choice(ctx.bob.username),
    });
    await commitChoiceCard(
      ctx.db,
      undefined,
      { workspaceId: ctx.workspace.id, actorUserId: ctx.bob.id },
      { messageId: prepared.messageId, optionId: "a" },
      { publisher: { publishBatch: async () => [] } as never },
    );
    const code = await errorCode(() =>
      ctx.actionCards.cancel(
        { workspaceId: ctx.workspace.id, actorUserId: ctx.bob.id },
        prepared.messageId,
      ),
    );
    expect(code).toBe("CONFLICT");
  } finally {
    await ctx.cleanup();
  }
});

test("a second cancel by the same person is a no-op, and two racers settle it once", async () => {
  const ctx = await setupActionCards();
  try {
    await seat(ctx, ctx.bob.id);
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: choice(ctx.bob.username),
    });
    const cancel = () =>
      ctx.actionCards.cancel(
        { workspaceId: ctx.workspace.id, actorUserId: ctx.bob.id },
        prepared.messageId,
      );
    await cancel();
    // The client's undo window, a leave-page keepalive and a retry can all send this again.
    await cancel();
    // Two different people racing: exactly one settles the pending row, the loser sees the settle.
    const second = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: choice(ctx.bob.username),
    });
    const [bobs, alices] = await Promise.allSettled([
      ctx.actionCards.cancel(
        { workspaceId: ctx.workspace.id, actorUserId: ctx.bob.id },
        second.messageId,
      ),
      ctx.actionCards.cancel(
        { workspaceId: ctx.workspace.id, actorUserId: ctx.alice.id },
        second.messageId,
      ),
    ]);
    expect([bobs, alices].filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: second.messageId },
      select: { state: true },
    });
    expect(card.state).toBe("cancelled");
  } finally {
    await ctx.cleanup();
  }
});
