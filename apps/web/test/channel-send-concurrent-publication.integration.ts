import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";

const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);

let workspaceId: string;
let userId: string;
let channelId: string;
let agentName: string;

beforeAll(async () => {
  const user = await db.user.create({ data: { username: `cc-${suffix}`, displayName: "CC" } });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: { slug: `cc-${suffix}`, name: "CC", members: { create: { userId, role: "member" } } },
  });
  workspaceId = workspace.id;
  const computer = await db.computer.create({
    data: { ownerId: userId, machineId: `cc-machine-${suffix}` },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId: userId,
      name: `cc-agent-${suffix}`,
      displayName: "CC Agent",
      runtimeConfig: {},
      computerId: computer.id,
    },
  });
  agentName = agent.name;
  const channel = await db.conversation.create({
    data: { workspaceId, channelName: `cc-${suffix}`, visibility: "public" },
  });
  channelId = channel.id;
  await db.conversationMember.create({ data: { workspaceId, conversationId: channelId, userId } });
  await db.conversationMember.create({
    data: { workspaceId, conversationId: channelId, agentId: agent.id },
  });
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  await db.$disconnect();
});

function probes(pushOutcome: "sent" | "rejected") {
  const state = { pushStarted: false, pushStartedDuringAnnouncement: false, announced: false };
  const publisher = {
    publishBatch: async (publications: unknown[]) => {
      state.pushStarted = true;
      return publications.map(() =>
        pushOutcome === "sent"
          ? { status: "fulfilled" as const, value: undefined }
          : { status: "rejected" as const, reason: new Error("push rejected") },
      );
    },
  };
  const realtime = {
    messageAvailable: async () => {
      for (let i = 0; i < 40 && !state.pushStarted; i++) await Bun.sleep(5);
      state.pushStartedDuringAnnouncement = state.pushStarted;
      state.announced = true;
    },
    conversationActivity: async () => {},
  };
  return { state, publisher, realtime };
}

const send = (channels: PublicChannels) =>
  channels.send({
    workspaceId,
    userId,
    channelId,
    idempotencyKey: crypto.randomUUID(),
    body: `ping @${agentName}`,
  });

test("a channel message reaches the mentioned Agent while the browser announcement is running", async () => {
  const probe = probes("sent");
  const channels = new PublicChannels(
    db,
    undefined,
    probe.publisher as never,
    undefined,
    probe.realtime as never,
  );
  const sent = await send(channels);
  expect(sent.deliveries).toHaveLength(1);
  expect(probe.state.pushStartedDuringAnnouncement).toBe(true);
  expect(probe.state.announced).toBe(true);
});

test("a rejected Agent push still fails the send, and the browser was told", async () => {
  const probe = probes("rejected");
  const channels = new PublicChannels(
    db,
    undefined,
    probe.publisher as never,
    undefined,
    probe.realtime as never,
  );
  await expect(send(channels)).rejects.toThrow("push rejected");
  expect(probe.state.announced).toBe(true);
});

test("a push that throws outright still waits for the announcement before failing the send", async () => {
  const probe = probes("sent");
  const throwing = {
    publishBatch: async () => {
      throw new Error("publisher down");
    },
  };
  const channels = new PublicChannels(
    db,
    undefined,
    throwing as never,
    undefined,
    probe.realtime as never,
  );
  await expect(send(channels)).rejects.toThrow("publisher down");
  expect(probe.state.announced).toBe(true);
});
