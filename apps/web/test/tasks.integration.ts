import { expect, test } from "bun:test";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { withPublishBatch } from "./helpers/fake-centrifugo";
import { taskBoardFixture } from "./helpers/task-board-fixture";
import { legacyMessageTask } from "./fixtures/legacy-message-task";

test("TaskBoard creates, converts, claims and revision-checks Tasks", async () => {
  const { db, alice, bob, workspace, agent, channel, ordinary, board, command, cleanup } =
    await taskBoardFixture();

  try {
    const created = await board.execute({ workspaceId: workspace.id, userId: alice.id }, command);
    expect(created.tasks[0]).toMatchObject({
      number: 1,
      title: command.title,
      status: "todo",
      revision: 0,
    });
    expect(
      (await board.execute({ workspaceId: workspace.id, userId: alice.id }, command)).tasks[0]?.id,
    ).toBe(created.tasks[0]?.id);
    expect(
      await db.task.count({ where: { conversationId: channel.id, title: command.title } }),
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
      { workspaceId: workspace.id, userId: alice.id },
      {
        operation: "convert",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        messageId: ordinary.id,
      },
    );
    expect(converted.tasks[0]).toMatchObject({
      number: 2,
      sourceMessageId: ordinary.id,
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
    expect(recovered.tasks[0]!.id).toBe(committed.tasks[0]!.id);
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
    expect(allTasks.tasks).toEqual(
      expect.arrayContaining(
        batch.tasks.map((task) => expect.objectContaining({ id: task.id, number: task.number })),
      ),
    );
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
      { number: releasedReview.tasks[0]!.number, success: true },
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

    const agentSeat = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: channel.id, agentId: agent.id },
    });
    const aliceSeat = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: channel.id, userId: alice.id },
    });
    // A Task from before task conversations that needs a resource receipt: the receipt's follow-up
    // is anchored to the Task's message.
    const resource = {
      tasks: [
        (
          await legacyMessageTask(db, {
            conversationId: channel.id,
            workspaceId: workspace.id,
            creatorMemberId: aliceSeat.id,
            ownerMemberId: agentSeat.id,
            title: "temporary resource",
          })
        ).task,
      ],
    };
    await db.task.update({ where: { id: resource.tasks[0]!.id }, data: { createsResource: true } });
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
