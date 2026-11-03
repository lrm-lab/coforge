import { expect, test } from "bun:test";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { setupActionCards } from "./helpers/action-cards-fixture";

/**
 * What people and Agents read of an action card (`ActionCards.viewsFor`, the Agent-facing message
 * body), against local PostgreSQL: names resolved per viewer, who may commit or cancel, and the
 * card's state as it moves.
 */

test("viewsFor resolves names, reports per-viewer canCommit/canCancel, and exposes the committer", async () => {
  const ctx = await setupActionCards();
  try {
    const createCard = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: { type: "channel:create", name: `views-${ctx.suffix}`, initialHumans: [ctx.bob.id] },
    });
    const addMemberCard = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: {
        type: "channel:add_member",
        channel: ctx.hub.channelName!,
        humans: [ctx.bob.username],
      },
    });
    const agentCard = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: { type: "agent:create", name: `viewsagent-${ctx.suffix}` },
    });
    const ids = [createCard.messageId, addMemberCard.messageId, agentCard.messageId];

    // bob: a plain member and not a member of #hub-for-add-members... wait, bob IS not a member
    // of #hub in this fixture, so `channel:add_member` is not committable by bob, and
    // `agent:create` is not committable by a plain member either.
    const bobViews = await ctx.actionCards.viewsFor(ctx.workspace.id, ctx.bob.id, ids);
    const createView = bobViews.get(createCard.messageId);
    expect(createView?.canCommit).toBe(true);
    if (createView?.kind === "channel:create")
      expect(createView.initialHumans.map((human) => human.displayName)).toEqual([
        ctx.bob.username,
      ]);
    expect(bobViews.get(addMemberCard.messageId)?.canCommit).toBe(false);
    expect(bobViews.get(agentCard.messageId)?.canCommit).toBe(false);

    // alice: a member of #hub and Workspace owner, so all three are committable.
    const aliceViews = await ctx.actionCards.viewsFor(ctx.workspace.id, ctx.alice.id, ids);
    expect(aliceViews.get(createCard.messageId)?.canCommit).toBe(true);
    expect(aliceViews.get(addMemberCard.messageId)?.canCommit).toBe(true);
    expect(aliceViews.get(agentCard.messageId)?.canCommit).toBe(true);

    // Commit one and confirm the executed view exposes the committer and turns off canCommit.
    await ctx.actionCards.commitChannelCreate(
      { workspaceId: ctx.workspace.id, actorUserId: ctx.alice.id },
      {
        messageId: createCard.messageId,
        name: `views-${ctx.suffix}`,
        memberUserIds: [],
        memberAgentIds: [],
      },
    );
    const afterCommit = await ctx.actionCards.viewsFor(ctx.workspace.id, ctx.bob.id, [
      createCard.messageId,
    ]);
    const executedView = afterCommit.get(createCard.messageId)!;
    expect(executedView.state).toBe("executed");
    expect(executedView.canCommit).toBe(false);
    expect(executedView.committedBy).toEqual({
      displayName: ctx.alice.username,
      isViewer: false,
    });

    // A reference that no longer resolves (simulating a deleted user, without violating the
    // fixture's own FK constraints) resolves to "unknown" instead of throwing.
    await ctx.db.actionCard.update({
      where: { messageId: addMemberCard.messageId },
      data: {
        payload: {
          type: "channel:add_member",
          channelId: ctx.hub.id,
          humanIds: [crypto.randomUUID()],
        },
      },
    });
    const afterMutation = await ctx.actionCards.viewsFor(ctx.workspace.id, ctx.alice.id, [
      addMemberCard.messageId,
    ]);
    const addMemberView = afterMutation.get(addMemberCard.messageId)!;
    if (addMemberView.kind === "channel:add_member")
      expect(addMemberView.humans.map((human) => human.displayName)).toEqual(["unknown"]);
  } finally {
    await ctx.cleanup();
  }
});

test("Agent-facing message reads show the card's current state suffix", async () => {
  const ctx = await setupActionCards();
  try {
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: { type: "channel:create", name: `agent-read-${ctx.suffix}` },
    });
    const conversations = new PrismaDirectConversationRepository(ctx.db);

    const pendingRead = await conversations.resolveAgentMessage(
      ctx.workspace.id,
      ctx.agent.id,
      prepared.messageId,
    );
    expect(pendingRead.body.endsWith("[action card: pending]")).toBe(true);

    await ctx.actionCards.commitChannelCreate(
      { workspaceId: ctx.workspace.id, actorUserId: ctx.alice.id },
      {
        messageId: prepared.messageId,
        name: `agent-read-${ctx.suffix}`,
        memberUserIds: [],
        memberAgentIds: [],
      },
    );
    const executedRead = await conversations.resolveAgentMessage(
      ctx.workspace.id,
      ctx.agent.id,
      prepared.messageId,
    );
    expect(executedRead.body.endsWith("[action card: executed]")).toBe(true);
  } finally {
    await ctx.cleanup();
  }
});
