import { expect, test } from "bun:test";
import { taskAssignmentFixture } from "./helpers/task-assignment-fixture";

test("a done Task refuses unassign and assign-to-empty until its status changes", async () => {
  const f = await taskAssignmentFixture("user", "owner");
  try {
    const created = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "create",
        title: "Finished work",
        assignee: `@${f.agent.name}`,
      })
    ).tasks[0]!;
    const done = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "update",
        number: created.number,
        status: "done",
        expectedRevision: created.revision,
      })
    ).tasks[0]!;
    expect(done).toMatchObject({ status: "done", owner: { id: f.agent.id } });

    await expect(
      f.board.execute(f.actor, {
        ...f.command(),
        operation: "unassign",
        number: done.number,
        expectedRevision: done.revision,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      f.board.execute(f.actor, {
        ...f.command(),
        operation: "assign",
        number: done.number,
        assignee: null,
        expectedRevision: done.revision,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const after = await f.db.task.findFirstOrThrow({
      where: { conversationId: f.conversation.id, number: done.number },
    });
    expect(after.status).toBe("done");
    expect(after.ownerMemberId).not.toBeNull();
  } finally {
    await f.close();
  }
});

test("a closed Task may still lose its owner", async () => {
  const f = await taskAssignmentFixture("user", "owner");
  try {
    const created = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "create",
        title: "Closed work",
        assignee: `@${f.agent.name}`,
      })
    ).tasks[0]!;
    const closed = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "update",
        number: created.number,
        status: "closed",
        expectedRevision: created.revision,
      })
    ).tasks[0]!;
    const unassigned = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "unassign",
        number: closed.number,
        expectedRevision: closed.revision,
      })
    ).tasks[0]!;
    expect(unassigned).toMatchObject({ status: "closed", owner: null });
  } finally {
    await f.close();
  }
});

test("reopening a done Task to In Progress restarts its Agent's execution session", async () => {
  const f = await taskAssignmentFixture("user", "owner");
  try {
    const created = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "create",
        title: "Reopened work",
        assignee: `@${f.agent.name}`,
      })
    ).tasks[0]!;
    const row = await f.db.task.findFirstOrThrow({
      where: { conversationId: f.conversation.id, number: created.number },
    });
    const sessionOf = () =>
      f.db.taskExecutionSession.findUniqueOrThrow({
        where: { taskId_agentId: { taskId: row.id, agentId: f.agent.id } },
      });

    const started = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "update",
        number: created.number,
        status: "in_progress",
        expectedRevision: created.revision,
      })
    ).tasks[0]!;
    const done = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "update",
        number: started.number,
        status: "done",
        expectedRevision: started.revision,
      })
    ).tasks[0]!;
    expect((await sessionOf()).status).toBe("completed");

    await f.board.execute(f.actor, {
      ...f.command(),
      operation: "update",
      number: done.number,
      status: "in_progress",
      expectedRevision: done.revision,
    });
    const session = await sessionOf();
    expect(session.status).toBe("starting");
    expect(session.attempt).toBe(2);
  } finally {
    await f.close();
  }
});

test("a multi-hop reopen to In Progress also restarts the Agent's session", async () => {
  const f = await taskAssignmentFixture("user", "owner");
  try {
    const created = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "create",
        title: "Sent-back work",
        assignee: `@${f.agent.name}`,
      })
    ).tasks[0]!;
    const row = await f.db.task.findFirstOrThrow({
      where: { conversationId: f.conversation.id, number: created.number },
    });
    const sessionOf = () =>
      f.db.taskExecutionSession.findUniqueOrThrow({
        where: { taskId_agentId: { taskId: row.id, agentId: f.agent.id } },
      });

    const started = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "update",
        number: created.number,
        status: "in_progress",
        expectedRevision: created.revision,
      })
    ).tasks[0]!;
    const done = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "update",
        number: started.number,
        status: "done",
        expectedRevision: started.revision,
      })
    ).tasks[0]!;
    const inReview = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "update",
        number: done.number,
        status: "in_review",
        expectedRevision: done.revision,
      })
    ).tasks[0]!;
    expect((await sessionOf()).status).toBe("completed");

    await f.board.execute(f.actor, {
      ...f.command(),
      operation: "update",
      number: inReview.number,
      status: "in_progress",
      expectedRevision: inReview.revision,
    });
    const session = await sessionOf();
    expect(session.status).toBe("starting");
    expect(session.attempt).toBe(2);
  } finally {
    await f.close();
  }
});

