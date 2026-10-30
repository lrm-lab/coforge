import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";

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
          ...workspace.agents.map((agent) => ({ agentId: agent.id, channelMuted: true })),
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
    publisher: {
      async publish(_channel, payload) {
        published.push(decodeAgentMessageDelivery(payload));
        throw new Error("connection lost");
      },
    },
  });
  try {
    const command = {
      operation: "create" as const,
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      titles: ["First reserved task", "Second reserved task"],
      assignee: `@${assigned!.name}`,
    };
    const created = await board.execute(principal, command);
    expect(created.tasks.map((task) => task.status)).toEqual(["todo", "todo"]);
    expect(created.tasks.map((task) => task.claimedAt)).toEqual([null, null]);
    // One receipt per Task, each in that Task's own thread and delivered there.
    const receipts = created.assignmentReceipts!;
    expect(receipts.map((receipt) => receipt.state)).toEqual(["assigned", "assigned"]);
    const threads = created.tasks.map((task) => `${target}:${task.messageId}`);
    expect(published).toHaveLength(2);
    expect(published).toEqual(
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
    );
    const retried = await board.execute(principal, command);
    expect(retried.assignmentReceipts).toEqual(receipts);
    expect(published).toHaveLength(2);
    // Two Task messages, the creation notice, and the two receipts; the retry wrote nothing.
    expect(await db.message.count({ where: { conversationId: channel.id } })).toBe(5);
    expect(
      await db.message.findMany({
        where: { id: { in: receipts.map((receipt) => receipt.messageId) } },
        orderBy: { sequence: "asc" },
        select: { threadRootId: true },
      }),
    ).toEqual(created.tasks.map((task) => ({ threadRootId: task.messageId })));
    expect(
      await db.threadFollow.count({
        where: { rootMessageId: { in: created.tasks.map((task) => task.messageId) } },
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
    });
    const recovery = await repo.readAgentRecoveryContext(workspace.id, assigned!.id);
    expect(recovery.unreadSummary).toEqual({ [threads[0]!]: 1, [threads[1]!]: 1 });
    expect(recovery.resumeMessages.map((message) => message.messageId)).toEqual(
      receipts.map((receipt) => receipt.messageId),
    );
    expect(
      (
        await (
          await repo.agentTargetFreshness(workspace.id, assigned!.id, threads[0]!)
        ).readPending(0)
      ).map((message) => message.senderKind),
    ).toEqual(["system"]);
    const receipt = receipts[0]!;
    const page = await repo.readMessagesPage(workspace.id, assigned!.id, threads[0]!, {
      around: receipt.messageId,
    });
    expect(page.messages.find((message) => message.id === receipt.messageId)).toMatchObject({
      senderKind: "system",
      body: `[CoForge current channel role: member; coordinator=none]\n${receipt.content}`,
    });
    const browser = await new ConversationHistory(db).loadThread(
      workspace.id,
      human.id,
      channel.id,
      created.tasks[0]!.messageId,
    );
    expect(browser.replies.find((message) => message.id === receipt.messageId)).toMatchObject({
      senderKind: "system",
      senderMemberId: null,
      senderName: "System",
    });
    for (const [index, thread] of threads.entries())
      await repo.advanceAgentReadThrough(
        workspace.id,
        assigned!.id,
        thread,
        recovery.resumeMessages[index]!.sequence,
      );
    expect((await repo.readAgentRecoveryContext(workspace.id, assigned!.id)).unreadSummary).toEqual(
      {},
    );

    // The Agent owner being Workspace owner must not confer admin authority on the Agent.
    await expect(
      board.execute(agentPrincipal, {
        ...command,
        idempotencyKey: crypto.randomUUID(),
        conversationId: undefined,
        target,
        assignee: `@${unrelated!.name}`,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
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
        operation: "assign",
        idempotencyKey: crypto.randomUUID(),
        target,
        number: created.tasks[0]!.number,
        assignee: `@${assigned!.name}`,
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
        body: `[CoForge current channel role: member; coordinator=none]\n@${unrelated!.name} directed Agent handoff`,
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
    const directCreated = await board.execute(agentPrincipal, {
      operation: "create",
      idempotencyKey: crypto.randomUUID(),
      target: `@${human.username}`,
      title: "Direct assignment",
      assignee: `@${assigned!.name}`,
    });
    // The receipt of the Agent's own self-assignment is not replayed to it on the next `ready`.
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, assigned!.id)).find(
        (message) => message.conversationId === direct.id,
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
    // Nor does the Agent owe attention to it.
    expect(
      (await repo.readAgentRecoveryContext(workspace.id, assigned!.id)).resumeMessages.find(
        (message) => message.conversationId === direct.id,
      ),
    ).toBeUndefined();
    await board.execute(agentPrincipal, {
      operation: "unclaim",
      idempotencyKey: crypto.randomUUID(),
      target: `@${human.username}`,
      number: directCreated.tasks[0]!.number,
    });
    const directBrowser = await new ConversationHistory(db).loadThread(
      workspace.id,
      human.id,
      direct.id,
      directCreated.tasks[0]!.messageId,
    );
    expect(
      directBrowser.replies.find(
        (message) => message.id === directCreated.assignmentReceipts![0]!.messageId,
      )?.senderKind,
    ).toBe("system");
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
      target: `@${human.username}:${directCreated.tasks[0]!.messageId}`,
    };
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, assigned!.id)).find(
        (message) => message.conversationId === direct.id,
      ),
    ).toMatchObject(directPending);
    expect(
      (await repo.readAgentRecoveryContext(workspace.id, assigned!.id)).resumeMessages.find(
        (message) => message.conversationId === direct.id,
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
    const beforeRollbackMessages = await db.message.count({
      where: { conversationId: channel.id },
    });
    // A disposable-DB constraint fails exactly the system Message write, after Task insertion.
    await db.$executeRaw`ALTER TABLE "messages" ADD CONSTRAINT "test_reject_system_receipt" CHECK ("senderMemberId" IS NOT NULL) NOT VALID`;
    try {
      await expect(
        board.execute(principal, { ...command, idempotencyKey: crypto.randomUUID() }),
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
      expect(await db.message.count({ where: { conversationId: channel.id } })).toBe(
        beforeRollbackMessages,
      );
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
