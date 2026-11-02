import { expect, test } from "bun:test";
import { ActionCardError } from "#src/server/conversations/action-cards.server";
import { AppError, isAppError } from "#src/lib/app-error";
import { expectActionCardError, setupActionCards } from "./helpers/action-cards-fixture";

/**
 * Exercises `ActionCards.prepare` (see `apps/web/src/server/conversations/action-cards.server.ts`)
 * against local PostgreSQL: handle resolution for all three action-card kinds,
 * target-grammar reuse from Agent `message send`, and the conflict/validation error shapes the
 * HTTP route (`apps/web/src/routes/api/agent/v1/actions/prepare.ts`) maps to 422/403/409.
 */

test("prepare persists channel:create with handles resolved to UUIDs and a readable summary", async () => {
  const ctx = await setupActionCards();
  try {
    const name = `design-${ctx.suffix}`;
    const result = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: {
        type: "channel:create",
        name,
        initialHumans: [`@${ctx.alice.username}`, ctx.bob.username],
        initialAgents: [ctx.agent.id],
        draftHint: "onboarding needs a dedicated space",
      },
    });
    expect(result.metadata).toEqual({ kind: "action-card" });

    const message = await ctx.db.message.findUniqueOrThrow({ where: { id: result.messageId } });
    expect(message.conversationId).toBe(ctx.hub.id);
    expect(message.body).toBe(
      `Action card: create channel #${name}\nonboarding needs a dedicated space`,
    );
    expect(message.sequence).toBeGreaterThan(0);

    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: result.messageId },
    });
    expect(card.kind).toBe("channel:create");
    expect(card.state).toBe("pending");
    expect(card.preparedByAgentId).toBe(ctx.agent.id);
    expect(card.payload).toEqual({
      type: "channel:create",
      name,
      visibility: "public",
      initialHumanIds: [ctx.alice.id, ctx.bob.id],
      initialAgentIds: [ctx.agent.id],
    });

    // One publication, carrying the Workspace the browser scopes the signal to. The event is
    // additive: it may grow further fields, so pin the meaningful ones and the count.
    expect(ctx.realtimeEvents).toEqual([
      expect.objectContaining({
        conversationId: ctx.hub.id,
        messageId: result.messageId,
        sequence: message.sequence,
        workspaceId: ctx.hub.workspaceId,
      }),
    ]);
  } finally {
    await ctx.cleanup();
  }
});

test("prepare persists agent:create resolving suggestedComputer by bare name", async () => {
  const ctx = await setupActionCards();
  try {
    const result = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: {
        type: "agent:create",
        name: `newbot-${ctx.suffix}`,
        description: "handles onboarding",
        suggestedComputer: ctx.computer.name,
      },
    });
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: result.messageId },
    });
    expect(card.kind).toBe("agent:create");
    expect(card.payload).toEqual({
      type: "agent:create",
      name: `newbot-${ctx.suffix}`,
      description: "handles onboarding",
      suggestedComputerId: ctx.computer.id,
    });
    const message = await ctx.db.message.findUniqueOrThrow({ where: { id: result.messageId } });
    expect(message.body).toBe(`Action card: create agent newbot-${ctx.suffix}`);
  } finally {
    await ctx.cleanup();
  }
});

test("prepare persists channel:add_member resolving the channel by bare name and members by handle/UUID", async () => {
  const ctx = await setupActionCards();
  try {
    const result = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: {
        type: "channel:add_member",
        channel: ctx.hub.channelName!,
        humans: [`@${ctx.bob.username}`],
        agents: [ctx.existingAgent.name],
      },
    });
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: result.messageId },
    });
    expect(card.payload).toEqual({
      type: "channel:add_member",
      channelId: ctx.hub.id,
      humanIds: [ctx.bob.id],
      agentIds: [ctx.existingAgent.id],
      // The names as the Agent wrote them, kept for the preview line only.
      channelHandle: ctx.hub.channelName,
      memberHandles: [`@${ctx.bob.username}`, `@${ctx.existingAgent.name}`],
    });
    const message = await ctx.db.message.findUniqueOrThrow({ where: { id: result.messageId } });
    expect(message.body).toBe(
      `Action card: add @${ctx.bob.username}, @${ctx.existingAgent.name} to #${ctx.hub.channelName}`,
    );
  } finally {
    await ctx.cleanup();
  }
});

