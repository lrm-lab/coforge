import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { DELIVERY_RETRY_DELAYS_MS } from "#src/server/conversations/agent-delivery.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { withPublishBatch } from "./helpers/fake-centrifugo";

test("assignment receipts survive mute and disconnect without waking unrelated Agents", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const human = await db.user.create({
    data: { displayName: `receipt-${suffix}`, username: `receipt-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `receipt-${suffix}`,
      name: "Receipt test",
      members: { create: { userId: human.id, role: "owner" } },
      agents: {
        create: ["assigned", "muted"].map((name) => ({
          name: `${name}-${suffix}`,
          displayName: name,
          ownerId: human.id,
          runtimeConfig: {},
        })),
      },
    },
    include: { agents: true },
  });
  const [assigned, unrelated] = workspace.agents;
  const computer = await db.computer.create({
    data: { ownerId: human.id, machineId: crypto.randomUUID() },
  });
  await db.agent.updateMany({
    where: { workspaceId: workspace.id },
    data: { computerId: computer.id },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `receipt-${suffix}`,
      members: {
        create: [
          { userId: human.id },
          ...workspace.agents.map((agent) => ({
            agentId: agent.id,
            channelMuted: true,
            notificationLevel: "muted",
          })),
        ],
      },
    },
  });
  const principal = { workspaceId: workspace.id, userId: human.id };
  const agentPrincipal = { workspaceId: workspace.id, agentId: assigned!.id };
  const target = `#${channel.channelName}`;
  const repo = new PrismaDirectConversationRepository(db);
  const published: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
  const signaled: string[] = [];
  const board = new TaskBoard(db, {
    realtime: {
      async memberChanged() {},
      async messageAvailable(event) {
        signaled.push(event.messageId);
      },
    },
    publisher: withPublishBatch({
      async publish(_channel, payload) {
        published.push(decodeAgentMessageDelivery(payload));
        throw new Error("connection lost");
      },
    }),
  });
  try {
    const createTask = async (conversationId: string, title: string) =>
      (
        await board.execute(principal, {
          operation: "create",
          idempotencyKey: crypto.randomUUID(),
          conversationId,
          title,
        })
      ).tasks[0]!;
    const [first, second, third] = [
      await createTask(channel.id, "First reserved task"),
      await createTask(channel.id, "Second reserved task"),
      await createTask(channel.id, "Third reserved task"),
    ];
    // The Agents have read the channel up to its Task messages, which woke nobody.
    await db.conversationMember.updateMany({
      where: { conversationId: channel.id, agentId: { not: null } },
      data: {
        readThroughSequence: (
          await db.conversation.findUniqueOrThrow({ where: { id: channel.id } })
        ).lastSequence,
      },
    });
    const commands = [first, second].map((task) => ({
      operation: "assign" as const,
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      number: task.number,
      assignee: `@${assigned!.name}`,
    }));
    const results = [];
    for (const command of commands) results.push(await board.execute(principal, command));
    const created = {
      tasks: results.map((result) => result.tasks[0]!),
      assignmentReceipts: results.map((result) => result.assignmentReceipts![0]!),
    };
    expect(created.tasks.map((task) => task.status)).toEqual(["todo", "todo"]);
    expect(created.tasks.map((task) => task.claimedAt)).toEqual([null, null]);
    // One receipt per Task, each in that Task's own thread and delivered there.
    const receipts = created.assignmentReceipts!;
    expect(receipts.map((receipt) => receipt.state)).toEqual(["assigned", "assigned"]);
    const threads = created.tasks.map((task) => `${target}:#${task.number}`);
    // The receipts are published concurrently, so they may be published in either order. The
    // daemon does not depend on it: it dedupes by delivery and keeps one read cursor per thread.
    // Every attempt fails here, so the delivery retry publishes each receipt 1 + its retries times;
    // what matters is the two distinct deliveries, not the attempt count.
    const distinctDeliveries = [...new Map(published.map((p) => [p.messageId, p])).values()];
    expect(distinctDeliveries).toHaveLength(2);
    expect(published).toHaveLength(2 * (1 + DELIVERY_RETRY_DELAYS_MS.length));
    expect(distinctDeliveries).toEqual(
      expect.arrayContaining(
        receipts.map((receipt, index) =>
          expect.objectContaining({
            messageId: receipt.messageId,
            latestSenderKind: "system",
            latestSenderHandle: "",
            latestSenderDescription: "",
            agentId: assigned!.id,
            target: threads[index],
          }),
        ),
      ),
    );
    const publishedSoFar = published.length;
    for (const [index, command] of commands.entries())
      expect((await board.execute(principal, command)).assignmentReceipts).toEqual([
        receipts[index],
      ]);
    expect(published).toHaveLength(publishedSoFar);
    // The receipts are in the Tasks' own conversations; the channel holds no message, and the
    // retries wrote nothing.
    expect(await db.message.count({ where: { conversationId: channel.id } })).toBe(0);
    expect(
      await db.message.findMany({
        where: { id: { in: receipts.map((receipt) => receipt.messageId) } },
        orderBy: { sequence: "asc" },
        select: { threadRootId: true, conversation: { select: { kind: true } } },
      }),
    ).toEqual(
      created.tasks.map(() => ({ threadRootId: null, conversation: { kind: "task_thread" } })),
    );
    expect(
      await db.taskFollow.count({
        where: {
          member: { agentId: assigned!.id },
          task: { id: { in: created.tasks.map((task) => task.id) } },
        },
      }),
    ).toBe(2);
    expect(await repo.readPendingAgentDeliveries(workspace.id, assigned!.id)).toEqual(
      receipts.map((receipt, index) =>
        expect.objectContaining({
          messageId: receipt.messageId,
          latestSenderKind: "system",
          latestSenderHandle: "",
          latestSenderDescription: "",
          target: threads[index],
        }),
      ),
    );
    expect(await repo.readAgentRecoveryContext(workspace.id, unrelated!.id)).toEqual({
      resumeMessages: [],
      unreadSummary: {},
      openTasks: { tasks: [], more: 0 },
    });
    const receipt = receipts[0]!;

    // The Agent owner being Workspace owner must not confer admin authority on the Agent.
    await expect(
      board.execute(agentPrincipal, {
        ...commands[0]!,
        idempotencyKey: crypto.randomUUID(),
        conversationId: undefined,
        target,
        assignee: `@${unrelated!.name}`,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", errorId: "task_assign_reason_invalid" });
    const changed = await board.execute(principal, {
      operation: "assign",
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      number: created.tasks[0]!.number,
      assignee: `@${unrelated!.name}`,
    });
    expect(changed.assignmentReceipts![0]!.messageId).not.toBe(receipt.messageId);
    await expect(
      board.execute(agentPrincipal, {
        operation: "unassign",
        idempotencyKey: crypto.randomUUID(),
        target,
        number: created.tasks[0]!.number,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    // An Agent message with no Agent mention never wakes another Agent; an explicit Agent
    // mention is a directed handoff and does (PR #338's Agent-to-Agent wake).
    const beforeAgentSend = await repo.readPendingAgentDeliveries(workspace.id, unrelated!.id);
    await repo.sendAgentMessage(channel.id, assigned!.id, "ordinary Agent message, no mention");
    expect(await repo.readPendingAgentDeliveries(workspace.id, unrelated!.id)).toEqual(
      beforeAgentSend,
    );
    await repo.sendAgentMessage(
      channel.id,
      assigned!.id,
      `@${unrelated!.name} directed Agent handoff`,
    );
    const afterAgentMention = await repo.readPendingAgentDeliveries(workspace.id, unrelated!.id);
    expect(afterAgentMention).toHaveLength(beforeAgentSend.length + 1);
    expect(afterAgentMention).toContainEqual(
      expect.objectContaining({
        latestSenderKind: "agent",
        latestSenderHandle: assigned!.name,
        target,
        body: `@${unrelated!.name} directed Agent handoff`,
      }),
    );

    const mine = await board.execute(agentPrincipal, {
      operation: "list",
      idempotencyKey: crypto.randomUUID(),
      mine: true,
    });
    expect(mine.tasks).toEqual([
      expect.objectContaining({ number: created.tasks[1]!.number, channelRef: target }),
    ]);
    const direct = await repo.getOrCreateUserAgent(workspace.id, human.id, assigned!.id);
    const directTask = await createTask(direct.id, "Direct assignment");
    const directCreated = await board.execute(agentPrincipal, {
      operation: "assign",
      idempotencyKey: crypto.randomUUID(),
      target: `@${human.username}`,
      number: directTask.number,
      assignee: `@${assigned!.name}`,
    });
    // The receipt of the Agent's own self-assignment is not replayed to it on the next `ready`.
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, assigned!.id)).find((message) =>
        message.target.startsWith(`@${human.username}:`),
      ),
    ).toBeUndefined();
    const directMine = await board.execute(agentPrincipal, {
      operation: "list",
      idempotencyKey: crypto.randomUUID(),
      mine: true,
    });
    expect(directMine.tasks.find((task) => task.conversationId === direct.id)?.channelRef).toBe(
      `@${human.username}`,
    );
    await board.execute(agentPrincipal, {
      operation: "unclaim",
      idempotencyKey: crypto.randomUUID(),
      target: `@${human.username}`,
      number: directCreated.tasks[0]!.number,
    });
    expect(
      await db.message.findUniqueOrThrow({
        where: { id: directCreated.assignmentReceipts![0]!.messageId },
        select: {
          senderMemberId: true,
          threadRootId: true,
          conversation: { select: { kind: true } },
        },
      }),
    ).toEqual({ senderMemberId: null, threadRootId: null, conversation: { kind: "task_thread" } });
    const selfAssignCommand = {
      operation: "assign" as const,
      idempotencyKey: crypto.randomUUID(),
      target: `@${human.username}`,
      number: directCreated.tasks[0]!.number,
      assignee: `@${assigned!.name}`,
    };
    const selfAssigned = await board.execute(agentPrincipal, selfAssignCommand);
    expect(
      await db.agentMessageDelivery.count({
        where: { messageId: selfAssigned.assignmentReceipts![0]!.messageId },
      }),
    ).toBe(0);
    await board.execute(principal, {
      ...selfAssignCommand,
      idempotencyKey: crypto.randomUUID(),
      target: undefined,
      conversationId: direct.id,
      assignee: `@${human.username}`,
    });
    const signalsBeforeRetry = signaled.length;
    const selfRetried = await board.execute(agentPrincipal, selfAssignCommand);
    expect(selfRetried.assignmentReceipts).toEqual(selfAssigned.assignmentReceipts);
    expect(signaled).toHaveLength(signalsBeforeRetry);
    // A person assigning the Agent in the direct message still delivers the receipt to it.
    const humanAssigned = await board.execute(principal, {
      operation: "assign",
      idempotencyKey: crypto.randomUUID(),
      conversationId: direct.id,
      number: directCreated.tasks[0]!.number,
      assignee: `@${assigned!.name}`,
    });
    const directPending = {
      messageId: humanAssigned.assignmentReceipts![0]!.messageId,
      latestSenderKind: "system",
      latestSenderHandle: "",
      latestSenderDescription: "",
      target: `@${human.username}:#${directCreated.tasks[0]!.number}`,
    };
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, assigned!.id)).find((message) =>
        message.target.startsWith(`@${human.username}:`),
      ),
    ).toMatchObject(directPending);
    await board.execute(principal, {
      operation: "delete",
      idempotencyKey: crypto.randomUUID(),
      conversationId: direct.id,
      number: directCreated.tasks[0]!.number,
    });
    expect(await board.execute(agentPrincipal, selfAssignCommand)).toMatchObject({
      tasks: [],
      assignmentReceipts: selfAssigned.assignmentReceipts,
    });

    const beforeRollback = await db.task.count({ where: { conversationId: channel.id } });
    const taskMessages = () =>
      db.message.count({
        where: {
          conversation: { kind: "task_thread", taskDiscussionOf: { conversationId: channel.id } },
        },
      });
    const beforeRollbackMessages = await taskMessages();
    // A disposable-DB constraint fails exactly the system Message write, after Task insertion.
    await db.$executeRaw`ALTER TABLE "messages" ADD CONSTRAINT "test_reject_system_receipt" CHECK ("senderMemberId" IS NOT NULL) NOT VALID`;
    try {
      await expect(
        board.execute(principal, {
          ...commands[0]!,
          idempotencyKey: crypto.randomUUID(),
          number: third.number,
        }),
      ).rejects.toThrow();
      await expect(
        board.execute(principal, {
          operation: "assign",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          number: created.tasks[1]!.number,
          assignee: `@${unrelated!.name}`,
        }),
      ).rejects.toThrow();
      expect(await db.task.count({ where: { conversationId: channel.id } })).toBe(beforeRollback);
      expect(await taskMessages()).toBe(beforeRollbackMessages);
      const afterRollback = await board.execute(agentPrincipal, {
        operation: "list",
        idempotencyKey: crypto.randomUUID(),
        mine: true,
      });
      expect(
        afterRollback.tasks.find((task) => task.conversationId === channel.id)?.owner?.memberId,
      ).toBe(created.tasks[1]!.owner!.memberId);
    } finally {
      await db.$executeRaw`ALTER TABLE "messages" DROP CONSTRAINT "test_reject_system_receipt"`;
    }
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.delete({ where: { id: computer.id } });
    await db.user.delete({ where: { id: human.id } });
    await db.$disconnect();
  }
});
