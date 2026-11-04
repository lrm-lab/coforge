import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  choiceActionCardView,
  commitChoiceCard,
  resolveChoicePayload,
} from "#src/server/conversations/action-card-choice.server";

const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);

let workspaceId: string;
let userId: string;
let agentId: string;
let conversationId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `rec-${suffix}`, displayName: "Rec" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: { slug: `rec-${suffix}`, name: "Recommended", members: { create: { userId } } },
  });
  workspaceId = workspace.id;
  const computer = await db.computer.create({
    data: { ownerId: userId, machineId: `rec-machine-${suffix}` },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId: userId,
      computerId: computer.id,
      name: `rec-agent-${suffix}`,
      displayName: "Rec Agent",
      runtimeConfig: {},
    },
  });
  agentId = agent.id;
  const conversation = await db.conversation.create({
    data: { workspaceId, channelName: `rec-${suffix}`, visibility: "public" },
  });
  conversationId = conversation.id;
  await db.conversationMember.create({ data: { workspaceId, conversationId, userId } });
  await db.conversationMember.create({ data: { workspaceId, conversationId, agentId } });
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  await db.$disconnect();
});

const action = (options: { id: string; label: string; recommended?: boolean }[]) => ({
  type: "choice" as const,
  prompt: "Which color?",
  options,
  to: `@rec-${suffix}`,
});

test("a recommended option is moved first with a warning, and the view carries the flag", async () => {
  const payload = await resolveChoicePayload(
    db,
    conversationId,
    action([
      { id: "a", label: "Red" },
      { id: "b", label: "Blue", recommended: true },
    ]),
  );
  expect(payload.options.map((option) => option.id)).toEqual(["b", "a"]);
  expect(payload.options[0]).toMatchObject({ recommended: true });
  expect("warning" in payload ? payload.warning : undefined).toContain('"Blue"');
  const view = choiceActionCardView(
    { messageId: "m", state: "pending", createdAt: new Date(), kind: "choice" } as never,
    { result: undefined },
    payload,
    userId,
    true,
    (id) => (id === userId ? { id, displayName: "Rec", avatarUrl: null } : undefined),
  );
  expect(view.kind).toBe("choice");
  if (view.kind !== "choice") throw new Error("expected a choice view");
  expect(view.options[0]).toMatchObject({ id: "b", recommended: true });
  await expect(
    resolveChoicePayload(
      db,
      conversationId,
      action([
        { id: "a", label: "Red", recommended: true },
        { id: "b", label: "Blue", recommended: true },
      ]),
    ),
  ).rejects.toMatchObject({ errorId: "action_card_choice_recommended" });
});

test("choosing the recommended option records it and the Agent reads (recommended)", async () => {
  const payload = await resolveChoicePayload(
    db,
    conversationId,
    action([
      { id: "a", label: "Red" },
      { id: "b", label: "Blue", recommended: true },
    ]),
  );
  const agentMember = await db.conversationMember.findFirstOrThrow({
    where: { conversationId, agentId },
  });
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId,
      sequence: 1,
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
      payload: payload as never,
      preparedByAgentId: agentId,
    },
  });
  const published: unknown[] = [];
  const result = await commitChoiceCard(
    db,
    undefined,
    { workspaceId, actorUserId: userId },
    { messageId: message.id, optionId: "b" },
    {
      publisher: {
        publishBatch: async (publications: unknown[]) => {
          published.push(...publications);
          return new Map(publications.map((_, index) => [String(index), { status: "sent" }]));
        },
      } as never,
    },
  );
  expect(result).toMatchObject({ optionId: "b", recommended: true });
  const encoded = (published[0] as { data: Record<string, number> }).data;
  expect(new TextDecoder().decode(Uint8Array.from(Object.values(encoded)))).toContain(
    "(recommended)",
  );
});
