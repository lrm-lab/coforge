import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

test("TaskBoard atomically creates, converts, claims and revision-checks message Tasks", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const handle = suffix.slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `task-alice-${handle}`, username: `task-alice-${handle}` },
  });
  const bob = await db.user.create({
    data: { displayName: `task-bob-${handle}`, username: `task-bob-${handle}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `tasks-${suffix}`,
      name: "Tasks",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
      agents: {
        create: {
          name: `task-agent-${handle}`,
          displayName: "Task Agent",
          ownerId: alice.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  const agent = workspace.agents[0]!;
  const computer = await db.computer.create({
    data: { ownerId: alice.id, machineId: crypto.randomUUID() },
  });
  await db.agent.update({
    where: { id: agent.id },
    data: { computerId: computer.id },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `tasks-${handle}`,
      members: {
        create: [{ userId: alice.id }, { userId: bob.id }, { agentId: agent.id }],
      },
    },
    include: { members: true },
  });
  const aliceMember = channel.members.find((member) => member.userId === alice.id)!;
  const ordinary = await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: channel.id,
      senderMemberId: aliceMember.id,
      sequence: 1,
      body: "Convert this message",
    },
  });
  const realtime: Array<{
    messageId: string;
    publicationId?: string;
    senderUserId?: string;
  }> = [];
  const board = new TaskBoard(db, {
    realtime: {
      async memberChanged() {},
      async messageAvailable(event) {
        realtime.push(event);
      },
    },
  });
  const command = {
    operation: "create" as const,
    idempotencyKey: crypto.randomUUID(),
    conversationId: channel.id,
    title: "Ship Task backend",
  };

  try {
    const direct = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        directKey: [alice.id, agent.id].sort().join(":"),
        members: { create: [{ userId: alice.id }, { agentId: agent.id }] },
      },
    });
    const attachment = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId: direct.id,
        uploaderId: alice.id,
        objectKey: `tasks/${suffix}`,
        fileName: "task.txt",
        contentType: "text/plain",
        sizeBytes: 4,
      },
    });
    const delivered: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
    const directBoard = new TaskBoard(db, {
      publisher: {
        async publish(_channel, payload) {
          delivered.push(decodeAgentMessageDelivery(payload));
        },
      },
    });
    const directTask = await directBoard.execute(
      { workspaceId: workspace.id, userId: alice.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: direct.id,
        title: "DM attachment task",
        attachmentId: attachment.id,
      },
    );
    expect(delivered[0]).toMatchObject({ target: `@${alice.username}` });
    expect(
      await db.message.findUnique({
        where: { id: directTask.tasks[0]!.messageId },
        select: {
          attachments: { select: { id: true } },
          deliveries: { select: { agentId: true } },
        },
      }),
    ).toEqual({
      attachments: [{ id: attachment.id }],
      deliveries: [{ agentId: agent.id }],
    });
    const directResource = await directBoard.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        target: `@${alice.username}`,
        title: "DM temporary resource",
        assignee: `@${agent.name}`,
        createsResource: true,
      },
    );
    const directReceiptCommand = {
      operation: "receipt" as const,
      idempotencyKey: crypto.randomUUID(),
      target: `@${alice.username}`,
      number: directResource.tasks[0]!.number,
      receipt: {
        object: "DM test resource",
        purpose: "verify follow-up target",
        teardownOwner: `@${agent.name}`,
        securityPrivacy: "synthetic local data only",
        expiry: new Date(Date.now() + 86_400_000).toISOString(),
        runbook: "delete it",
        tracking: `task:${directResource.tasks[0]!.messageId}`,
      },
    };
    const directReceipt = await directBoard.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      directReceiptCommand,
    );
    const replayedDirectReceipt = await directBoard.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      directReceiptCommand,
    );
    expect(replayedDirectReceipt.resourceFollowup?.id).toBe(directReceipt.resourceFollowup?.id);
    expect(
      await db.reminder.findUniqueOrThrow({
        where: { id: directReceipt.resourceFollowup!.id },
        select: { target: true },
      }),
    ).toEqual({ target: `@${alice.username}:${directResource.tasks[0]!.messageId}` });

    const created = await board.execute({ workspaceId: workspace.id, userId: alice.id }, command);
    // The Task's message is Alice's own: her other pages do not count it unread.
    expect(realtime).toContainEqual(
      expect.objectContaining({ messageId: created.tasks[0]!.messageId, senderUserId: alice.id }),
    );
    expect(created.tasks[0]).toMatchObject({
      number: 1,
      title: command.title,
      status: "todo",
      revision: 0,
    });
    expect(
      (await board.execute({ workspaceId: workspace.id, userId: alice.id }, command)).tasks[0]
        ?.messageId,
    ).toBe(created.tasks[0]?.messageId);
    expect(
      await db.message.count({
        where: { conversationId: channel.id, body: command.title },
      }),
    ).toBe(1);
    const competingClaims = await Promise.allSettled(
      [alice.id, bob.id].map((userId) =>
        board.execute(
          { workspaceId: workspace.id, userId },
          {
            operation: "claim",
            idempotencyKey: crypto.randomUUID(),
            conversationId: channel.id,
            number: 1,
          },
        ),
      ),
    );
    // Both claims are answered; exactly one of them holds the Task.
    const claimRows = competingClaims.map((settled) =>
      settled.status === "fulfilled" ? settled.value.claims?.[0] : undefined,
    );
    expect(claimRows.filter((claim) => claim?.success)).toHaveLength(1);
    expect(claimRows.filter((claim) => claim && !claim.success)).toHaveLength(1);

    const converted = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "convert",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        messageId: ordinary.id,
      },
    );
    expect(converted.tasks[0]).toMatchObject({
      number: 2,
      messageId: ordinary.id,
      title: ordinary.body,
    });
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, agentId: agent.id },
          {
            operation: "claim",
            idempotencyKey: crypto.randomUUID(),
            target: `#${channel.channelName}`,
            number: 2,
          },
        )
      ).tasks[0],
    ).toMatchObject({
      status: "in_progress",
      revision: 1,
      owner: { kind: "agent" },
    });

    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, userId: bob.id },
          {
            operation: "claim",
            idempotencyKey: crypto.randomUUID(),
            conversationId: channel.id,
            number: 2,
          },
        )
      ).claims,
    ).toEqual([
      expect.objectContaining({
        number: 2,
        success: false,
        reason: "already claimed",
        conflict: expect.objectContaining({ currentAssignee: { type: "agent", name: agent.name } }),
      }),
    ]);
    const review = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "update",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: 2,
        status: "in_review",
        expectedRevision: 1,
      },
    );
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent.id },
        {
          operation: "update",
          idempotencyKey: crypto.randomUUID(),
          target: `#${channel.channelName}`,
          number: 2,
          status: "done",
          expectedRevision: 1,
        },
      ),
    ).rejects.toThrow("CONFLICT");
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, agentId: agent.id },
          {
            operation: "update",
            idempotencyKey: crypto.randomUUID(),
            target: `#${channel.channelName}`,
            number: 2,
            status: "done",
            expectedRevision: review.tasks[0]!.revision,
          },
        )
      ).tasks[0]?.status,
    ).toBe("done");
    expect(realtime.some((event) => event.publicationId?.endsWith(":task:1"))).toBe(true);
    expect(realtime.some((event) => event.publicationId?.endsWith(":task:2"))).toBe(true);

    const unowned = await board.execute(
      { workspaceId: workspace.id, userId: alice.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        title: "Close without claiming",
      },
    );
    const closed = await board.execute(
      { workspaceId: workspace.id, userId: alice.id },
      {
        operation: "update",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        number: unowned.tasks[0]!.number,
        status: "closed",
        expectedRevision: 0,
      },
    );
    expect(closed.tasks[0]).toMatchObject({ status: "closed", owner: null });
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, userId: bob.id },
          {
            operation: "update",
            idempotencyKey: crypto.randomUUID(),
            conversationId: channel.id,
            number: closed.tasks[0]!.number,
            status: "todo",
            expectedRevision: closed.tasks[0]!.revision,
          },
        )
      ).tasks[0],
    ).toMatchObject({ status: "todo", owner: null });

    const postCommitCommand = {
      operation: "create" as const,
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      title: "Committed despite side-effect failures",
    };
    const failingSideEffects = new TaskBoard(db, {
      notifications: {
        async notifyMessage() {
          throw new Error("offline");
        },
      },
      realtime: {
        async memberChanged() {},
        async messageAvailable() {
          throw new Error("offline");
        },
      },
      publisher: {
        async publish() {
          throw new Error("offline");
        },
      },
    });
    const committed = await failingSideEffects.execute(
      { workspaceId: workspace.id, userId: alice.id },
      postCommitCommand,
    );
    const recovered = await failingSideEffects.execute(
      { workspaceId: workspace.id, userId: alice.id },
      postCommitCommand,
    );
    expect(recovered.tasks[0]!.messageId).toBe(committed.tasks[0]!.messageId);
    expect(
      await db.task.count({
        where: { requestId: postCommitCommand.idempotencyKey },
      }),
    ).toBe(1);

    const beforeInvalidBatch = await db.task.count({
      where: { conversationId: channel.id },
    });
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: alice.id },
        {
          operation: "create",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          title: "mixed singular",
          titles: ["mixed batch"],
        },
      ),
    ).rejects.toThrow("INVALID_INPUT");
    expect(await db.task.count({ where: { conversationId: channel.id } })).toBe(beforeInvalidBatch);

    const batch = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        titles: ["batch one", "batch two"],
        assignee: `@${agent.name}`,
      },
    );
    expect(batch.tasks).toHaveLength(2);
    expect(batch.tasks.every((task) => task.status === "in_progress")).toBe(true);
    expect(batch.assignmentReceipt).toMatchObject({
      state: "started",
      assignee: `@${agent.name}`,
    });
    expect(batch.assignmentReceipt!.messageId).not.toBe(batch.tasks[0]!.messageId);
    const assignmentMessage = await db.message.findUniqueOrThrow({
      where: { id: batch.assignmentReceipt!.messageId },
      include: { deliveries: true },
    });
    expect(assignmentMessage.senderMemberId).toBeNull();
    expect(assignmentMessage.body).toBe(batch.assignmentReceipt!.content);
    // An Agent that assigns itself already holds the receipt in its command result; delivering
    // it too would wake the Agent with its own action.
    expect(assignmentMessage.deliveries).toEqual([]);
    expect(batch.tasks[0]!.claimedAt).toEqual(expect.any(String));
    const allTasks = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "list",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        status: "all",
      },
    );
    expect(allTasks.tasks).toEqual(expect.arrayContaining(batch.tasks));
    const batchClosed = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "update",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: batch.tasks[1]!.number,
        status: "closed",
      },
    );
    const releasedClosed = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "unclaim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: batchClosed.tasks[0]!.number,
      },
    );
    expect(releasedClosed.tasks[0]).toMatchObject({
      status: "closed",
      owner: null,
      claimedAt: null,
    });

    const releasedReview = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "update",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: batch.tasks[0]!.number,
        status: "in_review",
      },
    );
    await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "unclaim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: releasedReview.tasks[0]!.number,
      },
    );
    const partial = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        numbers: [releasedReview.tasks[0]!.number, batchClosed.tasks[0]!.number],
      },
    );
    expect(partial.tasks[0]).toMatchObject({
      status: "in_review",
      owner: { kind: "agent" },
    });
    expect(partial.claims).toEqual([
      expect.objectContaining({
        number: releasedReview.tasks[0]!.number,
        success: true,
      }),
      expect.objectContaining({
        number: batchClosed.tasks[0]!.number,
        success: false,
      }),
    ]);
    const mixedSelectors = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: releasedReview.tasks[0]!.number,
        numbers: [releasedReview.tasks[0]!.number],
        messageId: batchClosed.tasks[0]!.messageId,
      },
    );
    expect(mixedSelectors.claims).toEqual([
      expect.objectContaining({
        number: releasedReview.tasks[0]!.number,
        success: true,
      }),
      expect.objectContaining({
        messageId: batchClosed.tasks[0]!.messageId,
        success: false,
      }),
    ]);
    const singleClaim = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: releasedReview.tasks[0]!.number,
      },
    );
    expect(singleClaim.claims).toEqual([
      {
        number: releasedReview.tasks[0]!.number,
        messageId: releasedReview.tasks[0]!.messageId,
        success: true,
      },
    ]);
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, agentId: agent.id },
          {
            operation: "claim",
            idempotencyKey: crypto.randomUUID(),
            target: `#${channel.channelName}`,
            numbers: [batchClosed.tasks[0]!.number],
          },
        )
      ).claims,
    ).toEqual([{ number: batchClosed.tasks[0]!.number, success: false, reason: "task is closed" }]);
    for (const changes of [
      { title: "   " },
      { title: "x".repeat(10_001) },
      { description: "x".repeat(50_001) },
    ]) {
      await expect(
        board.execute(
          { workspaceId: workspace.id, userId: alice.id },
          {
            operation: "amend",
            idempotencyKey: crypto.randomUUID(),
            conversationId: channel.id,
            number: batch.tasks[1]!.number,
            ...changes,
          },
        ),
      ).rejects.toThrow("INVALID_INPUT");
    }

    const amendment = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "amend",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: batch.tasks[1]!.number,
        title: "batch two amended",
        description: "exact acceptance criteria",
        expectedRevision: releasedClosed.tasks[0]!.revision,
      },
    );
    expect(amendment.history?.[0]).toMatchObject({
      eventType: "amended",
      payload: {
        changes: {
          title: { from: "batch two", to: "batch two amended" },
          description: { from: null, to: "exact acceptance criteria" },
        },
      },
    });
    const amendmentRace = await Promise.allSettled(
      ["writer a", "writer b"].map((title) =>
        board.execute(
          { workspaceId: workspace.id, agentId: agent.id },
          {
            operation: "amend",
            idempotencyKey: crypto.randomUUID(),
            target: `#${channel.channelName}`,
            number: batch.tasks[1]!.number,
            title,
            expectedRevision: amendment.tasks[0]!.revision,
          },
        ),
      ),
    );
    expect(amendmentRace.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);

    const resource = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        title: "temporary resource",
        assignee: `@${agent.name}`,
        createsResource: true,
      },
    );
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent.id },
        {
          operation: "update",
          idempotencyKey: crypto.randomUUID(),
          target: `#${channel.channelName}`,
          number: resource.tasks[0]!.number,
          status: "done",
        },
      ),
    ).rejects.toThrow("CONFLICT");
    const receipt = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "receipt",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: resource.tasks[0]!.number,
        receipt: {
          object: "temporary test database",
          purpose: "integration verification",
          teardownOwner: `@${agent.name}`,
          securityPrivacy: "synthetic local data only",
          expiry: new Date(Date.now() + 86_400_000).toISOString(),
          runbook: "drop the temporary database",
          tracking: `task:${resource.tasks[0]!.messageId}`,
        },
      },
    );
    expect(receipt.resourceFollowup).toMatchObject({ ownerAgentId: agent.id });
    expect(receipt.tasks[0]).toMatchObject({
      requiresResourceReceipt: true,
      resourceReceiptRecordedAt: expect.any(String),
      resourceReceipt: expect.objectContaining({
        object: "temporary test database",
      }),
    });
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, agentId: agent.id },
          {
            operation: "update",
            idempotencyKey: crypto.randomUUID(),
            target: `#${channel.channelName}`,
            number: resource.tasks[0]!.number,
            status: "done",
          },
        )
      ).tasks[0]!.status,
    ).toBe("done");

    const deleted = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        title: "deleted number must stay reserved",
      },
    );
    await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "delete",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: deleted.tasks[0]!.number,
      },
    );
    const afterDelete = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        title: "number after deletion",
      },
    );
    expect(afterDelete.tasks[0]!.number).toBe(deleted.tasks[0]!.number + 1);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.delete({ where: { id: computer.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});

test("a created Task's title stores its references as tokens, and its own mention rows decide who a muted channel wakes", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const human = await db.user.create({
    data: { displayName: `tokens-${suffix}`, username: `tokens-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-tokens-${suffix}`,
      name: "Task tokens",
      members: { create: { userId: human.id, role: "owner" } },
      agents: {
        create: ["helper", "quiet", "open"].map((name) => ({
          name: `${name}-${suffix}`,
          displayName: name,
          ownerId: human.id,
          runtimeConfig: {},
        })),
      },
    },
    include: { agents: true },
  });
  const agentNamed = (name: string) =>
    workspace.agents.find((agent) => agent.name === `${name}-${suffix}`)!;
  const [helper, quiet, open] = [agentNamed("helper"), agentNamed("quiet"), agentNamed("open")];
  const computer = await db.computer.create({
    data: { ownerId: human.id, machineId: crypto.randomUUID() },
  });
  await db.agent.updateMany({
    where: { workspaceId: workspace.id },
    data: { computerId: computer.id },
  });
  try {
    const product = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: `product-${suffix}` },
    });
    const channel = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `work-${suffix}`,
        members: {
          create: [
            { userId: human.id },
            { agentId: helper.id, channelMuted: true },
            { agentId: quiet.id, channelMuted: true },
            { agentId: open.id },
          ],
        },
      },
    });
    const published: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
    const board = new TaskBoard(db, {
      publisher: {
        async publish(_channel, payload) {
          published.push(decodeAgentMessageDelivery(payload));
        },
      },
    });
    const principal = { workspaceId: workspace.id, userId: human.id };
    const existing = (
      await board.execute(principal, {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        title: "Existing task",
      })
    ).tasks[0]!;
    published.length = 0;

    const created = await board.execute(principal, {
      operation: "create",
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      titles: [
        `@${helper.name} see #product-${suffix} and task #${existing.number}`,
        `not \`@${quiet.name}\` nor [ask @${quiet.name}](https://example.com)`,
      ],
      assignee: `@${helper.name}`,
    });
    const [referencing, codeOnly] = created.tasks;
    const rows = await db.message.findMany({
      where: { id: { in: [referencing!.messageId, codeOnly!.messageId] } },
      orderBy: { sequence: "asc" },
      select: {
        body: true,
        task: { select: { title: true } },
        mentions: { select: { actorId: true } },
        deliveries: { select: { agentId: true } },
      },
    });

    // The Task's message stores its references as tokens, and the Task keeps that same body as its
    // title, as a converted Task keeps its message's.
    const tokenized = `<@agent:${helper.id}> see <@channel:${product.id}:product-${suffix}> and <@task:${existing.number}>`;
    expect(rows.map((row) => [row.body, row.task!.title])).toEqual([
      [tokenized, tokenized],
      [
        `not \`@${quiet.name}\` nor [ask @${quiet.name}](https://example.com)`,
        `not \`@${quiet.name}\` nor [ask @${quiet.name}](https://example.com)`,
      ],
    ]);
    expect(rows.map((row) => row.mentions.map((mention) => mention.actorId))).toEqual([
      [helper.id],
      [],
    ]);
    // Every reader still sees text.
    const readable = `@${helper.name} see #product-${suffix} and task #${existing.number}`;
    expect(referencing!.title).toBe(readable);
    const notice = await db.message.findFirstOrThrow({
      where: { conversationId: channel.id, senderMemberId: null, body: { contains: "created" } },
      orderBy: { sequence: "desc" },
      select: { body: true },
    });
    expect(notice.body).toContain(`"${readable}"`);
    expect(notice.body).not.toContain("<@");

    // Each Task's message wakes every unmuted Agent, plus a muted Agent its own mention rows name.
    // The quiet Agent, written only in code and a link label, stays muted.
    expect(rows.map((row) => row.deliveries.map((delivery) => delivery.agentId).sort())).toEqual([
      [helper.id, open.id].sort(),
      [open.id],
    ]);
    const taskPayloads = published.filter(
      (payload) => payload.messageId === referencing!.messageId,
    );
    expect(taskPayloads.map((payload) => [payload.agentId, payload.body]).sort()).toEqual(
      [
        [helper.id, readable],
        [open.id, readable],
      ].sort(),
    );

    // The assignment receipt is unchanged: top level in the conversation, delivered only to the
    // assignee, on the conversation's own target.
    const receipt = await db.message.findUniqueOrThrow({
      where: { id: created.assignmentReceipt!.messageId },
      select: { threadRootId: true, deliveries: { select: { agentId: true } } },
    });
    expect(receipt).toEqual({ threadRootId: null, deliveries: [{ agentId: helper.id }] });
    expect(
      published
        .filter((payload) => payload.messageId === created.assignmentReceipt!.messageId)
        .map((payload) => [payload.agentId, payload.target]),
    ).toEqual([[helper.id, `#${channel.channelName}`]]);

    // Amending compares titles as they read: re-sending the same readable title changes nothing
    // (no history, tokens kept), and a real change is recorded in readable form.
    const amend = (title: string) =>
      board.execute(principal, {
        operation: "amend",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        number: referencing!.number,
        title,
      });
    const unchanged = await amend(readable);
    expect(unchanged.history ?? []).toEqual([]);
    expect(unchanged.tasks[0]!.title).toBe(readable);
    expect(
      (await db.task.findUniqueOrThrow({ where: { messageId: referencing!.messageId } })).title,
    ).toBe(tokenized);
    const renamed = await amend("A new title");
    expect(renamed.history).toEqual([
      expect.objectContaining({
        eventType: "amended",
        payload: expect.objectContaining({
          changes: { title: { from: readable, to: "A new title" } },
        }),
      }),
    ]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.delete({ where: { id: computer.id } });
    await db.user.delete({ where: { id: human.id } });
    await db.$disconnect();
  }
});

