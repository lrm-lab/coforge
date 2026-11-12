import { expect, test } from "bun:test";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { AgentDeliveryPublisher } from "#src/server/conversations/agent-delivery.server";
import { setupActionCards } from "./helpers/action-cards-fixture";
import { actionCardViews } from "#src/server/conversations/action-card-views.server";
import { waitingChoiceCards } from "#src/server/conversations/waiting-choice-cards.server";
import { expireActionCards } from "#src/server/conversations/action-card-expiry.server";
import { ACTION_CARD_TTL_MS } from "#src/server/conversations/action-card-view.server";
import { actionCardBodySuffix } from "#src/server/conversations/agent-message-view.server";
import { commitChoiceCard } from "#src/server/conversations/action-card-choice.server";

const choice = (to: string, prompt = "Which color?") => ({
  type: "choice" as const,
  prompt,
  to,
  options: [
    { id: "a", label: "Red" },
    { id: "b", label: "Blue" },
  ],
});

test("a prepared card expires 24 hours after it is posted, and reads expired before the sweep", async () => {
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
    expect(ACTION_CARD_TTL_MS).toBe(24 * 60 * 60 * 1_000);
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

// Task #569: the expiry wake is a delivery like a choice answer — the wire must carry the row's
// reason, or the daemon consumes it as an ordinary already-seen message and never notifies.
test("the expiry wake carries the delivery's reason on the wire", async () => {
  const ctx = await setupActionCards();
  try {
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: choice(ctx.alice.username),
    });
    await ctx.db.actionCard.update({
      where: { messageId: prepared.messageId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    // The wake only pushes to a Computer the preparing Agent is on.
    await ctx.db.agent.update({
      where: { id: ctx.agent.id },
      data: { computerId: ctx.computer.id },
    });
    const batches: { channel: string; data: Uint8Array }[][] = [];
    const api: Pick<CentrifugoServerApi, "publishBatch"> = {
      publishBatch: async (publications) => {
        batches.push([...publications]);
        return publications.map(() => ({ status: "fulfilled" as const, value: undefined }));
      },
    };
    await expireActionCards(ctx.db, new Date(), {
      publisher: new AgentDeliveryPublisher(api),
    });
    const pushes = batches.flat();
    expect(pushes).toHaveLength(1);
    const wake = decodeAgentMessageDelivery(pushes[0]!.data);
    expect(wake.reason).toBe("expired");
    // The same shape as the answered and declined notices, naming the person who was asked.
    expect(wake.body).toBe(
      `@${ctx.alice.username} did not answer your choice "Which color?" in #${ctx.hub.channelName} before it expired.`,
    );
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

// QA (task #457 item 6): a recommended third option is moved first on the card, so the card's
// text (what an Agent reads back, and what a reply of "1" means) numbers it first too; prepare
// says it moved it; and a read of the answered card names the choice as the recommended one.
test("a recommended option leads the card's text, and its answer reads as recommended", async () => {
  const ctx = await setupActionCards();
  try {
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: {
        ...choice(ctx.alice.username, "Which color?"),
        options: [
          { id: "red", label: "Red" },
          { id: "blue", label: "Blue" },
          { id: "green", label: "Green", recommended: true },
        ],
      },
    });
    expect(prepared.warning).toContain('"Green"');
    const card = await ctx.db.message.findUniqueOrThrow({
      where: { id: prepared.messageId },
      select: { body: true },
    });
    expect(card.body).toBe("Which color? (1. Green; 2. Red; 3. Blue)");
    // Answered by a click, as the card stores it, and read back the way an Agent reads it.
    await commitChoiceCard(
      ctx.db,
      undefined,
      { workspaceId: ctx.workspace.id, actorUserId: ctx.alice.id },
      { messageId: prepared.messageId, optionId: "green" },
      { publisher: { publishBatch: async () => [] } as never },
    );
    const stored = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: prepared.messageId },
      select: {
        state: true,
        kind: true,
        result: true,
        committedByUser: { select: { username: true } },
      },
    });
    // The Agent-facing read names who answered (task #691).
    expect(actionCardBodySuffix(stored)).toBe(
      `[action card: executed; choice=green (recommended) by @${ctx.alice.username}]`,
    );
    expect(
      actionCardBodySuffix({ state: "executed", kind: "choice", result: { optionId: "red" } }),
    ).toBe("[action card: executed; choice=red]");
  } finally {
    await ctx.cleanup();
  }
});
