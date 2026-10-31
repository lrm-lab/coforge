import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { agentPeerDirectKey, isPeopleDirectKey } from "#src/features/conversations/direct-key";
import { withPublishBatch } from "./helpers/fake-centrifugo";

// Agent-to-Agent direct conversations: addressing, permission, the wake, and a target that is
// always the other side's from the reader's seat. The person-and-Agent DM keeps its own tests.
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
const slug = `ap-${suffix}`;
const usernames = ["ada", "bob"].map((name) => `ap-${name}-${suffix}`);
const repository = new PrismaDirectConversationRepository(db);

const published: { channel: string; data: unknown }[] = [];
const sending = new SendDirectMessage(
  repository,
  { execute: (_scope, persist) => persist() } satisfies MessageRequestIdempotency,
  withPublishBatch({ publish: async (channel, data) => void published.push({ channel, data }) }),
);

let ada: { id: string };
let bob: { id: string };
let workspaceId: string;
let alpha: { id: string; name: string };
let beta: { id: string; name: string };
let gamma: { id: string; name: string };
let hush: { id: string; name: string };
let vault: { id: string; name: string };
let twin: { id: string; name: string };
let deleted: { id: string; name: string };
let computerId: string;

const send = (from: { id: string }, target: string, body: string) =>
  sending.executeFromAgent({
    idempotencyKey: crypto.randomUUID(),
    workspaceId,
    agentId: from.id,
    target,
    body,
  });

beforeAll(async () => {
  [ada, bob] = await Promise.all(
    usernames.map((username) => db.user.create({ data: { displayName: username, username } })),
  );
  const workspace = await db.workspace.create({
    data: { slug, name: "Peers", members: { create: [{ userId: ada.id }, { userId: bob.id }] } },
  });
  workspaceId = workspace.id;
  computerId = (await db.computer.create({ data: { ownerId: ada.id, machineId: slug } })).id;
  const agent = (name: string, ownerId: string, extra: object = {}) =>
    db.agent.create({
      data: {
        workspaceId,
        ownerId,
        name: `${name}-${suffix}`,
        displayName: name,
        runtimeConfig: {},
        ...extra,
      },
      select: { id: true, name: true },
    });
  alpha = await agent("alpha", ada.id, { computerId });
  beta = await agent("beta", ada.id, { computerId });
  gamma = await agent("gamma", bob.id);
  hush = await agent("hush", ada.id, { visibility: "private" });
  vault = await agent("vault", bob.id, { visibility: "private" });
  // Shares its name with a member, so a bare @name cannot say which is meant.
  twin = await db.agent.create({
    data: {
      workspaceId,
      ownerId: ada.id,
      name: usernames[1]!,
      displayName: "Twin",
      runtimeConfig: {},
    },
    select: { id: true, name: true },
  });
  deleted = await agent("gone", ada.id);
  await db.agent.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { slug } });
  await db.computer.deleteMany({ where: { machineId: slug } });
  await db.user.deleteMany({ where: { username: { in: usernames } } });
  await db.$disconnect();
});

test("a send to another Agent starts their conversation and wakes only that Agent", async () => {
  published.length = 0;
  const sent = await send(alpha, `@${beta.name}`, "can you look at this?");
  const conversation = await db.conversation.findFirstOrThrow({
    where: { workspaceId, directKey: agentPeerDirectKey(alpha.id, beta.id) },
    include: { members: true },
  });
  expect(isPeopleDirectKey(conversation.directKey!)).toBe(false);
  expect(conversation.members.map((m) => m.agentId).sort()).toEqual([alpha.id, beta.id].sort());
  expect(conversation.members.every((m) => m.userId === null)).toBe(true);

  const deliveries = await db.agentMessageDelivery.findMany({ where: { messageId: sent.id } });
  expect(deliveries.map((d) => d.agentId)).toEqual([beta.id]);
  // Pushed to the recipient's Computer, naming the sender as the target it replies to.
  expect(published).toHaveLength(1);
  const payload = new TextDecoder().decode(published[0]!.data as Uint8Array);
  expect(payload).toContain(`@${alpha.name}`);
  expect(payload).not.toContain(`@${beta.name}`);
});