test("reopening a done Task to Todo leaves its Agent's session completed", async () => {
  const f = await taskAssignmentFixture("user", "owner");
  try {
    const created = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "create",
        title: "Withdrawn work",
        assignee: `@${f.agent.name}`,
      })
    ).tasks[0]!;
    const row = await f.db.task.findFirstOrThrow({
      where: { conversationId: f.conversation.id, number: created.number },
    });
    const sessionOf = () =>
      f.db.taskExecutionSession.findUniqueOrThrow({
        where: { taskId_agentId: { taskId: row.id, agentId: f.agent.id } },
      });

    const started = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "update",
        number: created.number,
        status: "in_progress",
        expectedRevision: created.revision,
      })
    ).tasks[0]!;
    const done = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "update",
        number: started.number,
        status: "done",
        expectedRevision: started.revision,
      })
    ).tasks[0]!;
    await f.board.execute(f.actor, {
      ...f.command(),
      operation: "update",
      number: done.number,
      status: "todo",
      expectedRevision: done.revision,
    });
    expect((await sessionOf()).status).toBe("completed");
  } finally {
    await f.close();
  }
});

test("creating a Task reserved for an Agent opens no execution session", async () => {
  const f = await taskAssignmentFixture("user", "owner");
  try {
    const created = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "create",
        title: "Reserved work",
        assignee: `@${f.agent.name}`,
      })
    ).tasks[0]!;
    expect(created).toMatchObject({ status: "todo", owner: { id: f.agent.id } });
    const row = await f.db.task.findFirstOrThrow({
      where: { conversationId: f.conversation.id, number: created.number },
    });
    // A reserved Todo Task's Agent works nothing yet: the session opens when it is In Progress.
    expect(
      await f.db.taskExecutionSession.findMany({
        where: { taskId: row.id, agentId: f.agent.id },
      }),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("an Agent claiming its reserved Task opens the execution session", async () => {
  const f = await taskAssignmentFixture("user", "owner");
  try {
    const created = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "create",
        title: "Claimed work",
        assignee: `@${f.agent.name}`,
      })
    ).tasks[0]!;
    expect(created.status).toBe("todo");
    const row = await f.db.task.findFirstOrThrow({
      where: { conversationId: f.conversation.id, number: created.number },
    });
    expect(await f.db.taskExecutionSession.findMany({ where: { taskId: row.id } })).toHaveLength(0);

    const claimed = (
      await f.board.execute(
        { workspaceId: f.workspace.id, agentId: f.agent.id },
        { ...f.command("agent"), operation: "claim", number: created.number },
      )
    ).tasks[0]!;
    expect(claimed.status).toBe("in_progress");
    expect(
      (
        await f.db.taskExecutionSession.findUniqueOrThrow({
          where: { taskId_agentId: { taskId: row.id, agentId: f.agent.id } },
        })
      ).status,
    ).toBe("starting");
  } finally {
    await f.close();
  }
});

test("assigning an Agent outside In Progress opens no execution session", async () => {
  const f = await taskAssignmentFixture("user", "owner");
  try {
    const human = `@${f.peer.username}`;
    const cases: { title: string; status?: "done" | "closed" }[] = [
      { title: "Todo work" },
      { title: "Finished work", status: "done" },
      { title: "Closed work", status: "closed" },
    ];
    for (const { title, status } of cases) {
      const created = (
        await f.board.execute(f.actor, {
          ...f.command(),
          operation: "create",
          title,
          assignee: human,
        })
      ).tasks[0]!;
      let current = created;
      if (status)
        current = (
          await f.board.execute(f.actor, {
            ...f.command(),
            operation: "update",
            number: created.number,
            status,
            expectedRevision: created.revision,
          })
        ).tasks[0]!;
      const assigned = (
        await f.board.execute(f.actor, {
          ...f.command(),
          operation: "assign",
          number: current.number,
          assignee: `@${f.agent.name}`,
          expectedRevision: current.revision,
        })
      ).tasks[0]!;
      expect(assigned.owner?.id).toBe(f.agent.id);
      const row = await f.db.task.findFirstOrThrow({
        where: { conversationId: f.conversation.id, number: assigned.number },
      });
      expect(
        await f.db.taskExecutionSession.findMany({
          where: { taskId: row.id, agentId: f.agent.id },
        }),
      ).toHaveLength(0);
    }
  } finally {
    await f.close();
  }
});

