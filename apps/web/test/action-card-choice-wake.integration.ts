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
  const changed: unknown[] = [];
  const realtime = {
    messageAvailable: async () => undefined,
    activityChanged: async (input: unknown) => void changed.push(input),
  };
  const result = await commitChoiceCard(
    db,
    realtime as never,
    { workspaceId, actorUserId: userId },
    { messageId, optionId: "a" },
    { publisher: publisher as never },
  );
  expect(result).toEqual({ optionId: "a", label: "Red" });
  const card = await db.actionCard.findUniqueOrThrow({ where: { messageId } });
  expect(card.state).toBe("executed");
  expect(card.result).toEqual({ optionId: "a", label: "Red" });
  // The asked person's Activity hears the card leave their "Waiting on you" list.
  expect(changed).toEqual([{ workspaceId, userId }]);
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

test("the person's own answer commits the card, and the Agent hears it fenced", async () => {
  const agentMember = await db.conversationMember.findFirstOrThrow({
    where: { conversationId, agentId },
  });
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId,
      sequence: 10,
      senderMemberId: agentMember.id,
      body: "Which color?",
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
        prompt: "Which color?",
        options: [
          { id: "a", label: "Red" },
          { id: "b", label: "Blue" },
        ],
        to: userId,
        other: {},
      },
      preparedByAgentId: agentId,
    },
  });
  // Blank text is not an answer; the card stays pending for the real one.
  await expect(
    commitChoiceCard(
      db,
      undefined,
      { workspaceId, actorUserId: userId },
      {
        messageId: message.id,
        optionId: "_other",
        text: "   ",
      },
    ),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
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
    { messageId: message.id, optionId: "_other", text: "  Blue with\nstripes  " },
    { publisher: publisher as never },
  );
  expect(result).toEqual({ optionId: "_other", label: "Other", text: "Blue with\nstripes" });
  const card = await db.actionCard.findUniqueOrThrow({ where: { messageId: message.id } });
  expect(card.result).toEqual(result);
  const answer = `@choice-${suffix} answered your choice "Which color?" in #choice-${suffix}: Other (their own words)\n  │ Blue with\n  │ stripes`;
  const decoded = new TextDecoder().decode(
    Uint8Array.from(Object.values((published[0] as { data: Record<string, number> }).data)),
  );
  expect(decoded).toContain(answer);
  const pending = await new PrismaDirectConversationRepository(db).readPendingAgentDeliveries(
    workspaceId,
    agentId,
  );
  expect(String(pending.find((row) => row.messageId === message.id)?.body)).toBe(answer);
});

test("a card that turns the other row off refuses an own answer", async () => {
  const agentMember = await db.conversationMember.findFirstOrThrow({
    where: { conversationId, agentId },
  });
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId,
      sequence: 11,
      senderMemberId: agentMember.id,
      body: "Which color?",
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
        prompt: "Which color?",
        options: [
          { id: "a", label: "Red" },
          { id: "b", label: "Blue" },
        ],
        to: userId,
        // As stored when the Agent turns the row off: no `other` at all.
      },
      preparedByAgentId: agentId,
    },
  });
  await expect(
    commitChoiceCard(
      db,
      undefined,
      { workspaceId, actorUserId: userId },
      {
        messageId: message.id,
        optionId: "_other",
        text: "Green",
      },
    ),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  // Leave no pending card behind for the waiting-list test that follows.
  await db.actionCard.update({
    where: { messageId: message.id },
    data: { state: "cancelled" },
  });
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
  // The person's own answer row is on by default; the Agent can label it or turn it off.
  expect(payload.other).toEqual({});
  expect(
    (
      await resolveChoicePayload(db, conversationId, {
        ...action,
        other: { label: "Something else" },
      })
    ).other,
  ).toEqual({ label: "Something else" });
  expect(
    (await resolveChoicePayload(db, conversationId, { ...action, other: { enabled: false } }))
      .other,
  ).toBeUndefined();
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
  expect(view.kind === "choice" && view.other).toEqual({});
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
  // A direct caller with no fallback refuses a card that names nobody; the prepare path passes
  // the preparing Agent's owner for an older Computer's CLI, whose schema strips `to`.
  await expect(
    resolveChoicePayload(db, conversationId, { ...action, to: undefined }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const legacy = await resolveChoicePayload(
    db,
    conversationId,
    { ...action, to: undefined },
    userId,
  );
  expect(legacy.to).toBe(userId);
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
  // Where to open it and who asks: a channel card, not in a thread or a Task.
  expect(waiting[0]).toMatchObject({
    conversationId,
    channel: { visibility: "public" },
    threadRootId: null,
    task: null,
    prompt: "Which?",
    options: [
      { id: "a", label: "Red" },
      { id: "b", label: "Blue" },
    ],
    preparedBy: { agentId },
  });
  expect(waiting.some((card) => card.messageId === other || card.messageId === noTo)).toBe(false);
});
