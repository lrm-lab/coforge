import type { Prisma } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { expect, test } from "bun:test";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { taskAssignmentFixture } from "./helpers/task-assignment-fixture";
import { channelAgentRecipients } from "#src/server/conversations/channel-agent-recipients.server";

test("coordinated claims opt into isolated execution without migrating existing work", async () => {
  const f = await taskAssignmentFixture("agent");
  try {
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { coordinatorAgentId: f.agent.id },
    });
    const created = await f.board.execute(f.ownerActor, {
      ...f.command("user"),
      operation: "create",
      titles: ["Legacy training", "New diagnostic"],
    });
    const [legacy, fresh] = created.tasks;
    await f.board.execute(f.actor, { ...f.command(), operation: "claim", number: legacy!.number });
    const retained = await f.board.execute(f.actor, {
      ...f.command(),
      operation: "claim",
      number: legacy!.number,
      isolatedExecution: true,
    });
    expect(retained.tasks[0]!.execution).toBeUndefined();
    const claimed = await f.board.execute(f.actor, {
      ...f.command(),
      operation: "claim",
      number: fresh!.number,
      isolatedExecution: true,
    });
    expect(claimed.tasks[0]!.execution).toEqual({ id: expect.any(String), attempt: 1 });
    const execution = claimed.tasks[0]!.execution!;
    const stored = await f.db.taskExecutionSession.findUniqueOrThrow({
      where: { id: execution.id },
    });
    expect(stored.requestId).not.toBeNull();
  } finally {
    await f.close();
  }
});

async function isolatedTask() {
  const f = await taskAssignmentFixture("agent");
  await f.db.conversation.update({
    where: { id: f.conversation.id },
    data: { coordinatorAgentId: f.agent.id },
  });
  const created = await f.board.execute(f.ownerActor, {
    ...f.command("user"),
    operation: "create",
    title: "Isolated diagnostic",
  });
  const claimed = await f.board.execute(f.actor, {
    ...f.command(),
    operation: "claim",
    number: created.tasks[0]!.number,
    isolatedExecution: true,
  });
  return { f, fresh: claimed.tasks[0]!, execution: claimed.tasks[0]!.execution! };
}

