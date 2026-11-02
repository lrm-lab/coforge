import { expect } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { ActionCards, ActionCardError } from "#src/server/conversations/action-cards.server";
import type { ActionCardErrorCode } from "#src/server/conversations/action-card-error.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { AppError, isAppError, type AppErrorCode } from "#src/lib/app-error";

/**
 * A Workspace for `ActionCards` against local PostgreSQL (`action-cards.integration.ts`): three
 * people, two Agents and a taken Agent name, a Computer, a channel the preparing Agent is in and
 * one it is not, and the `ActionCards` that prepares into them.
 */
export async function setupActionCards() {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `ac-alice-${suffix}`, username: `ac-alice-${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `ac-bob-${suffix}`, username: `ac-bob-${suffix}` },
  });
  const dave = await db.user.create({
    data: { displayName: `ac-dave-${suffix}`, username: `ac-dave-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `ac-${suffix}`,
      name: "Action Cards",
      members: {
        create: [
          { userId: alice.id, role: "owner" },
          { userId: bob.id, role: "member" },
          { userId: dave.id, role: "admin" },
        ],
      },
      agents: {
        create: [
          {
            name: `scout-${suffix}`,
            displayName: "Scout",
            ownerId: alice.id,
            runtimeConfig: {},
          },
          {
            name: `helper-${suffix}`,
            displayName: "Helper",
            ownerId: bob.id,
            runtimeConfig: {},
          },
        ],
      },
    },
    include: { agents: true },
  });
  const agent = workspace.agents.find((a) => a.name === `scout-${suffix}`)!;
  const bobsAgent = workspace.agents.find((a) => a.name === `helper-${suffix}`)!;
  const existingAgent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      name: `existing-${suffix}`,
      displayName: "Existing",
      ownerId: alice.id,
      runtimeConfig: {},
    },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: alice.id,
      machineId: crypto.randomUUID(),
      name: `box-${suffix}`,
      displayName: "Box",
    },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });

  const hub = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `hub-${suffix}`,
      members: {
        create: [{ userId: alice.id }, { agentId: agent.id }, { agentId: bobsAgent.id }],
      },
    },
    include: { members: true },
  });
  const outsider = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `out-${suffix}`,
      members: { create: [{ userId: alice.id }] },
    },
  });

  const realtimeEvents: Array<{ conversationId: string; messageId: string; sequence: number }> = [];
  const actionCards = new ActionCards(db, new PrismaDirectConversationRepository(db), {
    async memberChanged() {},
    async messageAvailable(event) {
      realtimeEvents.push(event);
    },
  });
  const principal = { workspaceId: workspace.id, agentId: agent.id };

  async function cleanup() {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.delete({ where: { id: computer.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id, dave.id] } } });
    await db.$disconnect();
  }

  return {
    db,
    suffix,
    alice,
    bob,
    dave,
    agent,
    bobsAgent,
    existingAgent,
    computer,
    workspace,
    hub,
    outsider,
    actionCards,
    principal,
    realtimeEvents,
    cleanup,
  };
}

/** Fails unless `promise` rejects with an `ActionCardError` of `expected`. */
export async function expectActionCardError(
  promise: Promise<unknown>,
  expected: { code: ActionCardErrorCode; field?: string; message?: string },
) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ActionCardError);
  const error = caught as ActionCardError;
  expect(error.code).toBe(expected.code);
  if (expected.field !== undefined) expect(error.field).toBe(expected.field);
  if (expected.message !== undefined) expect(error.message).toBe(expected.message);
}

/** Fails unless `promise` rejects with an `AppError` of `code`. */
export async function expectAppErrorCode(promise: Promise<unknown>, code: AppErrorCode) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(isAppError(caught)).toBe(true);
  expect((caught as AppError).code).toBe(code);
}