test("each Agent sees the other's name as the target, in a read, a search and a delivery", async () => {
  await send(alpha, `@${beta.name}`, "second");
  const betaReads = await repository.readMessages(workspaceId, beta.id, `@${alpha.name}`);
  expect(betaReads.map((m) => m.target)).toEqual([`@${alpha.name}`, `@${alpha.name}`]);
  const alphaReads = await repository.readMessages(workspaceId, alpha.id, `@${beta.name}`);
  expect(alphaReads.map((m) => m.target)).toEqual([`@${beta.name}`, `@${beta.name}`]);

  const found = await repository.searchMessages(workspaceId, beta.id, { query: "second" });
  expect(found.messages.map((m) => m.target)).toEqual([`@${alpha.name}`]);
  const foundByAlpha = await repository.searchMessages(workspaceId, alpha.id, { query: "second" });
  expect(foundByAlpha.messages.map((m) => m.target)).toEqual([`@${beta.name}`]);

  const pending = await repository.readPendingAgentDeliveries(workspaceId, beta.id);
  expect(pending.map((d) => d.target)).toEqual([`@${alpha.name}`, `@${alpha.name}`]);
});

test("recovery and drain name the sender as the target to answer", async () => {
  await send(beta, `@${alpha.name}`, "on it");
  const recovery = await repository.readAgentRecoveryContext(workspaceId, alpha.id);
  expect(Object.keys(recovery.unreadSummary)).toEqual([`@${beta.name}`]);
  const drained = await repository.drainAgentEvents(workspaceId, alpha.id);
  expect(drained.messages.map((m) => m.target)).toEqual([`@${beta.name}`]);
});

test("a person is no member of it, so no person's list, unread or search shows it", async () => {
  const conversations = new DirectConversations(db);
  const key = agentPeerDirectKey(alpha.id, beta.id);
  const row = await db.conversation.findFirstOrThrow({ where: { workspaceId, directKey: key } });
  await expect(conversations.authorize(workspaceId, ada.id, row.id)).rejects.toThrow("NOT_FOUND");
  expect(await conversations.list(workspaceId, ada.id)).toEqual(
    expect.objectContaining({ conversations: expect.not.arrayContaining([row.id]) }),
  );
});

test("a bare name shared by a member and an Agent is ambiguous until a suffix picks one", async () => {
  await expect(send(alpha, `@${twin.name}`, "who?")).rejects.toThrow("AMBIGUOUS_TARGET");
  await expect(
    repository.resolveAgentTarget(workspaceId, alpha.id, `@${twin.name}`),
  ).rejects.toThrow("AMBIGUOUS_TARGET");
  await send(alpha, `@${twin.name}~agent`, "the agent");
  const toPerson = await repository.resolveAgentTarget(
    workspaceId,
    alpha.id,
    `@${usernames[1]}~human`,
  );
  const toAgent = await repository.resolveAgentTarget(workspaceId, alpha.id, `@${twin.name}~agent`);
  expect(toPerson.conversationId).not.toBe(toAgent.conversationId);
  // The reader's own name for the twin carries the suffix, so it can be answered as it came.
  const back = await repository.readMessages(workspaceId, twin.id, `@${alpha.name}`);
  expect(back.map((m) => m.target)).toEqual([`@${alpha.name}`]);
  const received = await repository.readPendingAgentDeliveries(workspaceId, twin.id);
  expect(received.map((d) => d.target)).toEqual([`@${alpha.name}`]);
  const seenByAlpha = await repository.readMessages(workspaceId, alpha.id, `@${twin.name}~agent`);
  expect(seenByAlpha.map((m) => m.target)).toEqual([`@${twin.name}~agent`]);
});

