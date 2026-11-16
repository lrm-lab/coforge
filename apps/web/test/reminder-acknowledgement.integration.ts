import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  decodeReminderFireResponse,
  reminderAcknowledgementIdempotencyKey,
  type AgentReminderOperationRequest,
  type ReminderFireRequest,
} from "@lrm/coforge-sdk/internal";
import { PrismaReminderRepository } from "#src/server/db/repositories/reminder.repositories.server";
import { Reminders } from "#src/server/reminders/reminders.server";

const connectionString = Bun.env.REMINDER_TEST_DATABASE_URL;
if (!connectionString) throw new Error("REMINDER_TEST_DATABASE_URL is required");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = new PrismaReminderRepository(db);
let currentNow = new Date("2026-09-08T12:00:00.000Z");
let fixture: {
  userId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  messageId: string;
  target: string;
};
let reminders: Reminders;

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `ack_${suffix}`, username: `ack_${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `ack-${suffix}`,
      name: "Acknowledgement integration",
      members: { create: { userId: user.id } },
    },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: user.id,
      machineId: `ack-machine-${suffix}`,
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: user.id,
      computerId: computer.id,
      name: "ack-helper",
      displayName: "Ack Helper",
      runtimeConfig: {},
    },
  });
  const conversation = await db.conversation.create({
    data: {
      workspace: { connect: { id: workspace.id } },
      directKey: `${user.id}:${agent.id}`,
      members: {
        create: [
          { workspace: { connect: { id: workspace.id } }, user: { connect: { id: user.id } } },
          {
            workspace: { connect: { id: workspace.id } },
            agent: { connect: { id_workspaceId: { id: agent.id, workspaceId: workspace.id } } },
          },
        ],
      },
    },
  });
  const member = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: conversation.id, userId: user.id },
  });
  const message = await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      senderMemberId: member.id,
      sequence: 1,
      body: "ack",
    },
  });
  fixture = {
    userId: user.id,
    workspaceId: workspace.id,
    computerId: computer.id,
    agentId: agent.id,
    messageId: message.id,
    target: `@${user.username}`,
  };
  reminders = new Reminders(
    repository,
    { supports: async () => true },
    async () => {},
    () => currentNow,
  );
});

afterAll(async () => {
  if (fixture?.workspaceId) await db.workspace.delete({ where: { id: fixture.workspaceId } });
  if (fixture?.computerId) await db.computer.delete({ where: { id: fixture.computerId } });
  if (fixture?.userId) await db.user.delete({ where: { id: fixture.userId } });
  await db.$disconnect();
});

const schedule = (idempotencyKey: string, fireAt: string): AgentReminderOperationRequest => ({
  idempotencyKey,
  workspaceId: fixture.workspaceId,
  computerId: fixture.computerId,
  agentId: fixture.agentId,
  operation: "schedule",
  title: "Follow up",
  target: fixture.target,
  messageId: fixture.messageId,
  fireAt,
});

test("ack/dismiss are one idempotent event per fired revision", async () => {
  const created = (
    await reminders.execute(
      schedule("ack-create", new Date(currentNow.getTime() + 1_000).toISOString()),
      fixture.userId,
    )
  ).reminders[0]!;
  currentNow = new Date(currentNow.getTime() + 2_000);
  const fireRequest: ReminderFireRequest = {
    protocolMajor: 1,
    requestId: "ack-fire",
    workspaceId: fixture.workspaceId,
    computerId: fixture.computerId,
    agentId: fixture.agentId,
    reminderId: created.reminderId,
    version: created.version,
    firedAtClient: currentNow.toISOString(),
  };
  expect(decodeReminderFireResponse(await reminders.fire(fireRequest, fixture.userId)).result).toBe(
    "accepted",
  );
  const ack = {
    idempotencyKey: reminderAcknowledgementIdempotencyKey(
      "ack",
      created.reminderId,
      created.version,
    ),
    workspaceId: fixture.workspaceId,
    computerId: fixture.computerId,
    agentId: fixture.agentId,
    operation: "ack" as const,
    reminderId: created.reminderId,
    revision: created.version,
  };
  await reminders.execute(ack, fixture.userId);
  await reminders.execute(
    {
      ...ack,
      operation: "dismiss",
      idempotencyKey: reminderAcknowledgementIdempotencyKey(
        "dismiss",
        created.reminderId,
        created.version,
      ),
    },
    fixture.userId,
  );
  await reminders.execute(ack, fixture.userId);
  const events = await db.reminderEvent.findMany({
    where: { reminderId: created.reminderId, type: { in: ["acknowledged", "dismissed"] } },
  });
  expect(events).toHaveLength(1);
  await expect(
    reminders.execute({ ...ack, idempotencyKey: "unknown-revision", revision: 99 }, fixture.userId),
  ).rejects.toThrow("reminder revision was not fired");
  await db.reminder.delete({ where: { id: created.reminderId } });
});

test("a reminder is invisible through another workspace scope", async () => {
  expect(
    await repository.get(
      {
        workspaceId: crypto.randomUUID(),
        computerId: fixture.computerId,
        agentId: fixture.agentId,
        userId: fixture.userId,
      },
      crypto.randomUUID(),
    ),
  ).toBeUndefined();
});