test("prepare rejects an unknown handle with a field-scoped INVALID_HANDLE error", async () => {
  const ctx = await setupActionCards();
  try {
    await expectActionCardError(
      ctx.actionCards.prepare(ctx.principal, {
        target: `#${ctx.hub.channelName}`,
        action: {
          type: "channel:add_member",
          channel: ctx.hub.channelName!,
          humans: ["@does-not-exist"],
        },
      }),
      { code: "INVALID_HANDLE", field: "action.humans[0]" },
    );
  } finally {
    await ctx.cleanup();
  }
});

test("prepare resolves every handle kind by UUID as well as by name, and names the kind it could not find", async () => {
  const ctx = await setupActionCards();
  try {
    const added = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: {
        type: "channel:add_member",
        channel: ctx.hub.id,
        humans: [ctx.bob.id],
        agents: [ctx.existingAgent.id],
      },
    });
    expect(
      (await ctx.db.actionCard.findUniqueOrThrow({ where: { messageId: added.messageId } }))
        .payload,
    ).toEqual({
      type: "channel:add_member",
      channelId: ctx.hub.id,
      humanIds: [ctx.bob.id],
      agentIds: [ctx.existingAgent.id],
      channelHandle: ctx.hub.id,
      memberHandles: [`@${ctx.bob.id}`, `@${ctx.existingAgent.id}`],
    });
    const placed = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: {
        type: "agent:create",
        name: `uuidbot-${ctx.suffix}`,
        description: "placed by id",
        requiredComputer: ctx.computer.id,
      },
    });
    expect(
      (await ctx.db.actionCard.findUniqueOrThrow({ where: { messageId: placed.messageId } }))
        .payload,
    ).toMatchObject({ requiredComputerId: ctx.computer.id });

    const missingChannel = crypto.randomUUID();
    await expectActionCardError(
      ctx.actionCards.prepare(ctx.principal, {
        target: `#${ctx.hub.channelName}`,
        action: { type: "channel:add_member", channel: missingChannel, humans: [ctx.bob.id] },
      }),
      {
        code: "INVALID_HANDLE",
        field: "action.channel",
        message: `unknown channel handle: ${missingChannel}`,
      },
    );
    await expectActionCardError(
      ctx.actionCards.prepare(ctx.principal, {
        target: `#${ctx.hub.channelName}`,
        action: {
          type: "channel:add_member",
          channel: ctx.hub.channelName!,
          agents: ["@no-such-agent"],
        },
      }),
      {
        code: "INVALID_HANDLE",
        field: "action.agents[0]",
        message: "unknown agent handle: @no-such-agent",
      },
    );
    await expectActionCardError(
      ctx.actionCards.prepare(ctx.principal, {
        target: `#${ctx.hub.channelName}`,
        action: {
          type: "agent:create",
          name: `nowhere-${ctx.suffix}`,
          description: "no such machine",
          requiredComputer: "no-such-computer",
        },
      }),
      {
        code: "INVALID_HANDLE",
        field: "action.requiredComputer",
        message: "unknown computer handle: no-such-computer",
      },
    );
  } finally {
    await ctx.cleanup();
  }
});

test("prepare answers a private Agent as channel management does: not visible, or private", async () => {
  const ctx = await setupActionCards();
  try {
    await ctx.db.agent.update({ where: { id: ctx.bobsAgent.id }, data: { visibility: "private" } });
    const handle = `@${ctx.bobsAgent.name}`;
    const refusalFor = (principal: { workspaceId: string; agentId: string }) =>
      ctx.actionCards
        .prepare(principal, {
          target: `#${ctx.hub.channelName}`,
          action: { type: "channel:add_member", channel: ctx.hub.channelName!, agents: [handle] },
        })
        .then(
          () => undefined,
          (error: ActionCardError) => ({
            status: error.status,
            code: error.code,
            field: error.field,
            message: error.message,
          }),
        );

    // Alice's Agent cannot see Bob's private Agent: the answer channel management gives.
    expect(await refusalFor(ctx.principal)).toEqual({
      status: 404,
      code: "AGENT_NOT_VISIBLE",
      field: "action.agents[0]",
      message: `${handle} is not visible to you.`,
    });
    // An Agent of the same creator can see it, and learns why it cannot be a member.
    expect(await refusalFor({ workspaceId: ctx.workspace.id, agentId: ctx.bobsAgent.id })).toEqual({
      status: 422,
      code: "INVALID_HANDLE",
      field: "action.agents[0]",
      message: `${handle} is private and cannot be a channel member`,
    });
  } finally {
    await ctx.cleanup();
  }
});

