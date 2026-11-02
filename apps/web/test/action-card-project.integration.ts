import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { ActionCards, ActionCardError } from "#src/server/conversations/action-cards.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

/**
 * A `channel:create` card's optional `project`: resolved at prepare time to the Project's id in the
 * Agent's Workspace, stored as `suggestedProjectId` and shown on the card view; an unknown or
 * ambiguous one is refused. Against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `acp-alice-${suffix}`, username: `acp-alice-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `acp-${suffix}`,
      name: "Card projects",
      members: { create: { userId: alice.id, role: "owner" } },
      agents: {
        create: {
          name: `scout-${suffix}`,
          displayName: "Scout",
          ownerId: alice.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  const other = await db.workspace.create({
    data: { slug: `acp-other-${suffix}`, name: "Other" },
  });
  const agent = workspace.agents[0]!;
  const project = (workspaceId: string, name: string, slug: string) =>
    db.project.create({ data: { workspaceId, name, slug } });
  const [web, twinA, twinB, foreign] = await Promise.all([
    project(workspace.id, "Web App", `web-${suffix}`),
    project(workspace.id, "Twin", `twin-a-${suffix}`),
    project(workspace.id, "twin", `twin-b-${suffix}`),
    project(other.id, "Foreign", `foreign-${suffix}`),
  ]);
  const hub = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `hub-${suffix}`,
      members: { create: [{ userId: alice.id }, { agentId: agent.id }] },
    },
  });
  const actionCards = new ActionCards(db, new PrismaDirectConversationRepository(db), {
    async memberChanged() {},
    async messageAvailable() {},
  });
  const prepare = (action: Record<string, unknown>) =>
    actionCards.prepare(
      { workspaceId: workspace.id, agentId: agent.id },
      { target: `#${hub.channelName}`, action: { type: "channel:create", ...action } },
    );
  return {
    db,
    suffix,
    workspace,
    alice,
    web,
    twinA,
    twinB,
    foreign,
    actionCards,
    prepare,
    async cleanup() {
      await db.workspace.deleteMany({ where: { id: { in: [workspace.id, other.id] } } });
      await db.user.delete({ where: { id: alice.id } });
      await db.$disconnect();
    },
  };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ActionCardError);
    return error as ActionCardError;
  }
  throw new Error("expected the card to be refused");
}

test.skipIf(!connectionString)(
  "a card's project is resolved by name, slug or id, stored and shown on its view",
  async () => {
    const f = await setup();
    try {
      const views = [];
      for (const [index, project] of [f.web.name, f.web.slug, "web app", f.web.id].entries()) {
        const { messageId } = await f.prepare({
          name: `ch-${index}-${f.suffix}`,
          project,
        });
        const card = await f.db.actionCard.findUniqueOrThrow({ where: { messageId } });
        expect(card.payload).toMatchObject({ suggestedProjectId: f.web.id });
        views.push(messageId);
      }
      const shown = await f.actionCards.viewsFor(f.workspace.id, f.alice.id, views);
      expect(shown.size).toBe(4);
      for (const view of shown.values())
        expect(view).toMatchObject({ kind: "channel:create", suggestedProjectId: f.web.id });

      // Without a project, nothing is stored or shown.
      const plain = await f.prepare({ name: `plain-${f.suffix}` });
      const card = await f.db.actionCard.findUniqueOrThrow({
        where: { messageId: plain.messageId },
      });
      expect(card.payload).not.toHaveProperty("suggestedProjectId");
      const [view] = (
        await f.actionCards.viewsFor(f.workspace.id, f.alice.id, [plain.messageId])
      ).values();
      expect(view).toMatchObject({ kind: "channel:create" });
      expect((view as { suggestedProjectId?: string }).suggestedProjectId).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a project that is unknown, of another Workspace or ambiguous is refused like an unknown handle",
  async () => {
    const f = await setup();
    try {
      for (const project of ["nope", f.foreign.name, f.foreign.slug, f.foreign.id]) {
        const error = await refusal(f.prepare({ name: `bad-${f.suffix}`, project }));
        expect(error.code).toBe("INVALID_HANDLE");
        expect(error.field).toBe("action.project");
        expect(error.message).toBe(`unknown project handle: ${project}`);
      }
      // Two Projects share the name: the slug names one of them.
      const ambiguous = await refusal(f.prepare({ name: `bad-${f.suffix}`, project: "twin" }));
      expect(ambiguous.code).toBe("INVALID_HANDLE");
      expect(ambiguous.field).toBe("action.project");
      const bySlug = await f.prepare({ name: `ok-${f.suffix}`, project: f.twinB.slug });
      expect(
        (await f.db.actionCard.findUniqueOrThrow({ where: { messageId: bySlug.messageId } }))
          .payload,
      ).toMatchObject({ suggestedProjectId: f.twinB.id });
      expect(await f.db.message.count({ where: { body: { contains: `bad-${f.suffix}` } } })).toBe(
        0,
      );
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a committing human's own project wins over the card's",
  async () => {
    const f = await setup();
    try {
      const { messageId } = await f.prepare({ name: `win-${f.suffix}`, project: f.web.slug });
      const { channelId } = await f.actionCards.commitChannelCreate(
        { workspaceId: f.workspace.id, actorUserId: f.alice.id },
        {
          messageId,
          name: `win-${f.suffix}`,
          projectId: f.twinA.id,
          memberUserIds: [],
          memberAgentIds: [],
        },
      );
      expect(
        (await f.db.conversation.findUniqueOrThrow({ where: { id: channelId } })).projectId,
      ).toBe(f.twinA.id);
    } finally {
      await f.cleanup();
    }
  },
);
