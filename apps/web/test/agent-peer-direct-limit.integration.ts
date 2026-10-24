import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { agentPeerDirectKey } from "#src/features/conversations/direct-key";
import {
  AGENT_DM_LIMITS,
  AGENT_DM_LIMIT_NOTICE,
} from "#src/server/conversations/agent-dm-limits.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

// The limits that stop two Agents answering each other without end: a chain budget per
// conversation with a quiet window, a per-Agent hourly budget, and a notice told once.
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
const slug = `apl-${suffix}`;
const username = `apl-ada-${suffix}`;
const sending = new SendDirectMessage(
  new PrismaDirectConversationRepository(db),
  { execute: (_scope, persist) => persist() } satisfies MessageRequestIdempotency,
  { publish: async () => {} },
);

let workspaceId: string;
const agents: Record<string, { id: string; name: string }> = {};

const send = (from: string, to: string, body: string) =>
  sending.executeFromAgent({
    idempotencyKey: crypto.randomUUID(),
    workspaceId,
    agentId: agents[from]!.id,
    target: `@${agents[to]!.name}`,
    body,
  });

const conversationOf = (a: string, b: string) =>
  db.conversation.findFirstOrThrow({
    where: { workspaceId, directKey: agentPeerDirectKey(agents[a]!.id, agents[b]!.id) },
  });

beforeAll(async () => {
  const user = await db.user.create({ data: { displayName: username, username } });
  workspaceId = (
    await db.workspace.create({
      data: { slug, name: "Limits", members: { create: [{ userId: user.id }] } },
    })
  ).id;
  for (const name of ["left", "right", "third", "fourth"])
    agents[name] = await db.agent.create({
      data: {
        workspaceId,
        ownerId: user.id,
        name: `${name}-${suffix}`,
        displayName: name,
        runtimeConfig: {},
      },
      select: { id: true, name: true },
    });
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { slug } });
  await db.user.deleteMany({ where: { username } });
  await db.$disconnect();
});

test("a chain of 20 messages is refused at the 21st, told once, and continues after quiet", async () => {
  for (let i = 0; i < AGENT_DM_LIMITS.chainMessages; i += 1)
    await (i % 2 === 0 ? send("left", "right", `m${i}`) : send("right", "left", `m${i}`));
  const conversation = await conversationOf("left", "right");

  await expect(send("left", "right", "one more")).rejects.toMatchObject({
    code: "AGENT_DM_CHAIN_LIMIT",
  });
  await expect(send("right", "left", "and another")).rejects.toMatchObject({
    code: "AGENT_DM_CHAIN_LIMIT",
  });

  // Nothing was stored for the refusals; the notice is one system message with no delivery.
  const stored = await db.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { sequence: "asc" },
    include: { deliveries: true },
  });
  expect(stored).toHaveLength(AGENT_DM_LIMITS.chainMessages + 1);
  const notice = stored.at(-1)!;
  expect([notice.senderMemberId, notice.body, notice.deliveries]).toEqual([
    null,
    AGENT_DM_LIMIT_NOTICE,
    [],
  ]);

  // Ten quiet minutes later the same conversation goes on.
  await db.message.updateMany({
    where: { conversationId: conversation.id },
    data: { createdAt: new Date(Date.now() - AGENT_DM_LIMITS.quietMs - 60_000) },
  });
  await send("left", "right", "back again");
});

test("one Agent's hourly budget across conversations is refused with the rate code", async () => {
  // 60 messages already sent to Fourth within the hour, long enough ago to be no chain.
  const conversation = await db.conversation.create({
    data: {
      workspaceId,
      directKey: agentPeerDirectKey(agents.third!.id, agents.fourth!.id),
    },
  });
  const [member] = await Promise.all(
    [agents.third!, agents.fourth!].map((agent) =>
      db.conversationMember.create({
        data: { conversationId: conversation.id, workspaceId, agentId: agent.id },
      }),
    ),
  );
  const sentAt = new Date(Date.now() - 30 * 60_000);
  await db.message.createMany({
    data: Array.from({ length: AGENT_DM_LIMITS.senderPerHour }, (_, i) => ({
      workspaceId,
      conversationId: conversation.id,
      senderMemberId: member!.id,
      sequence: i + 1,
      body: `earlier ${i}`,
      createdAt: sentAt,
    })),
  });

  await expect(send("third", "left", "a different peer")).rejects.toMatchObject({
    code: "AGENT_DM_RATE_LIMIT",
  });
  // Another Agent is not held by it.
  await send("right", "left", "unaffected");
});