test("a private Agent can be messaged only by its creator's Agents or an Agent with a conversation", async () => {
  // Ada's own Agent reaches her private one; Bob's Agent cannot find it, as for a missing name.
  await send(alpha, `@${hush.name}`, "hello hush");
  await expect(send(gamma, `@${hush.name}`, "hello?")).rejects.toMatchObject({
    code: "TARGET_NOT_ACCESSIBLE",
  });
  await expect(send(alpha, `@${vault.name}`, "hello?")).rejects.toMatchObject({
    code: "TARGET_NOT_ACCESSIBLE",
  });
});

test("visibility gates starting a conversation, and being in one lets an Agent keep answering", async () => {
  // Hush changes hands: Bob's now, and private, so Alpha (Ada's) could no longer start with it.
  await db.agent.update({ where: { id: hush.id }, data: { ownerId: bob.id } });
  await expect(send(beta, `@${hush.name}`, "new here")).rejects.toMatchObject({
    code: "TARGET_NOT_ACCESSIBLE",
  });
  // Alpha already has a conversation with it, so both sides still send.
  await send(alpha, `@${hush.name}`, "still talking");
  await send(hush, `@${alpha.name}`, "and answering");
  await db.agent.update({ where: { id: hush.id }, data: { ownerId: ada.id } });
});

test("an Agent cannot message itself, a deleted Agent, or a name that is nobody", async () => {
  await expect(send(alpha, `@${alpha.name}`, "me")).rejects.toMatchObject({
    code: "TARGET_NOT_ACCESSIBLE",
  });
  await expect(send(alpha, `@${deleted.name}`, "hello")).rejects.toMatchObject({
    code: "TARGET_NOT_ACCESSIBLE",
  });
  await expect(send(alpha, "@no-such-name", "hello")).rejects.toMatchObject({
    code: "TARGET_NOT_ACCESSIBLE",
  });
});

test("a peer with no Computer still gets the delivery row, to read when it starts", async () => {
  const sent = await send(alpha, `@${gamma.name}`, "wake up later");
  const rows = await db.agentMessageDelivery.findMany({ where: { messageId: sent.id } });
  expect(rows.map((d) => d.agentId)).toEqual([gamma.id]);
});

test("a person who shares a name with an Agent is shown to the Agent as ~human, in every place", async () => {
  // Twin holds Bob's username, so a bare @bob would be ambiguous for any ordinary Agent.
  const { conversationId, senderMemberId } = await repository.memberForUser(
    workspaceId,
    bob.id,
    alpha.id,
  );
  const sent = await repository.sendMessage(conversationId, senderMemberId, bob.id, "hi alpha");
  expect(sent.deliveryTarget).toBe(`@${usernames[1]}~human`);

  const bobRef = `@${usernames[1]}~human`;
  const pending = await repository.readPendingAgentDeliveries(workspaceId, alpha.id);
  expect(pending.filter((d) => d.messageId === sent.id).map((d) => d.target)).toEqual([bobRef]);
  const recovery = await repository.readAgentRecoveryContext(workspaceId, alpha.id);
  expect(Object.keys(recovery.unreadSummary)).toContain(bobRef);
  // Reading advances the position, so it comes after the recovery that counts the unread.
  const read = await repository.readMessages(workspaceId, alpha.id, bobRef);
  expect(read.map((m) => m.target)).toEqual([bobRef]);
});

test("an Agent the reader cannot see neither blocks the bare name nor shows that it exists", async () => {
  // A private Agent of Bob's holds Ada's username; Alpha (Ada's) cannot see it.
  await db.agent.create({
    data: {
      workspaceId,
      ownerId: bob.id,
      name: usernames[0]!,
      displayName: "Hidden twin",
      visibility: "private",
      runtimeConfig: {},
    },
  });
  const { conversationId, senderMemberId } = await repository.memberForUser(
    workspaceId,
    ada.id,
    alpha.id,
  );
  const sent = await repository.sendMessage(conversationId, senderMemberId, ada.id, "hi again");
  expect(sent.deliveryTarget).toBe(`@${usernames[0]}`);
  await send(alpha, `@${usernames[0]}`, "bare name still reaches the person");
});
