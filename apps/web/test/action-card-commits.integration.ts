import { expect, test } from "bun:test";
import { expectAppErrorCode, setupActionCards } from "./helpers/action-cards-fixture";

/**
 * Commit/cancel: a human executes the real operation under their
 * own identity, then the card is marked `executed`/`cancelled`. Reuses `setupActionCards()`'s fixture: alice
 * is Workspace owner and Scout's (`ctx.agent`) owner, bob is a plain member and Helper's
 * (`ctx.bobsAgent`) owner, dave is Workspace admin.
 */

test("commit channel:create executes PublicChannels.create + addMembers and marks the card executed", async () => {
  const ctx = await setupActionCards();
  try {
    const name = `commit-create-${ctx.suffix}`;
    const description = "Engineering discussion";
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: { type: "channel:create", name, description, initialHumans: [ctx.bob.username] },
    });

    const result = await ctx.actionCards.commitChannelCreate(
      { workspaceId: ctx.workspace.id, actorUserId: ctx.alice.id },
      { messageId: prepared.messageId, name, memberUserIds: [ctx.bob.id], memberAgentIds: [] },
    );

    const created = await ctx.db.conversation.findUniqueOrThrow({
      where: { id: result.channelId },
      include: { members: true },
    });
    expect(created.channelName).toBe(name);
    // The Agent-proposed description rides along from the card's own resolved payload
    // and is now persisted on the created Conversation.
    expect(created.description).toBe(description);
    expect(created.members.some((member) => member.userId === ctx.bob.id)).toBe(true);

    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: prepared.messageId },
    });
    expect(card.state).toBe("executed");
    expect(card.committedByUserId).toBe(ctx.alice.id);
    expect(card.committedAt).not.toBeNull();
    expect(card.result).toEqual({ channelId: result.channelId });

    // A second commit fails: the operation's own name-uniqueness rule fires first.
    await expectAppErrorCode(
      ctx.actionCards.commitChannelCreate(
        { workspaceId: ctx.workspace.id, actorUserId: ctx.alice.id },
        { messageId: prepared.messageId, name, memberUserIds: [], memberAgentIds: [] },
      ),
      "CONFLICT",
    );
  } finally {
    await ctx.cleanup();
  }
});

test("a member the channel would refuse leaves no channel behind", async () => {
  const ctx = await setupActionCards();
  try {
    const name = `atomic-${ctx.suffix}`;
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: { type: "channel:create", name, initialHumans: [] },
    });
    const privateAgent = await ctx.db.agent.create({
      data: {
        workspaceId: ctx.workspace.id,
        ownerId: ctx.alice.id,
        name: `private-${ctx.suffix}`,
        displayName: "Private",
        visibility: "private",
        runtimeConfig: {},
      },
    });
    await expect(
      ctx.actionCards.commitChannelCreate(
        { workspaceId: ctx.workspace.id, actorUserId: ctx.alice.id },
        {
          messageId: prepared.messageId,
          name,
          memberUserIds: [],
          memberAgentIds: [privateAgent.id],
        },
      ),
    ).rejects.toMatchObject({ errorId: "agent-private" });
    // Nothing was written: no channel of that name, and the card is still answerable.
    expect(
      await ctx.db.conversation.findFirst({
        where: { workspaceId: ctx.workspace.id, channelName: name },
      }),
    ).toBeNull();
    expect(
      (await ctx.db.actionCard.findUniqueOrThrow({ where: { messageId: prepared.messageId } }))
        .state,
    ).toBe("pending");
  } finally {
    await ctx.cleanup();
  }
});

test("commit channel:add_member requires the actor to already be a channel member", async () => {
  const ctx = await setupActionCards();
  try {
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: {
        type: "channel:add_member",
        channel: ctx.hub.channelName!,
        humans: [ctx.bob.username],
      },
    });

    // bob is not a member of #hub yet: ACCESS_DENIED, card stays pending.
    await expectAppErrorCode(
      ctx.actionCards.commitChannelAddMember(
        { workspaceId: ctx.workspace.id, actorUserId: ctx.bob.id },
        {
          messageId: prepared.messageId,
          channelId: ctx.hub.id,
          userIds: [ctx.bob.id],
          agentIds: [],
        },
      ),
      "ACCESS_DENIED",
    );
    expect(
      (await ctx.db.actionCard.findUniqueOrThrow({ where: { messageId: prepared.messageId } }))
        .state,
    ).toBe("pending");

    // alice is a member of #hub: succeeds and marks the card.
    const result = await ctx.actionCards.commitChannelAddMember(
      { workspaceId: ctx.workspace.id, actorUserId: ctx.alice.id },
      { messageId: prepared.messageId, channelId: ctx.hub.id, userIds: [ctx.bob.id], agentIds: [] },
    );
    expect(result).toEqual({ channelId: ctx.hub.id, userIds: [ctx.bob.id], agentIds: [] });
    const member = await ctx.db.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: ctx.hub.id, userId: ctx.bob.id } },
    });
    expect(member).not.toBeNull();
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: prepared.messageId },
    });
    expect(card.state).toBe("executed");
    expect(card.committedByUserId).toBe(ctx.alice.id);
  } finally {
    await ctx.cleanup();
  }
});

