import { test, expect } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import { ActionCards } from "#src/server/conversations/action-cards.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

/**
 * A choice card from a Computer whose CLI predates `to`: that CLI's schema has no such field and
 * zod strips it, so the server asks the preparing Agent's owner as before. Remove with the
 * fallback (task #407).
 */

async function setup() {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `legacy-owner-${suffix}`, username: `legacy-owner-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `legacy-choice-${suffix}`,
      name: "Legacy choice",
      members: { create: [{ userId: owner.id, role: "owner" }] },
      agents: {
        create: {
          name: `legacy-agent-${suffix}`,
          displayName: "Legacy Agent",
          ownerId: owner.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  const agent = workspace.agents[0]!;
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `legacy-hub-${suffix}`,
      members: { create: [{ userId: owner.id }, { agentId: agent.id }] },
    },
  });
  const actionCards = new ActionCards(db, new PrismaDirectConversationRepository(db));
  return {
    db,
    suffix,
    owner,
    workspace,
    agent,
    channel,
    actionCards,
    principal: { workspaceId: workspace.id, agentId: agent.id },
    async cleanup() {
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.user.delete({ where: { id: owner.id } });
      await db.$disconnect();
    },
  };
}

const choice = {
  type: "choice" as const,
  prompt: "Which color?",
  options: [
    { id: "a", label: "Red" },
    { id: "b", label: "Blue" },
  ],
};

test("a choice without `to` asks the preparing Agent's owner and says to upgrade", async () => {
  const ctx = await setup();
  try {
    const result = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.channel.channelName}`,
      action: choice,
    });
    expect(result.warning).toContain("upgrade");
    const message = await ctx.db.message.findUniqueOrThrow({ where: { id: result.messageId } });
    // The upgrade note stays out of the body, which people see in previews and search.
    expect(message.body).not.toContain("out of date");
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: result.messageId },
    });
    expect(card.payload).toMatchObject({ type: "choice", to: ctx.owner.id });
  } finally {
    await ctx.cleanup();
  }
});

test("a choice without `to` is refused when the owner cannot read the target", async () => {
  const ctx = await setup();
  try {
    // The Agent may post here but its owner is not a member: a card asking the owner could never
    // be committed, so it is refused rather than left dead.
    const secret = await ctx.db.conversation.create({
      data: {
        workspaceId: ctx.workspace.id,
        channelName: `legacy-secret-${ctx.suffix}`,
        visibility: "private",
        members: { create: [{ agentId: ctx.agent.id }] },
      },
    });
    const refused = await ctx.actionCards
      .prepare(ctx.principal, { target: `#${secret.channelName}`, action: choice })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(isAppError(refused)).toBe(true);
    expect(refused).toMatchObject({ code: "INVALID_INPUT" });
    expect((refused as AppError).hint).toContain("not in this conversation");
  } finally {
    await ctx.cleanup();
  }
});
