import { expect, test } from "bun:test";
import { UserDirectConversations } from "#src/server/conversations/user-direct-conversations.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import type {
  ConversationRealtimeMessage,
  TaskChangedSignal,
} from "#src/server/conversations/conversation-realtime.server";
import {
  PrismaWorkspaceCatalogStore,
  WorkspaceCatalog,
} from "#src/server/workspaces/catalog.server";
import { WorkspaceDeparture } from "#src/server/workspaces/departure.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { teardown } from "./helpers/workspace-teardown";
import {
  channelTestConnectionString as connectionString,
  memberLeaveSetup as setup,
  passThrough,
  rememberedWorkspace,
  silentRealtime,
} from "./helpers/workspace-member-leave-fixture";

/**
 * Leaving a Workspace, or being removed from it, ends a person's memberships but never their
 * history: what they wrote stays readable under their name, and nobody still in the Workspace
 * sees them as a member. Drives the real services and Prisma stores against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL; the Agent-side tests
 * are in `workspace-member-leave-agent.integration.test.ts`.
 */

test.skipIf(!connectionString)(
  "leaving goes to the Workspace last opened while still a member, else the first one left, and `/` remembers it",
  async () => {
    const { db, directory, admit, workspace, owner, bob } = await setup();
    const suffix = crypto.randomUUID().slice(0, 8);
    const [first, second] = [
      await db.workspace.create({
        data: {
          slug: `ml-first-${suffix}`,
          name: "First",
          members: { create: { userId: bob.id, role: "member" } },
        },
      }),
      await db.workspace.create({
        data: {
          slug: `ml-second-${suffix}`,
          name: "Second",
          members: { create: { userId: bob.id, role: "admin" } },
        },
      }),
    ];
    try {
      const departure = (slug?: string) => {
        const preference = rememberedWorkspace(slug);
        return {
          ...preference,
          departure: new WorkspaceDeparture(
            new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db)),
            preference.port,
          ),
        };
      };

      // `/` remembered the Workspace being left: the first one still theirs takes over.
      const leavingOpened = departure(workspace.slug);
      expect(
        await leavingOpened.departure.leave(directory, {
          workspaceId: workspace.id,
          userId: bob.id,
        }),
      ).toEqual({ nextWorkspaceSlug: first.slug });
      expect(leavingOpened.remembered.slug).toBe(first.slug);

      // Left from another tab while `/` remembered a Workspace they are still in: that one stays.
      await admit();
      const leavingElsewhere = departure(second.slug);
      expect(
        await leavingElsewhere.departure.leave(directory, {
          workspaceId: workspace.id,
          userId: bob.id,
        }),
      ).toEqual({ nextWorkspaceSlug: second.slug });
      expect(leavingElsewhere.remembered.slug).toBe(second.slug);
    } finally {
      await db.workspace.deleteMany({ where: { id: { in: [first.id, second.id] } } });
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "leaving the last Workspace goes nowhere and `/` forgets it; the owner cannot leave",
  async () => {
    const { db, directory, workspace, owner, bob } = await setup();
    try {
      const catalog = new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db));
      const bobs = rememberedWorkspace(workspace.slug);
      expect(
        await new WorkspaceDeparture(catalog, bobs.port).leave(directory, {
          workspaceId: workspace.id,
          userId: bob.id,
        }),
      ).toEqual({ nextWorkspaceSlug: null });
      expect(bobs.remembered.slug).toBeUndefined();

      const owners = rememberedWorkspace(workspace.slug);
      await expect(
        new WorkspaceDeparture(catalog, owners.port).leave(directory, {
          workspaceId: workspace.id,
          userId: owner.id,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(owners.remembered.slug).toBe(workspace.slug);
      expect((await catalog.listForUser(owner.id)).map((row) => row.id)).toEqual([workspace.id]);
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "a member who wrote in a channel can leave, and what they wrote stays readable under their name",
  async () => {
    const { db, directory, channels, workspace, owner, bob, team } = await setup();
    try {
      await channels.send({
        idempotencyKey: crypto.randomUUID(),
        workspaceId: workspace.id,
        userId: bob.id,
        channelId: team.id,
        body: "handing this over",
      });

      await directory.leave({ workspaceId: workspace.id, userId: bob.id });

      const history = await channels.open(workspace.id, owner.id, team.id);
      const message = history.messages.find((row) => row.body === "handing this over");
      expect(message).toMatchObject({ senderKind: "user", senderHandle: bob.username });
      const members = await channels.members(workspace.id, { userId: owner.id }, team.id);
      expect(members.humans.map((human) => human.id)).toEqual([owner.id]);
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "a removed member keeps their Tasks, and when invited back returns to #general and can rejoin",
  async () => {
    const { db, directory, channels, admit, workspace, owner, bob, team } = await setup();
    try {
      const board = new TaskBoard(db);
      const created = await board.execute(
        { workspaceId: workspace.id, userId: bob.id },
        {
          operation: "create",
          idempotencyKey: crypto.randomUUID(),
          conversationId: team.id,
          title: "Ship the release",
          assignee: `@${bob.username}`,
        },
      );
      const taskNumber = created.tasks[0]!.number;

      await directory.removeMember({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        targetUserId: bob.id,
      });

      const listed = await board.execute(
        { workspaceId: workspace.id, userId: owner.id },
        { operation: "list", idempotencyKey: crypto.randomUUID(), conversationId: team.id },
      );
      expect(listed.tasks.find((task) => task.number === taskNumber)).toMatchObject({
        owner: { kind: "user", id: bob.id, left: true },
      });

      await admit();
      const general = await db.conversation.findUniqueOrThrow({
        where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
      });
      const generalMembers = await channels.members(workspace.id, { userId: owner.id }, general.id);
      expect(generalMembers.humans.map((human) => human.id).sort()).toEqual(
        [owner.id, bob.id].sort(),
      );
      // Not back in the other channel until they join it again.
      expect(
        (await channels.list(workspace.id, bob.id)).find((row) => row.id === team.id)?.joined,
      ).toBe(false);
      await channels.join(workspace.id, bob.id, team.id);
      await channels.send({
        idempotencyKey: crypto.randomUUID(),
        workspaceId: workspace.id,
        userId: bob.id,
        channelId: team.id,
        body: "back on it",
      });
      const history = await channels.open(workspace.id, owner.id, team.id);
      expect(history.messages.at(-1)).toMatchObject({
        body: "back on it",
        senderHandle: bob.username,
      });
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "a member's direct conversations stay readable to the other side, and are theirs again when they return",
  async () => {
    const { db, directory, admit, workspace, owner, bob } = await setup();
    try {
      const announced: ConversationRealtimeMessage[] = [];
      const taskSignals: TaskChangedSignal[] = [];
      const realtime = {
        ...silentRealtime,
        async messageAvailable(input: ConversationRealtimeMessage) {
          announced.push(input);
        },
        async taskChanged(signal: TaskChangedSignal) {
          taskSignals.push(signal);
        },
      };
      const people = new UserDirectConversations(db, passThrough, realtime);
      const direct = new DirectConversations(db);
      const helper = await db.agent.create({
        data: {
          workspaceId: workspace.id,
          ownerId: bob.id,
          name: `helper-${bob.username}`,
          displayName: "Helper",
          runtimeConfig: {},
        },
      });
      const withOwner = await direct.open(workspace.id, bob.id, { userId: owner.id });
      const withHelper = await direct.open(workspace.id, bob.id, { agentId: helper.id });
      await people.send({
        idempotencyKey: crypto.randomUUID(),
        workspaceId: workspace.id,
        conversationId: withOwner.conversationId,
        senderUserId: bob.id,
        body: "see you",
      });

      await directory.leave({ workspaceId: workspace.id, userId: bob.id });

      // The other side still reads it, named after them; nothing new reaches them.
      const page = await direct.page(workspace.id, owner.id, withOwner.conversationId);
      expect(page).toMatchObject({ kind: "people", peer: { id: bob.id } });
      expect(page.messages.map((message) => message.body)).toEqual(["see you"]);
      await people.send({
        idempotencyKey: crypto.randomUUID(),
        workspaceId: workspace.id,
        conversationId: withOwner.conversationId,
        senderUserId: owner.id,
        body: "take care",
      });
      // Only the sender's own list is signalled (so their other tabs refresh the row); the member
      // who left is no longer in it.
      expect(announced.at(-1)?.directUserIds).toEqual([owner.id]);
      await new TaskBoard(db, { realtime }).execute(
        { workspaceId: workspace.id, userId: owner.id },
        {
          operation: "create",
          idempotencyKey: crypto.randomUUID(),
          conversationId: withOwner.conversationId,
          title: "Return the keys",
        },
      );
      expect(taskSignals.map((signal) => signal.directUserIds)).toEqual([[owner.id]]);
      await expect(
        direct.page(workspace.id, bob.id, withOwner.conversationId),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      await admit();
      const back = await direct.page(workspace.id, bob.id, withOwner.conversationId);
      expect(back.messages.map((message) => message.body)).toEqual(
        expect.arrayContaining(["see you", "take care"]),
      );
      const list = await direct.list(workspace.id, bob.id);
      expect(list.conversations.map((row) => row.conversationId).sort()).toEqual(
        [withOwner.conversationId, withHelper.conversationId].sort(),
      );
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);
