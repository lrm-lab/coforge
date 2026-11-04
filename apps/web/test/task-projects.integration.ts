import { expect, test } from "bun:test";
import { setup } from "./fixtures/task-dependencies";

/**
 * A Task's Project against real PostgreSQL (task #484): a Task carries only its own — a channel
 * lends none, a sub-task inherits its parent's, a person's last-used one is her default, and
 * --project/--clear-project always win.
 */

test("a task carries only its own project: the channel lends none, a sub-task inherits its parent's, and amend sets or clears it", async () => {
  const { db, run, make, show, principals, channel, refusal } = await setup();
  try {
    const workspaceId = principals.alice.workspaceId;
    const suffix = crypto.randomUUID().slice(0, 8);
    const alpha = await db.project.create({
      data: { workspaceId, name: "Alpha", slug: `alpha-${suffix}` },
    });
    const beta = await db.project.create({
      data: { workspaceId, name: "Beta", slug: `beta-${suffix}` },
    });
    // The channel's own projectId (until release 2 removes the column) never lends.
    await db.conversation.update({
      where: { id: channel.id },
      data: { projectId: alpha.id },
    });

    const [number] = await make("alice", 1);
    expect((await show(number!)).tasks[0]!.project).toBeNull();

    // The one named on create files it; a sub-task without one inherits its parent's, and an
    // explicit --project still wins.
    const [pinned] = await make("alice", 1, { project: alpha.slug });
    expect((await show(pinned!)).tasks[0]!.project).toEqual({
      id: alpha.id,
      name: "Alpha",
      slug: alpha.slug,
    });
    const [child] = await make("alice", 1, { parent: { number: pinned! } });
    expect((await show(child!)).tasks[0]!.project?.id).toBe(alpha.id);
    const [overridden] = await make("alice", 1, {
      parent: { number: pinned! },
      project: beta.slug,
    });
    expect((await show(overridden!)).tasks[0]!.project?.id).toBe(beta.id);

    // Amend moves it, and --clear-project leaves it in none — it does not refollow anything.
    await run("alice", { operation: "amend", number: pinned!, project: beta.slug });
    expect((await show(pinned!)).tasks[0]!.project?.id).toBe(beta.id);
    await run("alice", { operation: "amend", number: pinned!, project: null });
    expect((await show(pinned!)).tasks[0]!.project).toBeNull();

    const history = await run("alice", { operation: "history", number: pinned! });
    const changes = history.history!.filter((event) => event.eventType === "project_changed");
    expect(changes.map((event) => event.eventType)).toEqual([
      "project_changed",
      "project_changed",
      "project_changed",
    ]);
    expect(changes[0]!.payload).toEqual({
      from: null,
      to: { id: alpha.id, name: "Alpha", slug: alpha.slug },
    });
    expect(changes.at(-1)!.payload).toEqual({
      from: { id: beta.id, name: "Beta", slug: beta.slug },
      to: null,
    });

    // An unknown Project is refused, naming it.
    const unknown = await refusal(
      run("alice", { operation: "amend", number: number!, project: `nope-${suffix}` }),
    );
    expect(unknown.code).toBe("INVALID_INPUT");
    expect(unknown.hint).toContain(`nope-${suffix}`);
  } finally {
    await db.$disconnect();
  }
});

test("a person's last-used project is her next Task's default in that conversation; an Agent gets none", async () => {
  const { db, make, show, principals, channel } = await setup();
  try {
    const workspaceId = principals.alice.workspaceId;
    const aliceId = principals.alice.userId!;
    const suffix = crypto.randomUUID().slice(0, 8);
    const alpha = await db.project.create({
      data: { workspaceId, name: "Alpha", slug: `alpha-${suffix}` },
    });
    const beta = await db.project.create({
      data: { workspaceId, name: "Beta", slug: `beta-${suffix}` },
    });

    // The first explicit pick is remembered on alice's member row.
    const [pinned] = await make("alice", 1, { project: alpha.slug });
    const member = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: channel.id, userId: aliceId },
    });
    expect(member.lastTaskProjectId).toBe(alpha.id);

    // Her next Task defaults to it; a different explicit pick replaces the memory.
    const [followed] = await make("alice", 1);
    expect((await show(followed!)).tasks[0]!.project?.id).toBe(alpha.id);
    const [repicked] = await make("alice", 1, { project: beta.slug });
    expect((await show(repicked!)).tasks[0]!.project?.id).toBe(beta.id);
    await db.conversationMember.findFirstOrThrow({
      where: { id: member.id, lastTaskProjectId: beta.id },
    });

    // An Agent's own create gets no last-used default.
    const [agentTask] = await make("one", 1);
    expect((await show(agentTask!)).tasks[0]!.project).toBeNull();
    void pinned;
  } finally {
    await db.$disconnect();
  }
});

