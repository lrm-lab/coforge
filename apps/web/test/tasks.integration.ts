import { expect, test } from "bun:test";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { recordingDeliveries, withPublishBatch } from "./helpers/fake-centrifugo";
import { taskBoardFixture } from "./helpers/task-board-fixture";

test("TaskBoard atomically creates, converts, claims and revision-checks message Tasks", async () => {
  const {
    db,
    alice,
    bob,
    workspace,
    agent,
    channel,
    ordinary,
    realtime,
    board,
    command,
    direct,
    attachment,
    cleanup,
  } = await taskBoardFixture();

  try {
    const { publisher, delivered } = recordingDeliveries();
    const directBoard = new TaskBoard(db, { publisher });
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
        where: { id: directTask.tasks[0]!.messageId! },
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
      publisher: withPublishBatch({
        async publish() {
          throw new Error("offline");
        },
      }),
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
    expect(partial.tasks[0]).toMatchObject({ status: "in_progress", owner: { kind: "agent" } });
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
        messageId: batchClosed.tasks[0]!.messageId!,
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
        messageId: releasedReview.tasks[0]!.messageId!,
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
    // Work moves forward one step at a time, so the Task reaches In review before Done, where the
    // missing resource receipt is what refuses it.
    for (const status of ["in_progress", "in_review"] as const)
      await board.execute(
        { workspaceId: workspace.id, agentId: agent.id },
        {
          operation: "update",
          idempotencyKey: crypto.randomUUID(),
          target: `#${channel.channelName}`,
          number: resource.tasks[0]!.number,
          status,
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
    await cleanup();
  }
});