test("converting by an eight-character message id finds only that channel's top-level message, in any case, and refuses an ambiguous one", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const human = await db.user.create({
    data: { displayName: `short-id-${suffix}`, username: `short-id-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-short-id-${suffix}`,
      name: "Task short ids",
      members: { create: { userId: human.id, role: "owner" } },
    },
  });
  try {
    const [channel, other] = await Promise.all(
      ["work", "other"].map((name) =>
        db.conversation.create({
          data: {
            workspaceId: workspace.id,
            channelName: `${name}-${suffix}`,
            members: { create: { userId: human.id } },
          },
          include: { members: true },
        }),
      ),
    );
    // Ids that share a first eight characters, built so each prefix below names a known set.
    const id = (prefix: string, tail: string) =>
      `${prefix}-0000-4000-8000-${tail.padStart(12, "0")}`;
    const post = (
      conversation: typeof channel,
      messageId: string,
      sequence: number,
      threadRootId?: string,
    ) =>
      db.message.create({
        data: {
          id: messageId,
          workspaceId: workspace.id,
          conversationId: conversation!.id,
          senderMemberId: conversation!.members[0]!.id,
          sequence,
          body: `Message ${sequence}`,
          threadRootId,
        },
      });
    const unique = await post(channel, id("abcdef01", "1"), 1);
    // The same prefix as a reply here and as a top-level message elsewhere names nothing extra.
    await post(channel, id("abcdef01", "2"), 2, unique.id);
    await post(other, id("abcdef01", "3"), 1);
    await post(channel, id("abcdef02", "1"), 3);
    await post(channel, id("abcdef02", "2"), 4);

    const board = new TaskBoard(db);
    const convert = (messageId: string) =>
      board.execute(
        { workspaceId: workspace.id, userId: human.id },
        {
          operation: "convert",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel!.id,
          messageId,
        },
      );
    expect((await convert("ABCDEF01")).tasks[0]).toMatchObject({ messageId: unique.id });
    await expect(convert("abcdef02")).rejects.toThrow("CONFLICT");
    await expect(convert("abcdef03")).rejects.toThrow("NOT_FOUND");
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: human.id } });
    await db.$disconnect();
  }
});
