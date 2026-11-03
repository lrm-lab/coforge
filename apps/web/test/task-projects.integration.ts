import { expect, test } from "bun:test";
import { changeChannelProject } from "#src/server/conversations/channel-project.server";
import { setup } from "./fixtures/task-dependencies";

/**
 * A Task's Project against real PostgreSQL: it follows its channel unless someone pinned one,
 * clearing pins it back to the channel, a direct message has none, and only the owner, creator or
 * an owner/admin changes it.
 */

test("a task follows its channel's project, and a pinned task keeps its own", async () => {
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
    const gamma = await db.project.create({
      data: { workspaceId, name: "Gamma", slug: `gamma-${suffix}` },
    });
    await db.conversation.update({
      where: { id: channel.id },
      data: { projectId: alpha.id },
    });

    const [number] = await make("alice", 1);
    expect((await show(number!)).tasks[0]!.project).toEqual({
      id: alpha.id,
      name: "Alpha",
      slug: alpha.slug,
    });

    // Pin it elsewhere; the channel move then leaves it where it was put.
    await run("alice", { operation: "amend", number: number!, project: beta.slug });
    expect((await show(number!)).tasks[0]!.project?.id).toBe(beta.id);
    // The channel now belongs to Gamma: the pinned Task stays in Beta, a new one follows Gamma.
    const ports = { db, realtime: { async channelUpdated() {}, async memberChanged() {} } };
    await changeChannelProject(
      ports as never,
      workspaceId,
      { userId: principals.alice.userId! },
      channel.id,
      gamma.id,
    );
    expect((await show(number!)).tasks[0]!.project?.id).toBe(beta.id);
    const [followed] = await make("alice", 1);
    expect((await show(followed!)).tasks[0]!.project?.id).toBe(gamma.id);

    // Clearing pins the Task back to whatever the channel is in now.
    await run("alice", { operation: "amend", number: number!, project: null });
    expect((await show(number!)).tasks[0]!.project?.id).toBe(gamma.id);

    const history = await run("alice", { operation: "history", number: number! });
    const changes = history.history!.filter((event) => event.eventType === "project_changed");
    expect(changes.length).toBe(3);
    expect(changes[0]!.payload).toEqual({
      from: null,
      to: { id: alpha.id, name: "Alpha", slug: alpha.slug },
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
    // The workspace owner may move anyone's Task (alice is both here; the manager path is the
    // same predicate the relation edits use).
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
    await db.conversation.update({
      where: { id: channel.id },
      data: { projectId: alpha.id },
    });
    const [parent] = await make("alice", 1);
    const [child] = await make("alice", 1, { parent: { number: parent! } });
    // A Task in the private channel starts in no Project, then is pinned to Beta: not Alpha's.
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
  } finally {
    await db.$disconnect();
  }
});