test("agent:create guard/mark: pending precheck, workspace scoping, and marking executed", async () => {
  const ctx = await setupActionCards();
  try {
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: {
        type: "agent:create",
        name: `newagent-${ctx.suffix}`,
        requiredComputer: ctx.computer.name,
      },
    });

    // Guard passes while pending, the viewer can read the conversation, and the required Computer
    // is the one being used.
    await ctx.actionCards.assertAgentCreateCommittable(
      ctx.workspace.id,
      ctx.alice.id,
      prepared.messageId,
      ctx.computer.id,
    );

    // `requiredComputer` is a placement contract: another Computer is rejected server-side.
    await expectAppErrorCode(
      ctx.actionCards.assertAgentCreateCommittable(
        ctx.workspace.id,
        ctx.alice.id,
        prepared.messageId,
        crypto.randomUUID(),
      ),
      "INVALID_INPUT",
    );

    // A viewer who cannot read the conversation (not a Workspace member of this Workspace) is
    // rejected before any Agent would be created.
    const stranger = await ctx.db.user.create({
      data: { displayName: `ac-stranger-${ctx.suffix}`, username: `ac-stranger-${ctx.suffix}` },
    });
    try {
      await expectAppErrorCode(
        ctx.actionCards.assertAgentCreateCommittable(
          ctx.workspace.id,
          stranger.id,
          prepared.messageId,
          ctx.computer.id,
        ),
        "ACCESS_DENIED",
      );
    } finally {
      await ctx.db.user.delete({ where: { id: stranger.id } });
    }

    // `ManageAgents.create`'s own authority gate (`assertCanCreateAgents`, owner/admin only) is
    // covered by `manage-agents.test.ts`; here we only own the guard-before/mark-after seam
    // `agents.functions.ts#createAgent` calls around it.
    const created = await ctx.db.agent.create({
      data: {
        workspaceId: ctx.workspace.id,
        name: `newagent-${ctx.suffix}`,
        displayName: `newagent-${ctx.suffix}`,
        ownerId: ctx.alice.id,
        runtimeConfig: {},
      },
    });
    await ctx.actionCards.completeAgentCreate(
      ctx.workspace.id,
      ctx.alice.id,
      prepared.messageId,
      created.id,
    );
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: prepared.messageId },
    });
    expect(card.state).toBe("executed");
    expect(card.committedByUserId).toBe(ctx.alice.id);
    expect(card.result).toEqual({ agentId: created.id });

    // Once executed, the guard rejects a second attempt before any second Agent is created.
    await expectAppErrorCode(
      ctx.actionCards.assertAgentCreateCommittable(
        ctx.workspace.id,
        ctx.alice.id,
        prepared.messageId,
        ctx.computer.id,
      ),
      "CONFLICT",
    );
  } finally {
    await ctx.cleanup();
  }
});

test("cancel: the preparing Agent's owner and a Workspace admin may cancel; another member may not", async () => {
  const ctx = await setupActionCards();
  try {
    // Helper is owned by bob, a plain member: proves the Agent.ownerId path independent of role.
    const helperPrincipal = { workspaceId: ctx.workspace.id, agentId: ctx.bobsAgent.id };
    const byOwner = await ctx.actionCards.prepare(helperPrincipal, {
      target: `#${ctx.hub.channelName}`,
      action: { type: "channel:create", name: `owner-cancel-${ctx.suffix}` },
    });
    await ctx.actionCards.cancel(
      { workspaceId: ctx.workspace.id, actorUserId: ctx.bob.id },
      byOwner.messageId,
    );
    expect(
      (await ctx.db.actionCard.findUniqueOrThrow({ where: { messageId: byOwner.messageId } }))
        .state,
    ).toBe("cancelled");

    // Scout is owned by alice; dave (admin, not the owner) may still cancel.
    const byAdmin = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: { type: "channel:create", name: `admin-cancel-${ctx.suffix}` },
    });
    await ctx.actionCards.cancel(
      { workspaceId: ctx.workspace.id, actorUserId: ctx.dave.id },
      byAdmin.messageId,
    );
    expect(
      (await ctx.db.actionCard.findUniqueOrThrow({ where: { messageId: byAdmin.messageId } }))
        .state,
    ).toBe("cancelled");

    // Another plain member (bob), neither the owner nor an admin, is denied.
    const byOther = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: { type: "channel:create", name: `denied-cancel-${ctx.suffix}` },
    });
    await expectAppErrorCode(
      ctx.actionCards.cancel(
        { workspaceId: ctx.workspace.id, actorUserId: ctx.bob.id },
        byOther.messageId,
      ),
      "ACCESS_DENIED",
    );
    expect(
      (await ctx.db.actionCard.findUniqueOrThrow({ where: { messageId: byOther.messageId } }))
        .state,
    ).toBe("pending");

    // A second cancel on an already-cancelled card is CONFLICT.
    await expectAppErrorCode(
      ctx.actionCards.cancel(
        { workspaceId: ctx.workspace.id, actorUserId: ctx.dave.id },
        byAdmin.messageId,
      ),
      "CONFLICT",
    );
  } finally {
    await ctx.cleanup();
  }
});
