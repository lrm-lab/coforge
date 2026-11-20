import { expect, test } from "bun:test";
import { taskAuthorizationFixture } from "./helpers/task-authorization-fixture";

test("TaskBoard enforces conversation authorization, idempotency, and ownership under contention", async () => {
  const {
    db,
    board,
    nextSequence,
    users,
    alice,
    bob,
    mallory,
    workspace,
    agent,
    peerAgent,
    otherWorkspace,
    publicChannel,
    otherChannel,
    direct,
    aliceChannelMember,
    aliceOtherMember,
  } = await taskAuthorizationFixture();
  const ambiguousPrefix = "deadbeef";

  try {
    const seed = await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: publicChannel.id,
        title: "Visible public task",
      },
    );
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: alice!.id },
        {
          operation: "unclaim",
          idempotencyKey: crypto.randomUUID(),
          conversationId: publicChannel.id,
          number: seed.tasks[0]!.number,
        },
      ),
    ).rejects.toThrow("ACCESS_DENIED");

    expect(
      await board.execute(
        { workspaceId: workspace.id, userId: bob!.id },
        {
          operation: "list",
          idempotencyKey: crypto.randomUUID(),
          conversationId: publicChannel.id,
        },
      ),
    ).toEqual({ tasks: seed.tasks });
    for (const operation of ["create", "convert", "claim", "update"] as const) {
      const command =
        operation === "create"
          ? { operation, title: "Unauthorized create" }
          : operation === "convert"
            ? { operation, messageId: seed.tasks[0]!.id }
            : operation === "claim"
              ? { operation, number: seed.tasks[0]!.number }
              : {
                  operation,
                  number: seed.tasks[0]!.number,
                  status: "closed" as const,
                  expectedRevision: seed.tasks[0]!.revision,
                };
      await expect(
        board.execute(
          { workspaceId: workspace.id, userId: bob!.id },
          { ...command, idempotencyKey: crypto.randomUUID(), conversationId: publicChannel.id },
        ),
      ).rejects.toThrow("ACCESS_DENIED");
    }
    await expect(
      board.execute(
        { workspaceId: otherWorkspace.id, userId: mallory!.id },
        {
          operation: "list",
          idempotencyKey: crypto.randomUUID(),
          conversationId: publicChannel.id,
        },
      ),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: bob!.id },
        { operation: "list", idempotencyKey: crypto.randomUUID(), conversationId: direct.id },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
    const unrelatedDirectMember = await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: direct.id, userId: bob!.id },
    });
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: bob!.id },
        { operation: "list", idempotencyKey: crypto.randomUUID(), conversationId: direct.id },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
    await db.conversationMember.delete({ where: { id: unrelatedDirectMember.id } });
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent!.id },
        { operation: "list", idempotencyKey: crypto.randomUUID(), target: `@${bob!.username}` },
      ),
    ).rejects.toThrow("NOT_FOUND");

    const otherRoot = await db.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId: otherChannel.id,
        senderMemberId: aliceOtherMember.id,
        sequence: 1,
        body: "Other channel root",
      },
    });
    const root = await db.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId: publicChannel.id,
        senderMemberId: aliceChannelMember.id,
        sequence: await nextSequence(publicChannel.id),
        body: "Thread root",
      },
    });
    const reply = await db.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId: publicChannel.id,
        senderMemberId: aliceChannelMember.id,
        sequence: await nextSequence(publicChannel.id),
        body: "Thread reply",
        threadRootId: root.id,
      },
    });
    for (const messageId of [otherRoot.id, reply.id]) {
      await expect(
        board.execute(
          { workspaceId: workspace.id, userId: alice!.id },
          {
            operation: "convert",
            idempotencyKey: crypto.randomUUID(),
            conversationId: publicChannel.id,
            messageId,
          },
        ),
      ).rejects.toThrow("NOT_FOUND");
    }
    const ambiguousSequence = await nextSequence(publicChannel.id);
    await db.message.createMany({
      data: [1, 2].map((tail, index) => ({
        id: `${ambiguousPrefix}-0000-4000-8000-00000000000${tail}`,
        workspaceId: workspace.id,
        conversationId: publicChannel.id,
        senderMemberId: aliceChannelMember.id,
        sequence: ambiguousSequence + index,
        body: `Ambiguous ${tail}`,
      })),
    });
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: alice!.id },
        {
          operation: "convert",
          idempotencyKey: crypto.randomUUID(),
          conversationId: publicChannel.id,
          messageId: ambiguousPrefix,
        },
      ),
    ).rejects.toThrow("CONFLICT");

    const directSource = await db.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId: direct.id,
        senderMemberId: direct.members.find((member) => member.userId === alice!.id)!.id,
        sequence: 1,
        body: "Ask the Agent to create a task",
      },
    });
    await db.conversation.update({
      where: { id: direct.id },
      data: { lastSequence: directSource.sequence },
    });
    const agentCreated = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        target: `@${alice!.username}`,
        title: "Agent-owned DM task",
        messageId: directSource.id,
      },
    );
    expect(agentCreated.tasks[0]?.sourceMessageId).toBe(directSource.id);
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, agentId: agent!.id },
          { operation: "list", idempotencyKey: crypto.randomUUID(), target: `@${alice!.username}` },
        )
      ).tasks,
    ).toEqual(agentCreated.tasks);
    const agentClaimed = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
        target: `@${alice!.username}`,
        number: agentCreated.tasks[0]!.number,
      },
    );
    expect(agentClaimed.tasks[0]).toMatchObject({
      status: "in_progress",
      owner: { kind: "agent" },
    });
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent!.id },
        { operation: "list", idempotencyKey: crypto.randomUUID(), target: `@${bob!.username}` },
      ),
    ).rejects.toThrow("NOT_FOUND");

    const requestIds = Array.from({ length: 8 }, () => crypto.randomUUID());
    const concurrent = await Promise.all(
      requestIds.map((requestId, index) =>
        board.execute(
          { workspaceId: workspace.id, userId: alice!.id },
          {
            operation: "create",
            idempotencyKey: requestId,
            conversationId: publicChannel.id,
            title: `Concurrent task ${index}`,
          },
        ),
      ),
    );
    expect(new Set(concurrent.map(({ tasks }) => tasks[0]!.number)).size).toBe(requestIds.length);
    const sameRequest = crypto.randomUUID();
    const duplicated = await Promise.all(
      Array.from({ length: 4 }, () =>
        board.execute(
          { workspaceId: workspace.id, userId: alice!.id },
          {
            operation: "create",
            idempotencyKey: sameRequest,
            conversationId: publicChannel.id,
            title: "One idempotent task",
          },
        ),
      ),
    );
    expect(new Set(duplicated.map(({ tasks }) => tasks[0]!.id)).size).toBe(1);

    const ownership = duplicated[0]!.tasks[0]!;
    const claimed = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownership.number,
      },
    );
    const repeatedClaim = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownership.number,
      },
    );
    expect(repeatedClaim.tasks[0]).toMatchObject({
      revision: claimed.tasks[0]!.revision,
      status: claimed.tasks[0]!.status,
      owner: claimed.tasks[0]!.owner,
    });
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: peerAgent!.id },
        {
          operation: "unclaim",
          idempotencyKey: crypto.randomUUID(),
          target: `#${publicChannel.channelName}`,
          number: ownership.number,
          expectedRevision: claimed.tasks[0]!.revision,
        },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
    const parked = await board.execute(
      { workspaceId: workspace.id, agentId: peerAgent!.id },
      {
        operation: "update",
        idempotencyKey: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownership.number,
        status: "backlog",
        expectedRevision: claimed.tasks[0]!.revision,
      },
    );
    expect(parked.tasks[0]).toMatchObject({
      status: "backlog",
      owner: claimed.tasks[0]!.owner,
      revision: claimed.tasks[0]!.revision + 1,
    });
    const unclaimed = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "unclaim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownership.number,
        expectedRevision: parked.tasks[0]!.revision,
      },
    );
    expect(unclaimed.tasks[0]).toMatchObject({ status: "backlog", owner: null, claimedAt: null });

    const reclaimed = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownership.number,
      },
    );
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent!.id },
        {
          operation: "unclaim",
          idempotencyKey: crypto.randomUUID(),
          target: `#${publicChannel.channelName}`,
          number: ownership.number,
          expectedRevision: claimed.tasks[0]!.revision,
        },
      ),
    ).rejects.toThrow("CONFLICT");
    const afterStaleUnclaim = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "list",
        idempotencyKey: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
      },
    );
    expect(afterStaleUnclaim.tasks.find((task) => task.number === ownership.number)).toMatchObject({
      revision: reclaimed.tasks[0]!.revision,
      status: reclaimed.tasks[0]!.status,
      owner: reclaimed.tasks[0]!.owner,
    });
    const done = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "update",
        idempotencyKey: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownership.number,
        status: "done",
      },
    );
    for (const expectedRevision of [reclaimed.tasks[0]!.revision, done.tasks[0]!.revision]) {
      await expect(
        board.execute(
          { workspaceId: workspace.id, agentId: agent!.id },
          {
            operation: "unclaim",
            idempotencyKey: crypto.randomUUID(),
            target: `#${publicChannel.channelName}`,
            number: ownership.number,
            expectedRevision,
          },
        ),
      ).rejects.toThrow("CONFLICT");
    }
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, agentId: agent!.id },
          {
            operation: "claim",
            idempotencyKey: crypto.randomUUID(),
            target: `#${publicChannel.channelName}`,
            number: ownership.number,
          },
        )
      ).claims,
    ).toEqual([{ number: ownership.number, success: false, reason: "task is done" }]);
    const reset = await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      {
        operation: "update",
        idempotencyKey: crypto.randomUUID(),
        conversationId: publicChannel.id,
        number: ownership.number,
        status: "todo",
        expectedRevision: done.tasks[0]!.revision,
      },
    );
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, agentId: agent!.id },
          {
            operation: "claim",
            idempotencyKey: crypto.randomUUID(),
            target: `#${publicChannel.channelName}`,
            number: ownership.number,
          },
        )
      ).tasks[0],
    ).toMatchObject({ status: "in_progress", revision: reset.tasks[0]!.revision + 1 });

    const raceTask = concurrent[0]!.tasks[0]!;
    const race = await Promise.allSettled(
      ["closed", "done"].map((nextStatus) =>
        board.execute(
          { workspaceId: workspace.id, userId: alice!.id },
          {
            operation: "update",
            idempotencyKey: crypto.randomUUID(),
            conversationId: publicChannel.id,
            number: raceTask.number,
            status: nextStatus as "closed" | "done",
            expectedRevision: raceTask.revision,
          },
        ),
      ),
    );
    expect(race.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(race.filter(({ status }) => status === "rejected")).toHaveLength(1);

    const closedTask = concurrent[2]!.tasks[0]!;
    await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      {
        operation: "update",
        idempotencyKey: crypto.randomUUID(),
        conversationId: publicChannel.id,
        number: closedTask.number,
        status: "closed",
        expectedRevision: closedTask.revision,
      },
    );
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, agentId: agent!.id },
          {
            operation: "claim",
            idempotencyKey: crypto.randomUUID(),
            target: `#${publicChannel.channelName}`,
            number: closedTask.number,
          },
        )
      ).claims,
    ).toEqual([{ number: closedTask.number, success: false, reason: "task is closed" }]);

    const ownerRace = concurrent[1]!.tasks[0]!;
    const ownerClaim = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownerRace.number,
      },
    );
    // No reset to To do here: In progress only goes forward, so the Task stays where the claim
    // left it and the release works from that revision.
    const releaseCommand = {
      operation: "assign" as const,
      idempotencyKey: crypto.randomUUID(),
      conversationId: publicChannel.id,
      number: ownerRace.number,
      assignee: null,
      expectedRevision: ownerClaim.tasks[0]!.revision,
    };
    // Another Agent may not take the Task away from the Agent holding it.
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: peerAgent!.id },
        {
          operation: "assign",
          idempotencyKey: crypto.randomUUID(),
          target: `#${publicChannel.channelName}`,
          number: ownerRace.number,
          assignee: null,
          expectedRevision: ownerClaim.tasks[0]!.revision,
        },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
    // A member needs the current Workspace manager role to release someone else's Task.
    await expect(
      board.execute({ workspaceId: workspace.id, userId: alice!.id }, releaseCommand),
    ).rejects.toThrow("ACCESS_DENIED");
    await db.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: alice!.id } },
      data: { role: "admin" },
    });
    const ownerReleased = await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      releaseCommand,
    );
    expect(ownerReleased.tasks[0]!.owner).toBeNull();
    await board.execute(
      { workspaceId: workspace.id, agentId: peerAgent!.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownerRace.number,
      },
    );
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent!.id },
        {
          operation: "update",
          idempotencyKey: crypto.randomUUID(),
          target: `#${publicChannel.channelName}`,
          number: ownerRace.number,
          status: "done",
          expectedRevision: ownerReleased.tasks[0]!.revision,
        },
      ),
    ).rejects.toThrow("CONFLICT");
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [workspace.id, otherWorkspace.id] } } });
    await db.user.deleteMany({ where: { id: { in: users.map(({ id }) => id) } } });
    await db.$disconnect();
  }
});
