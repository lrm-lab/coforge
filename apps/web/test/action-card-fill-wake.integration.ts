import { afterAll, beforeAll, expect, test } from "bun:test";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { commitDesktopTakeoverCard } from "#src/server/conversations/action-card-desktop-takeover.server";
import { commitPageFillCard } from "#src/server/conversations/action-card-page-fill.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);

let workspaceId: string;
let userId: string;
let agentId: string;
let conversationId: string;
let fillMessageId: string;
let takeoverMessageId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `fill-${suffix}`, displayName: "Fill" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `fill-${suffix}`,
      name: "Fill",
      members: { create: [{ userId, role: "member" }] },
    },
  });
  workspaceId = workspace.id;
  const computer = await db.computer.create({
    data: { ownerId: userId, machineId: `fill-machine-${suffix}` },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId: userId,
      name: `fill-agent-${suffix}`,
      displayName: "Fill Agent",
      runtimeConfig: {},
      computerId: computer.id,
    },
  });
  agentId = agent.id;
  const conversation = await db.conversation.create({
    data: { workspaceId, channelName: `fill-${suffix}`, visibility: "public" },
  });
  conversationId = conversation.id;
  await db.conversationMember.create({ data: { workspaceId, conversationId, userId } });
  const agentMember = await db.conversationMember.create({
    data: { workspaceId, conversationId, agentId },
  });
  const fillMessage = await db.message.create({
    data: {
      workspaceId,
      conversationId,
      sequence: 1,
      senderMemberId: agentMember.id,
      body: "Sign in",
    },
  });
  fillMessageId = fillMessage.id;
  await db.actionCard.create({
    data: {
      messageId: fillMessageId,
      conversationId,
      workspaceId,
      kind: "page:fill",
      payload: {
        type: "page:fill",
        prompt: "Sign in",
        agentId,
        computerId: computer.id,
        fields: [
          { id: "username", label: "Username", input: "text" },
          { id: "password", label: "Password", input: "password" },
        ],
      },
      preparedByAgentId: agentId,
    },
  });
  const takeoverMessage = await db.message.create({
    data: {
      workspaceId,
      conversationId,
      sequence: 2,
      senderMemberId: agentMember.id,
      body: "Finish on desktop",
    },
  });
  takeoverMessageId = takeoverMessage.id;
  await db.actionCard.create({
    data: {
      messageId: takeoverMessageId,
      conversationId,
      workspaceId,
      kind: "desktop:takeover",
      payload: {
        type: "desktop:takeover",
        prompt: "Finish GitHub sign-in",
        agentId,
        computerId: computer.id,
        agentName: "Fill Agent",
      },
      preparedByAgentId: agentId,
    },
  });
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  await db.$disconnect();
});

function publisherCapture() {
  const published: unknown[] = [];
  return {
    published,
    publisher: {
      publishBatch: async (publications: unknown[]) => {
        published.push(...publications);
        return new Map(publications.map((_, index) => [String(index), { status: "sent" }]));
      },
    },
  };
}

test("page:fill commit wakes the asking Agent with which fields were filled", async () => {
  const { published, publisher } = publisherCapture();
  const previous = Bun.env.COFORGE_CLOUD_DESKTOP_ORIGIN;
  Bun.env.COFORGE_CLOUD_DESKTOP_ORIGIN = "https://desktop.test";
  try {
    const result = await commitPageFillCard(
      db,
      undefined,
      { workspaceId, actorUserId: userId },
      {
        messageId: fillMessageId,
        values: { username: "alice", password: "secret" },
        cookie: "",
      },
      {
        publisher: publisher as never,
        fillPage: async () => ({ filled: ["username", "password"] }),
      },
    );
    expect(result).toEqual({ filled: ["username", "password"] });
  } finally {
    if (previous === undefined) delete Bun.env.COFORGE_CLOUD_DESKTOP_ORIGIN;
    else Bun.env.COFORGE_CLOUD_DESKTOP_ORIGIN = previous;
  }
  const card = await db.actionCard.findUniqueOrThrow({ where: { messageId: fillMessageId } });
  expect(card.state).toBe("executed");
  expect(card.result).toEqual({ filled: ["username", "password"] });
  const delivery = await db.agentMessageDelivery.findUniqueOrThrow({
    where: { messageId_agentId: { messageId: fillMessageId, agentId } },
  });
  expect(delivery.reason).toBe("choice");
  expect(published).toHaveLength(1);
  const answer = `@fill-${suffix} completed your action card "Sign in" in #fill-${suffix}: filled username, password`;
  expect(decodeAgentMessageDelivery((published[0] as { data: Uint8Array }).data).reason).toBe(
    "choice",
  );
  const pending = await new PrismaDirectConversationRepository(db).readPendingAgentDeliveries(
    workspaceId,
    agentId,
  );
  expect(String(pending.find((row) => row.messageId === fillMessageId)?.body)).toBe(answer);
});

test("desktop:takeover commit wakes the asking Agent that the step is done", async () => {
  const { published, publisher } = publisherCapture();
  const result = await commitDesktopTakeoverCard(
    db,
    undefined,
    { workspaceId, actorUserId: userId },
    takeoverMessageId,
    { publisher: publisher as never },
  );
  expect(result).toEqual({ done: true });
  const card = await db.actionCard.findUniqueOrThrow({
    where: { messageId: takeoverMessageId },
  });
  expect(card.state).toBe("executed");
  const delivery = await db.agentMessageDelivery.findUniqueOrThrow({
    where: { messageId_agentId: { messageId: takeoverMessageId, agentId } },
  });
  expect(delivery.reason).toBe("choice");
  expect(published).toHaveLength(1);
  const answer = `@fill-${suffix} completed your action card "Finish GitHub sign-in" in #fill-${suffix}.`;
  expect(decodeAgentMessageDelivery((published[0] as { data: Uint8Array }).data).reason).toBe(
    "choice",
  );
  const pending = await new PrismaDirectConversationRepository(db).readPendingAgentDeliveries(
    workspaceId,
    agentId,
  );
  expect(String(pending.find((row) => row.messageId === takeoverMessageId)?.body)).toBe(answer);
});