test("reassigning an In Review Task cancels the old Agent's session and opens none", async () => {
  const f = await taskAssignmentFixture("user", "owner");
  try {
    const created = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "create",
        title: "Handed-over work",
        assignee: `@${f.agent.name}`,
      })
    ).tasks[0]!;
    const row = await f.db.task.findFirstOrThrow({
      where: { conversationId: f.conversation.id, number: created.number },
    });
    const started = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "update",
        number: created.number,
        status: "in_progress",
        expectedRevision: created.revision,
      })
    ).tasks[0]!;
    const inReview = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "update",
        number: started.number,
        status: "in_review",
        expectedRevision: started.revision,
      })
    ).tasks[0]!;

    await f.board.execute(f.actor, {
      ...f.command(),
      operation: "assign",
      number: inReview.number,
      assignee: `@${f.peerAgent.name}`,
      expectedRevision: inReview.revision,
    });
    const oldSession = await f.db.taskExecutionSession.findUniqueOrThrow({
      where: { taskId_agentId: { taskId: row.id, agentId: f.agent.id } },
    });
    expect(oldSession.status).toBe("cancelled");
    expect(
      await f.db.taskExecutionSession.findMany({
        where: { taskId: row.id, agentId: f.peerAgent.id },
      }),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("an Agent re-claiming its In Review Task repairs no execution session", async () => {
  const f = await taskAssignmentFixture("agent", "owner");
  try {
    const created = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "create",
        title: "Reviewing work",
        assignee: `@${f.agent.name}`,
      })
    ).tasks[0]!;
    expect(created.status).toBe("in_progress");
    const row = await f.db.task.findFirstOrThrow({
      where: { conversationId: f.conversation.id, number: created.number },
    });
    const inReview = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "update",
        number: created.number,
        status: "in_review",
        expectedRevision: created.revision,
      })
    ).tasks[0]!;
    // A session that never existed (or was swept) is only repaired while the Task is In Progress.
    await f.db.taskExecutionSession.deleteMany({ where: { taskId: row.id } });

    await f.board.execute(f.actor, {
      ...f.command(),
      operation: "claim",
      number: inReview.number,
    });
    expect(await f.db.taskExecutionSession.findMany({ where: { taskId: row.id } })).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("reassigning an In Progress Task moves the execution session to the new Agent", async () => {
  const f = await taskAssignmentFixture("user", "owner");
  try {
    const created = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "create",
        title: "Live handoff",
        assignee: `@${f.agent.name}`,
      })
    ).tasks[0]!;
    const row = await f.db.task.findFirstOrThrow({
      where: { conversationId: f.conversation.id, number: created.number },
    });
    const started = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "update",
        number: created.number,
        status: "in_progress",
        expectedRevision: created.revision,
      })
    ).tasks[0]!;

    await f.board.execute(f.actor, {
      ...f.command(),
      operation: "assign",
      number: started.number,
      assignee: `@${f.peerAgent.name}`,
      expectedRevision: started.revision,
    });
    expect(
      (
        await f.db.taskExecutionSession.findUniqueOrThrow({
          where: { taskId_agentId: { taskId: row.id, agentId: f.agent.id } },
        })
      ).status,
    ).toBe("cancelled");
    expect(
      (
        await f.db.taskExecutionSession.findUniqueOrThrow({
          where: { taskId_agentId: { taskId: row.id, agentId: f.peerAgent.id } },
        })
      ).status,
    ).toBe("starting");
  } finally {
    await f.close();
  }
});