test("prepare rejects channel:create for an existing name, including the reserved general channel", async () => {
  const ctx = await setupActionCards();
  try {
    await expectActionCardError(
      ctx.actionCards.prepare(ctx.principal, {
        target: `#${ctx.hub.channelName}`,
        action: { type: "channel:create", name: ctx.hub.channelName! },
      }),
      { code: "CHANNEL_EXISTS" },
    );

    await expectActionCardError(
      ctx.actionCards.prepare(ctx.principal, {
        target: `#${ctx.hub.channelName}`,
        action: { type: "channel:create", name: "general" },
      }),
      { code: "CHANNEL_EXISTS" },
    );
  } finally {
    await ctx.cleanup();
  }
});

test("prepare rejects agent:create for an already-taken Agent name", async () => {
  const ctx = await setupActionCards();
  try {
    await expectActionCardError(
      ctx.actionCards.prepare(ctx.principal, {
        target: `#${ctx.hub.channelName}`,
        action: { type: "agent:create", name: ctx.existingAgent.name },
      }),
      { code: "AGENT_EXISTS" },
    );
  } finally {
    await ctx.cleanup();
  }
});

test("prepare accepts agent:create for a deleted Agent's name", async () => {
  const ctx = await setupActionCards();
  try {
    await ctx.db.agent.update({
      where: { id: ctx.existingAgent.id },
      data: { deletedAt: new Date() },
    });
    const result = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: { type: "agent:create", name: ctx.existingAgent.name, description: "" },
    });
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: result.messageId },
    });
    expect(card.payload).toMatchObject({ type: "agent:create", name: ctx.existingAgent.name });
  } finally {
    await ctx.cleanup();
  }
});

test("prepare denies an Agent that is not a member of the target channel", async () => {
  const ctx = await setupActionCards();
  try {
    let caught: unknown;
    try {
      await ctx.actionCards.prepare(ctx.principal, {
        target: `#${ctx.outsider.channelName}`,
        action: { type: "channel:create", name: `nope-${ctx.suffix}` },
      });
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    expect((caught as AppError).code).toBe("ACCESS_DENIED");
  } finally {
    await ctx.cleanup();
  }
});

test("prepare posts into a thread when the target names a root message", async () => {
  const ctx = await setupActionCards();
  try {
    const root = await ctx.db.message.create({
      data: {
        conversationId: ctx.hub.id,
        workspaceId: ctx.workspace.id,
        senderMemberId: ctx.hub.members.find((member) => member.userId === ctx.alice.id)!.id,
        sequence: 1,
        body: "Let's plan this",
      },
    });
    const anchor = root.id.slice(0, 8);
    const result = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}:${anchor}`,
      action: { type: "channel:create", name: `planned-${ctx.suffix}` },
    });
    const message = await ctx.db.message.findUniqueOrThrow({ where: { id: result.messageId } });
    expect(message.threadRootId).toBe(root.id);
    expect(message.conversationId).toBe(ctx.hub.id);
  } finally {
    await ctx.cleanup();
  }
});

test("prepare rejects a thread target whose anchor is not eight hex characters or a full id", async () => {
  const ctx = await setupActionCards();
  try {
    const root = await ctx.db.message.create({
      data: {
        conversationId: ctx.hub.id,
        workspaceId: ctx.workspace.id,
        senderMemberId: ctx.hub.members.find((member) => member.userId === ctx.alice.id)!.id,
        sequence: 1,
        body: "Let's plan this",
      },
    });
    // Each prefix names only this root, and is still not a thread target: the target grammar is
    // `#name:<8 hex>` or `#name:<uuid>`, as for `message send`.
    for (const anchor of [root.id.slice(0, 3), root.id.slice(0, 7), "abc", "not-hex"]) {
      let caught: unknown;
      try {
        await ctx.actionCards.prepare(ctx.principal, {
          target: `#${ctx.hub.channelName}:${anchor}`,
          action: { type: "channel:create", name: `short-${ctx.suffix}` },
        });
      } catch (error) {
        caught = error;
      }
      expect(isAppError(caught)).toBe(true);
      expect((caught as AppError).code).toBe("INVALID_INPUT");
    }
    expect(
      await ctx.db.actionCard.count({ where: { message: { conversationId: ctx.hub.id } } }),
    ).toBe(0);
  } finally {
    await ctx.cleanup();
  }
});
