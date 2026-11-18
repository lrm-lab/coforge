import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type {
  ConversationRealtime,
  ConversationRealtimeMessage,
} from "#src/server/conversations/conversation-realtime.server";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/**
 * An assignment receipt is a server notice in the Task's own conversation: its signal goes only to
 * that conversation's channel; the Task's followers (the creator, and a person assigned) hear of it
 * through `activity.changed.v1`.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

test.skipIf(!connectionString)(
  "a Task assigned to a person tells the conversation and the assignee's Activity, not the sidebars",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    const suffix = crypto.randomUUID().slice(0, 8);
    const ada = await db.user.create({
      data: { displayName: `ars-ada-${suffix}`, username: `ars-ada-${suffix}` },
    });
    const bob = await db.user.create({
      data: { displayName: `ars-bob-${suffix}`, username: `ars-bob-${suffix}` },
    });
    const workspace = await db.workspace.create({
      data: {
        slug: `ars-${suffix}`,
        name: "Assignment receipt signal",
        members: {
          create: [
            { userId: ada.id, role: "owner" },
            { userId: bob.id, role: "member" },
          ],
        },
      },
    });
    try {
      await enrollGeneralChannel(db, workspace.id);
      const general = await db.conversation.findFirstOrThrow({
        where: { workspaceId: workspace.id, channelName: "general" },
      });
      const messages: ConversationRealtimeMessage[] = [];
      const activity: { workspaceId: string; userId: string }[] = [];
      const realtime: ConversationRealtime = {
        async messageAvailable(input) {
          messages.push(input);
        },
        async memberChanged() {},
        async activityChanged(input) {
          activity.push(input);
        },
      };
      const board = new TaskBoard(db, { realtime });
      const asAda = { workspaceId: workspace.id, userId: ada.id };
      const createTask = async (title: string) =>
        (
          await board.execute(asAda, {
            operation: "create",
            idempotencyKey: crypto.randomUUID(),
            conversationId: general.id,
            title,
          })
        ).tasks[0]!;
      await board.execute(asAda, {
        operation: "assign",
        idempotencyKey: crypto.randomUUID(),
        conversationId: general.id,
        number: (await createTask("Review the plan")).number,
        assignee: `@${bob.username}`,
      });
      const taskReceipts = () =>
        db.message.findMany({
          where: {
            senderMemberId: null,
            conversation: { kind: "task_thread", taskDiscussionOf: { conversationId: general.id } },
          },
          select: { id: true, conversationId: true, threadRootId: true },
        });
      const [receipt] = await taskReceipts();
      expect(receipt!.threadRootId).toBeNull();
      expect(await db.message.count({ where: { conversationId: general.id } })).toBe(0);
      const receiptSignals = messages.filter((message) => message.messageId === receipt!.id);
      expect(receiptSignals).toEqual([
        {
          conversationId: receipt!.conversationId,
          messageId: receipt!.id,
          sequence: expect.any(Number),
          workspaceId: workspace.id,
        },
      ]);
      const told = (...users: { id: string }[]) =>
        users.map((user) => ({ workspaceId: workspace.id, userId: user.id }));
      expect(activity).toEqual(told(ada, bob));

      // Assigning later tells the person the same way; an Agent assignee has no Activity to tell.
      const agent = await db.agent.create({
        data: {
          workspaceId: workspace.id,
          name: `ars-agent-${suffix}`,
          displayName: "Helper",
          ownerId: ada.id,
          runtimeConfig: {
            runtime: "pi",
            provider: { kind: "default" },
            model: "",
            modelProvider: "",
            reasoning: "",
          },
        },
      });
      await db.conversationMember.create({
        data: { conversationId: general.id, workspaceId: workspace.id, agentId: agent.id },
      });
      const later = await createTask("Draft the notes");
      const assign = (assignee: string) =>
        board.execute(asAda, {
          operation: "assign",
          idempotencyKey: crypto.randomUUID(),
          conversationId: general.id,
          number: later.number,
          assignee,
        });
      activity.length = 0;
      await assign(`@${agent.name}`);
      expect(activity).toEqual(told(ada));
      activity.length = 0;
      await assign(`@${bob.username}`);
      expect(activity).toEqual(told(ada, bob));
      expect(await taskReceipts()).toHaveLength(3);
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user.deleteMany({ where: { username: { endsWith: suffix } } }).catch(() => {});
      await db.$disconnect();
    }
  },
);