test("execution observations preserve native identity, start time and owner fencing", async () => {
  const { f, fresh, execution } = await isolatedTask();
  try {
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { channelName: "renamed-" + crypto.randomUUID().slice(0, 8) },
    });
    const reported = await f.board.execute(f.actor, {
      ...f.command(),
      target: undefined,
      conversationId: f.conversation.id,
      operation: "execution",
      number: fresh!.number,
      executionReport: {
        id: execution.id,
        attempt: 1,
        status: "running",
        nativeSessionId: "native-task-7",
      },
    });
    expect(reported.tasks[0]!.number).toBe(fresh!.number);
    const firstStart = (
      await f.db.taskExecutionSession.findUniqueOrThrow({ where: { id: execution.id } })
    ).startedAt;
    await f.board.execute(f.actor, {
      ...f.command(),
      target: undefined,
      conversationId: f.conversation.id,
      operation: "execution",
      number: fresh!.number,
      executionReport: {
        id: execution.id,
        attempt: 1,
        status: "starting",
        nativeSessionId: "native-task-7",
      },
    });
    expect(
      (await f.db.taskExecutionSession.findUniqueOrThrow({ where: { id: execution.id } })).status,
    ).toBe("running");
    await f.board.execute(f.actor, {
      ...f.command(),
      target: undefined,
      conversationId: f.conversation.id,
      operation: "execution",
      number: fresh!.number,
      executionReport: { id: execution.id, attempt: 1, status: "running" },
    });
    expect(
      (await f.db.taskExecutionSession.findUniqueOrThrow({ where: { id: execution.id } }))
        .startedAt,
    ).toEqual(firstStart);
    expect(
      (await f.db.taskExecutionSession.findUniqueOrThrow({ where: { id: execution.id } }))
        .nativeSessionId,
    ).toBe("native-task-7");
    await expect(
      f.board.execute(f.peerActor, {
        ...f.command(),
        target: undefined,
        conversationId: f.conversation.id,
        operation: "execution",
        number: fresh!.number,
        executionReport: { id: execution.id, attempt: 1, status: "running" },
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  } finally {
    await f.close();
  }
});

test("a retry retains the previous native history and closed attempts cannot be revived", async () => {
  const { f, fresh, execution } = await isolatedTask();
  try {
    await f.board.execute(f.actor, {
      ...f.command(),
      operation: "execution",
      number: fresh.number,
      executionReport: {
        id: execution.id,
        attempt: 1,
        status: "running",
        nativeSessionId: "native-task-7",
      },
    });
    await f.board.execute(f.actor, {
      ...f.command(),
      operation: "update",
      number: fresh.number,
      status: "closed",
    });
    await expect(
      f.board.execute(f.actor, {
        ...f.command(),
        operation: "execution",
        number: fresh.number,
        executionReport: { id: execution.id, attempt: 1, status: "running" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await f.board.execute(f.ownerActor, {
      ...f.command("user"),
      operation: "update",
      number: fresh!.number,
      status: "todo",
    });
    const retry = await f.board.execute(f.actor, {
      ...f.command(),
      operation: "claim",
      number: fresh!.number,
      isolatedExecution: true,
    });
    expect(retry.tasks[0]!.execution?.attempt).toBe(2);
    expect(retry.tasks[0]!.execution?.id).not.toBe(execution.id);
    expect(
      (await f.db.taskExecutionSession.findUniqueOrThrow({ where: { id: execution.id } }))
        .nativeSessionId,
    ).toBe("native-task-7");
  } finally {
    await f.close();
  }
});

test("ordinary channels retain their current task execution behavior", async () => {
  const f = await taskAssignmentFixture("agent");
  try {
    const created = await f.board.execute(f.ownerActor, {
      ...f.command("user"),
      operation: "create",
      title: "Ordinary task",
    });
    const result = await f.board.execute(f.actor, {
      ...f.command(),
      operation: "claim",
      number: created.tasks[0]!.number,
      isolatedExecution: true,
    });
    expect(result.tasks[0]!.execution).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("coordinated task progress stays quiet while review, amendments and closure are targeted", async () => {
  const f = await taskAssignmentFixture("agent");
  try {
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { coordinatorAgentId: f.agent.id },
    });
    const created = await f.board.execute(f.ownerActor, {
      ...f.command("user"),
      operation: "create",
      title: "Isolated evaluation",
    });
    const task = created.tasks[0]!;
    await f.board.execute(f.peerActor, {
      ...f.command(),
      operation: "claim",
      number: task.number,
      isolatedExecution: true,
    });
    const progress = await f.db.$transaction((tx) =>
      channelAgentRecipients(tx, {
        conversationId: f.conversation.id,
        threadRootId: task.messageId,
        mentions: [],
        senderAgentId: f.peerAgent.id,
      }),
    );
    expect(progress).toEqual([]);
    const humanReply = await f.db.$transaction((tx) =>
      channelAgentRecipients(tx, {
        conversationId: f.conversation.id,
        threadRootId: task.messageId,
        mentions: [],
      }),
    );
    expect(humanReply).toEqual([f.peerAgent.id]);
    await f.board.execute(f.peerActor, {
      ...f.command(),
      operation: "update",
      number: task.number,
      status: "in_review",
    });
    let deliveries = await f.db.agentMessageDelivery.findMany({
      where: { conversationId: f.conversation.id },
      include: { message: true },
    });
    expect(
      deliveries.filter(
        (row) => row.agentId === f.agent.id && row.message.threadRootId === task.messageId,
      ),
    ).toHaveLength(1);
    await f.board.execute(f.ownerActor, {
      ...f.command("user"),
      operation: "amend",
      number: task.number,
      description: "Add the held-out evaluation",
    });
    deliveries = await f.db.agentMessageDelivery.findMany({
      where: { conversationId: f.conversation.id },
      include: { message: true },
    });
    expect(
      deliveries.some(
        (row) =>
          row.agentId === f.peerAgent.id &&
          row.taskExecutionSignal &&
          row.message.body.includes("held-out evaluation"),
      ),
    ).toBe(true);
    await f.board.execute(f.ownerActor, {
      ...f.command("user"),
      operation: "update",
      number: task.number,
      status: "closed",
    });
    deliveries = await f.db.agentMessageDelivery.findMany({
      where: { conversationId: f.conversation.id },
      include: { message: true },
    });
    expect(
      deliveries.some(
        (row) =>
          row.agentId === f.peerAgent.id &&
          JSON.stringify(row.taskExecutionSignal).includes('"ended"'),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("terminal controls replay to the daemon without becoming model unread attention", async () => {
  const { f, fresh, execution } = await isolatedTask();
  try {
    await f.board.execute(f.actor, {
      ...f.command(),
      operation: "update",
      number: fresh.number,
      status: "closed",
    });
    const repo = new PrismaDirectConversationRepository(f.db);
    const pending = await repo.readPendingAgentDeliveries(f.workspace.id, f.agent.id);
    const control = pending.find((row) => row.taskExecutionSignal?.kind === "ended")!;
    expect(control.taskExecutionSignal).toEqual({
      executionSessionId: execution.id,
      attempt: 1,
      kind: "ended",
    });
    await f.db.agentMessageDelivery.update({
      where: { deliveryId: control.deliveryId },
      data: { receivedAt: new Date() },
    });
    const recovery = await repo.readAgentRecoveryContext(f.workspace.id, f.agent.id);
    expect(recovery.resumeMessages.some((row) => row.messageId === control.messageId)).toBe(false);
    const target = `#${f.conversation.channelName}:${fresh.messageId}`;
    const unread = await (
      await repo.agentTargetFreshness(f.workspace.id, f.agent.id, target)
    ).readPending(0);
    expect(unread.some((row) => row.id === control.messageId)).toBe(false);
  } finally {
    await f.close();
  }
});

test("amendment and status transition serialize without a conversation/task deadlock", async () => {
  const { f, fresh } = await isolatedTask();
  const firstAmendmentLock = Promise.withResolvers<void>();
  const reportConversationLock = Promise.withResolvers<void>();
  const board = (role: "amend" | "report") =>
    new TaskBoard(
      new Proxy(f.db, {
        get(client, key) {
          if (key !== "$transaction") {
            const value = Reflect.get(client, key);
            return typeof value === "function" ? value.bind(client) : value;
          }
          return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
            client.$transaction(async (tx) => {
              let conversationLocked = false;
              return run(
                new Proxy(tx, {
                  get(transaction, field) {
                    if (field === "$queryRaw")
                      return async (query: TemplateStringsArray, ...values: unknown[]) => {
                        const result = await transaction.$queryRaw(query, ...values);
                        if (
                          query.join("?").includes('"conversations"') &&
                          query.join("?").includes("FOR UPDATE")
                        ) {
                          conversationLocked = true;
                          if (role === "amend") firstAmendmentLock.resolve();
                          else reportConversationLock.resolve();
                        }
                        return result;
                      };
                    if (field === "task" && role === "amend")
                      return new Proxy(transaction.task, {
                        get(tasks, operation) {
                          if (operation === "updateMany")
                            return async (...args: Parameters<typeof tasks.updateMany>) => {
                              const result = await tasks.updateMany(...args);
                              firstAmendmentLock.resolve();
                              if (!conversationLocked) await reportConversationLock.promise;
                              return result;
                            };
                          const value = Reflect.get(tasks, operation);
                          return typeof value === "function" ? value.bind(tasks) : value;
                        },
                      });
                    const value = Reflect.get(transaction, field);
                    return typeof value === "function" ? value.bind(transaction) : value;
                  },
                }),
              );
            });
        },
      }),
    );
  try {
    const amended = board("amend").execute(f.ownerActor, {
      ...f.command("user"),
      operation: "amend",
      number: fresh.number,
      description: "Required held-out evidence",
    });
    await firstAmendmentLock.promise;
    const reported = board("report").execute(f.actor, {
      ...f.command(),
      operation: "update",
      number: fresh.number,
      status: "in_review",
    });
    const [result, transition] = await Promise.all([
      amended,
      reported.catch((error) => {
        // A competing revision may be refused; a database deadlock is never a Task conflict.
        expect(error).toMatchObject({ code: "CONFLICT" });
        return undefined;
      }),
    ]);
    expect(result.tasks[0]!.description).toBe("Required held-out evidence");
    expect(
      (await f.db.task.findUniqueOrThrow({ where: { messageId: fresh.messageId } })).status,
    ).toBe(transition ? "in_review" : "in_progress");
  } finally {
    reportConversationLock.resolve();
    await f.close();
  }
});