test("deleting a project leaves its tasks filed under none", async () => {
  const { db, make, show, principals, channel } = await setup();
  try {
    const workspaceId = principals.alice.workspaceId;
    const suffix = crypto.randomUUID().slice(0, 8);
    const project = await db.project.create({
      data: { workspaceId, name: "Gone", slug: `gone-${suffix}` },
    });
    const [number] = await make("alice", 1, { project: project.slug });
    expect((await show(number!)).tasks[0]!.project?.id).toBe(project.id);
    await db.project.delete({ where: { id: project.id } });
    expect((await show(number!)).tasks[0]!.project).toBeNull();
    void channel;
  } finally {
    await db.$disconnect();
  }
});

test("a direct message's tasks take no project, and only the owner, creator or an admin changes one", async () => {
  const { db, run, make, principals, channel, refusal } = await setup();
  try {
    const workspaceId = principals.alice.workspaceId;
    const aliceId = principals.alice.userId!;
    const bobId = principals.bob.userId!;
    const suffix = crypto.randomUUID().slice(0, 8);
    const project = await db.project.create({
      data: { workspaceId, name: "Docs", slug: `docs-${suffix}` },
    });
    const dm = await db.conversation.create({
      data: {
        workspaceId,
        directKey: `user:${aliceId}|user:${bobId}`,
        members: { create: [{ userId: aliceId }, { userId: bobId }] },
      },
    });
    const inDm = await refusal(
      run("alice", { operation: "create", titles: ["dm task"], project: project.slug }, dm.id),
    );
    expect(inDm.code).toBe("INVALID_INPUT");
    expect(inDm.hint).toContain("direct message");
    // Nor can a direct message's Task be moved into one afterwards.
    const [dmNumber] = await make("alice", 1, {}, dm.id);
    const movedIn = await refusal(
      run("alice", { operation: "amend", number: dmNumber!, project: project.slug }, dm.id),
    );
    expect(movedIn.code).toBe("INVALID_INPUT");
    expect(movedIn.hint).toContain("direct message");

    const [number] = await make("alice", 1);
    // Bob is a member but neither the owner nor the creator: the Project is theirs to read only.
    const denied = await refusal(
      run("bob", { operation: "amend", number: number!, project: project.slug }),
    );
    expect(denied.code).toBe("ACCESS_DENIED");
    await run("alice", { operation: "amend", number: number!, project: project.slug });
    expect((await run("alice", { operation: "show", number: number! })).tasks[0]!.project?.id).toBe(
      project.id,
    );
    void channel;
  } finally {
    await db.$disconnect();
  }
});

test("the project page lists only readable, unfinished tasks filed under it, with their parents", async () => {
  const { db, board, run, make, principals, channel, secret } = await setup();
  try {
    const workspaceId = principals.alice.workspaceId;
    const aliceId = principals.alice.userId!;
    const suffix = crypto.randomUUID().slice(0, 8);
    const alpha = await db.project.create({
      data: { workspaceId, name: "Alpha", slug: `alpha-${suffix}` },
    });
    const beta = await db.project.create({
      data: { workspaceId, name: "Beta", slug: `beta-${suffix}` },
    });
    const [parent] = await make("alice", 1, { project: alpha.slug });
    const [child] = await make("alice", 1, {
      parent: { number: parent! },
      project: alpha.slug,
    });
    // A Task in the private channel is filed under Beta: not Alpha's.
    const [elsewhere] = await make("alice", 1, {}, secret.id);
    await run("alice", { operation: "amend", number: elsewhere!, project: beta.slug }, secret.id);

    const listed = await board.projectTasks({ workspaceId, userId: aliceId }, alpha.id);
    expect(listed.tasks.map((task) => task.number).sort()).toEqual([parent, child].sort());
    const parentRow = listed.tasks.find((task) => task.number === parent)!;
    expect(listed.tasks.find((task) => task.number === child)!.parentTaskId).toBe(parentRow.id);

    // A finished Task leaves the page.
    await run("alice", { operation: "update", number: child!, status: "closed" });
    expect(
      (await board.projectTasks({ workspaceId, userId: aliceId }, alpha.id)).tasks.map(
        (task) => task.number,
      ),
    ).toEqual([parent]);
    // A Project of another Workspace is not found.
    expect(
      await board.projectTasks({ workspaceId, userId: aliceId }, crypto.randomUUID()).then(
        () => "found",
        () => "refused",
      ),
    ).toBe("refused");
    void channel;
  } finally {
    await db.$disconnect();
  }
});
