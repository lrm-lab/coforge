import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  choiceActionCardView,
  commitChoiceCard,
  resolveChoicePayload,
} from "#src/server/conversations/action-card-choice.server";
import { waitingChoiceCards } from "#src/server/conversations/waiting-choice-cards.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);

let workspaceId: string;
let userId: string;
let outsiderId: string;
let outsiderHandle: string;
let agentId: string;
let conversationId: string;
let messageId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `choice-${suffix}`, displayName: "Choice" },
  });
  userId = user.id;
  // A person of the Workspace who is not in the conversation the card is posted in.
  const outsider = await db.user.create({
    data: { username: `choice-out-${suffix}`, displayName: "Outsider" },
  });
  outsiderId = outsider.id;
  outsiderHandle = outsider.username;
  const workspace = await db.workspace.create({
    data: {
      slug: `choice-${suffix}`,
      name: "Choice",
      members: {
        create: [{ userId, role: "member" }, { userId: outsider.id }],
      },
    },
  });
  workspaceId = workspace.id;
  const computer = await db.computer.create({
    data: { ownerId: userId, machineId: `choice-machine-${suffix}` },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId: userId,
      name: `choice-agent-${suffix}`,
      displayName: "Choice Agent",
      runtimeConfig: {},
      computerId: computer.id,
    },
  });
  agentId = agent.id;
  const conversation = await db.conversation.create({
    data: { workspaceId, channelName: `choice-${suffix}`, visibility: "public" },
  });
  conversationId = conversation.id;
  await db.conversationMember.create({ data: { workspaceId, conversationId, userId } });
  const agentMember = await db.conversationMember.create({
    data: { workspaceId, conversationId, agentId },
  });
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId,
      sequence: 1,
      senderMemberId: agentMember.id,
      body: "Which color?",
    },
  });
  messageId = message.id;
  await db.actionCard.create({
    data: {
      messageId,
      conversationId,
      workspaceId,
      kind: "choice",
      payload: {
        type: "choice",
        prompt: "Which color?",
        options: [
          { id: "a", label: "Red" },
          { id: "b", label: "Blue" },
        ],
        to: userId,
      },
      preparedByAgentId: agentId,
    },
  });
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  await db.user.delete({ where: { id: outsiderId } }).catch(() => undefined);
  await db.$disconnect();
});

test("choosing an option wakes the asking Agent with the choice, and posts no message", async () => {
  const published: unknown[] = [];
  const publisher = {
    publishBatch: async (publications: unknown[]) => {
      published.push(...publications);
      return new Map(publications.map((_, index) => [String(index), { status: "sent" }]));
    },
  };
  const result = await commitChoiceCard(
    db,
    undefined,
    { workspaceId, actorUserId: userId },
    { messageId, optionId: "a" },
    { publisher: publisher as never },
  );
  expect(result).toEqual({ optionId: "a", label: "Red" });
  const card = await db.actionCard.findUniqueOrThrow({ where: { messageId } });
  expect(card.state).toBe("executed");
  expect(card.result).toEqual({ optionId: "a", label: "Red" });
  const delivery = await db.agentMessageDelivery.findUniqueOrThrow({
    where: { messageId_agentId: { messageId, agentId } },
  });
  expect(delivery.reason).toBe("choice");
  expect(published).toHaveLength(1);
  const encoded = (published[0] as { data: Record<string, number> }).data;
  const decoded = new TextDecoder().decode(Uint8Array.from(Object.values(encoded)));
  const answer = `@choice-${suffix} answered your choice "Which color?" in #choice-${suffix}: a · Red`;
  expect(decoded).toContain(answer);
  const messages = await db.message.count({ where: { conversationId } });
  expect(messages).toBe(1);
  // The Agent was offline: the recovery replay carries the answer, not its own question, and
  // reads exactly as the live push did.
  const pending = await new PrismaDirectConversationRepository(db).readPendingAgentDeliveries(
    workspaceId,
    agentId,
  );
  const replay = pending.find((row) => row.messageId === messageId);
  expect(String(replay?.body)).toBe(answer);
});

test("a choice card names who is asked, and only they may choose", async () => {
  const action = {
    type: "choice" as const,
    prompt: "Which color?",
    options: [
      { id: "a", label: "Red" },
      { id: "b", label: "Blue" },
    ],
    to: `choice-${suffix}`,
  };
  const payload = await resolveChoicePayload(db, conversationId, action);
  expect(payload.to).toBe(userId);
  const base = { messageId, state: "pending" as const, canCommit: false, canCancel: false };
  const card = { result: null };
  const names = new Map([[userId, "Choice Person"]]);
  const view = choiceActionCardView(base, card, payload, userId, true, names);
  expect(view.canCommit).toBe(true);
  // The card names whom it asks, so everyone else sees whose choice it waits on.
  expect(view.kind === "choice" && view.asked).toEqual({
    displayName: "Choice Person",
    isViewer: true,
  });
  expect(choiceActionCardView(base, card, payload, "another-user", true, names).canCommit).toBe(
    false,
  );
  await expect(
    resolveChoicePayload(db, conversationId, { ...action, to: "not-a-member" }),
  ).rejects.toThrow();
  // A person who exists but is not in this conversation cannot be asked here.
  await expect(
    resolveChoicePayload(db, conversationId, { ...action, to: outsiderHandle }),
  ).rejects.toMatchObject({
    code: "INVALID_INPUT",
    errorId: "action_card_choice_to",
    hint: "the person to ask is not in this conversation",
  });
  // A choice always names one: a card without `to` is refused rather than sent to the owner.
  await expect(
    resolveChoicePayload(db, conversationId, { ...action, to: "" }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

test("the waiting list shows the cards this person may answer", async () => {
  const agentMember = await db.conversationMember.findFirstOrThrow({
    where: { conversationId, agentId },
  });
  const makeCard = async (sequence: number, extra: Record<string, unknown>) => {
    const message = await db.message.create({
      data: {
        workspaceId,
        conversationId,
        sequence,
        senderMemberId: agentMember.id,
        body: "Which?",
      },
    });
    await db.actionCard.create({
      data: {
        messageId: message.id,
        conversationId,
        workspaceId,
        kind: "choice",
        payload: {
          type: "choice",
          prompt: "Which?",
          options: [
            { id: "a", label: "Red" },
            { id: "b", label: "Blue" },
          ],
          ...extra,
        },
        preparedByAgentId: agentId,
      },
    });
    return message.id;
  };
  const mine = await makeCard(2, { to: userId });
  const other = await makeCard(3, { to: "someone-else" });
  // A card that names nobody (one made before `to` was required) is nobody's to answer.
  const noTo = await makeCard(4, {});
  const waiting = await waitingChoiceCards(db, workspaceId, userId);
  expect(waiting.map((card) => card.messageId)).toEqual([mine]);
  expect(waiting.some((card) => card.messageId === other || card.messageId === noTo)).toBe(false);
});
