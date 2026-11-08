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

    const done = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "update",
        number: created.number,
        status: "done",
        expectedRevision: created.revision,
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

    const done = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "update",
        number: created.number,
        status: "done",
        expectedRevision: created.revision,
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

    const done = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "update",
        number: created.number,
        status: "done",
        expectedRevision: created.revision,
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
