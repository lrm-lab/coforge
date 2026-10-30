import { expect, test } from "bun:test";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { connectionString, deletionFor, setup } from "./helpers/agent-deletion-fixture";
import { teardown } from "./helpers/workspace-teardown";

/**
 * Agent deletion and Tasks, against local PostgreSQL: a deleted Agent cannot be assigned a Task or
 * receive one, keeps the Task it claimed, and other readers see that Task marked deleted. Skipped
 * unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */

test.skipIf(!connectionString)(
  "a deleted Agent is neither an assignable Task target nor a Task recipient",
  async () => {
    const { db, workspace, owner, agent } = await setup();
    try {
      const general = await db.conversation.findUniqueOrThrow({
        where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
      });
      const board = new TaskBoard(db);
      const principal = { workspaceId: workspace.id, userId: owner.id };

      // Control: while the Agent is live it is both assignable and a delivery recipient.
      const before = await board.execute(principal, {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: general.id,
        title: "Before delete",
        assignee: `@${agent.name}`,
      });
      expect(before.assignmentReceipt).toMatchObject({ assignee: `@${agent.name}` });
      const beforeMessage = await db.message.findUniqueOrThrow({
        where: { id: before.tasks[0]!.messageId },
        select: { deliveries: { select: { agentId: true } } },
      });
      expect(beforeMessage.deliveries.map((delivery) => delivery.agentId)).toContain(agent.id);

      await deletionFor(db, []).delete(
        { userId: owner.id, workspaceId: workspace.id, role: "owner" },
        agent.id,
      );

      // The `@handle` no longer resolves to a conversation member, so the assignment is refused
      // exactly like any other unknown handle.
      await expect(
        board.execute(principal, {
          operation: "create",
          idempotencyKey: crypto.randomUUID(),
          conversationId: general.id,
          title: "After delete",
          assignee: `@${agent.name}`,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      // An ordinary Task in the channel no longer creates a delivery row for the deleted Agent, so
      // nothing can wake it through the Task path.
      const after = await board.execute(principal, {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: general.id,
        title: "No delivery after delete",
      });
      const afterMessage = await db.message.findUniqueOrThrow({
        where: { id: after.tasks[0]!.messageId },
        select: { deliveries: { select: { agentId: true } } },
      });
      expect(afterMessage.deliveries.map((delivery) => delivery.agentId)).not.toContain(agent.id);
    } finally {
      await teardown(db, workspace.id, [owner.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "a deleted Agent keeps the Task it claimed, and the Task names it as deleted",
  async () => {
    const { db, workspace, owner, agent } = await setup();
    try {
      const general = await db.conversation.findUniqueOrThrow({
        where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
      });
      const board = new TaskBoard(db);
      const principal = { workspaceId: workspace.id, userId: owner.id };
      const created = await board.execute(principal, {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: general.id,
        title: "Half-done work",
        assignee: `@${agent.name}`,
      });
      const number = created.tasks[0]!.number;
      const listTask = async () =>
        (
          await board.execute(principal, {
            operation: "list",
            idempotencyKey: crypto.randomUUID(),
            conversationId: general.id,
          })
        ).tasks.find((task) => task.number === number)!;
      expect((await listTask()).owner).toMatchObject({ handle: agent.name, deleted: false });

      await deletionFor(db, []).delete(
        { userId: owner.id, workspaceId: workspace.id, role: "owner" },
        agent.id,
      );

      // The claim and its status stay as they were; only the owner is now marked deleted, so a
      // Workspace owner/admin can see the Task needs reassigning.
      const after = await listTask();
      expect(after.status).toBe(created.tasks[0]!.status);
      expect(after.owner).toMatchObject({
        kind: "agent",
        id: agent.id,
        handle: agent.name,
        name: "Doomed",
        deleted: true,
      });
    } finally {
      await teardown(db, workspace.id, [owner.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "another Agent reading the channel sees a deleted Agent's Task marked deleted",
  async () => {
    const { db, workspace, owner, agent } = await setup();
    try {
      const general = await db.conversation.findUniqueOrThrow({
        where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
      });
      const reader = await db.agent.create({
        data: {
          workspaceId: workspace.id,
          name: `reader-${agent.name}`,
          displayName: "Reader",
          ownerId: owner.id,
          runtimeConfig: {},
        },
      });
      await db.conversationMember.create({
        data: { workspaceId: workspace.id, conversationId: general.id, agentId: reader.id },
      });
      const created = await new TaskBoard(db).execute(
        { workspaceId: workspace.id, userId: owner.id },
        {
          operation: "create",
          idempotencyKey: crypto.randomUUID(),
          conversationId: general.id,
          title: "Half-done work",
          assignee: `@${agent.name}`,
        },
      );
      const conversations = new PrismaDirectConversationRepository(db);
      // Read around the Task's message, so each read sees it whatever the reader's cursor.
      const taskLine = async () =>
        (
          await conversations.readMessages(workspace.id, reader.id, "#general", {
            around: created.tasks[0]!.messageId,
          })
        ).find((message) => message.task)!.task;
      // The handle carries no "@", like every other handle an Agent reads.
      expect(await taskLine()).toMatchObject({
        owner: { displayName: "Doomed", handle: agent.name },
      });
      expect((await taskLine())!.owner!.deleted).toBeUndefined();

      await deletionFor(db, []).delete(
        { userId: owner.id, workspaceId: workspace.id, role: "owner" },
        agent.id,
      );

      expect(await taskLine()).toMatchObject({
        status: "todo",
        owner: { displayName: "Doomed", handle: agent.name, deleted: true },
      });
    } finally {
      await teardown(db, workspace.id, [owner.id]);
    }
  },
);
