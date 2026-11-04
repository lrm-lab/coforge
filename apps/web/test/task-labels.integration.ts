import { expect, test } from "bun:test";
import { Labels } from "#src/server/tasks/labels.server";
import { setup } from "./fixtures/task-dependencies";

/**
 * Workspace task labels against real PostgreSQL: attaching them, the five-label cap, the unknown
 * name refusal, and who may create, rename and delete one.
 */

test("a task carries its labels, case-insensitively, and an amend adds and removes them", async () => {
  const { db, run, make, show, principals, refusal } = await setup();
  try {
    const workspaceId = principals.alice.workspaceId;
    const labels = new Labels(db);
    const design = await labels.create(workspaceId, principals.alice.userId!, {
      name: "Design",
      color: "blue",
    });
    const bug = await labels.create(workspaceId, principals.alice.userId!, { name: "Bug" });
    expect(bug.color).toBe("gray");

    const [number] = await make("alice", 1, { labels: ["design"] });
    expect((await show(number!)).tasks[0]!.labels ?? []).toEqual([
      { id: design.id, name: "Design", color: "blue" },
    ]);

    // The reply (and the `task.changed.v1` built from it) carries the labels the Task now has.
    const amended = await run("alice", { operation: "amend", number: number!, labels: ["BUG"] });
    expect((amended.tasks[0]!.labels ?? []).map((label) => label.name)).toEqual(["Bug", "Design"]);
    expect(((await show(number!)).tasks[0]!.labels ?? []).map((label) => label.name)).toEqual([
      "Bug",
      "Design",
    ]);

    await run("alice", { operation: "amend", number: number!, removeLabels: ["design"] });
    expect(((await show(number!)).tasks[0]!.labels ?? []).map((label) => label.name)).toEqual([
      "Bug",
    ]);

    // Taking off a label the task does not carry is a no-op, not an error.
    await run("alice", { operation: "amend", number: number!, removeLabels: ["Design"] });
    expect(((await show(number!)).tasks[0]!.labels ?? []).map((label) => label.name)).toEqual([
      "Bug",
    ]);

    const history = await run("alice", { operation: "history", number: number! });
    const labelEvents = history.history!.filter((event) => event.eventType === "labels_changed");
    expect(labelEvents.length).toBe(3);
    expect(labelEvents[0]!.payload).toEqual({
      added: [{ id: design.id, name: "Design", color: "blue" }],
      removed: [],
    });

    // `list --label` filters: every named label must be on the Task.
    await labels.create(workspaceId, principals.alice.userId!, { name: "Both" });
    await run("alice", { operation: "amend", number: number!, labels: ["Both"] });
    const onlyDesign = (await make("alice", 1, { labels: ["Design"] }))[0]!;
    const listed = async (...names: string[]) =>
      (await run("alice", { operation: "list", labels: names })).tasks.map((task) => task.number);
    expect(await listed("Design")).toEqual([onlyDesign]);
    expect(await listed("Bug", "Both")).toEqual([number]);
    expect(await listed("Design", "Bug")).toEqual([]);
    const unknownFilter = await refusal(run("alice", { operation: "list", labels: ["Nope"] }));
    expect(unknownFilter.code).toBe("INVALID_INPUT");

    // A label no Workspace label names is refused and never created; the hint names the ones it has.
    const unknown = await refusal(
      run("alice", { operation: "amend", number: number!, labels: ["Nope"] }),
    );
    expect(unknown.code).toBe("INVALID_INPUT");
    expect(unknown.hint).toContain("Nope");
    expect(unknown.hint).toContain("Design");
    expect(await db.label.count({ where: { workspaceId } })).toBe(3);
  } finally {
    await db.$disconnect();
  }
});

test("a task carries at most five labels", async () => {
  const { db, run, make, principals, refusal } = await setup();
  try {
    const workspaceId = principals.alice.workspaceId;
    const labels = new Labels(db);
    const names = ["One", "Two", "Three", "Four", "Five", "Six"];
    for (const name of names) await labels.create(workspaceId, principals.alice.userId!, { name });

    const [number] = await make("alice", 1, { labels: names.slice(0, 5) });
    const sixth = await refusal(
      run("alice", { operation: "amend", number: number!, labels: ["Six"] }),
    );
    expect(sixth.code).toBe("INVALID_INPUT");
    expect(sixth.hint).toContain("at most 5");

    const tooMany = await refusal(make("alice", 1, { labels: names }));
    expect(tooMany.code).toBe("INVALID_INPUT");
  } finally {
    await db.$disconnect();
  }
});

test("any member creates a label; only an owner or admin renames or deletes one", async () => {
  const { db, make, show, principals, refusal } = await setup();
  try {
    const workspaceId = principals.alice.workspaceId;
    const aliceId = principals.alice.userId!;
    const bobId = principals.bob.userId!;
    const labels = new Labels(db);

    const fromBob = await labels.create(workspaceId, bobId, { name: "Client" });
    // The same name in another case is the same label, not a second one.
    expect((await labels.create(workspaceId, bobId, { name: "client" })).id).toBe(fromBob.id);
    expect(await db.label.count({ where: { workspaceId } })).toBe(1);

    expect(
      (await refusal(labels.update(workspaceId, bobId, fromBob.id, { name: "Clients" }))).code,
    ).toBe("ACCESS_DENIED");
    expect((await refusal(labels.delete(workspaceId, bobId, fromBob.id))).code).toBe(
      "ACCESS_DENIED",
    );

    const renamed = await labels.update(workspaceId, aliceId, fromBob.id, {
      name: "Clients",
      color: "orange",
    });
    expect(renamed).toMatchObject({ id: fromBob.id, name: "Clients", color: "orange" });
    await labels.create(workspaceId, aliceId, { name: "Copy" });
    expect(
      (await refusal(labels.update(workspaceId, aliceId, fromBob.id, { name: "copy" }))).code,
    ).toBe("CONFLICT");
    expect(
      (await refusal(labels.create(workspaceId, aliceId, { name: "Bad", color: "chartreuse" })))
        .code,
    ).toBe("INVALID_INPUT");
    // A leading `-` is the CLI's "take it off", so such a name could never be attached there.
    expect((await refusal(labels.create(workspaceId, aliceId, { name: "-Design" }))).code).toBe(
      "INVALID_INPUT",
    );
    expect(
      (await refusal(labels.update(workspaceId, aliceId, fromBob.id, { name: "-Clients" }))).code,
    ).toBe("INVALID_INPUT");

    const [number] = await make("alice", 1, { labels: ["Clients"] });
    const taskId = (await show(number!)).tasks[0]!.id;
    await labels.delete(workspaceId, aliceId, fromBob.id);
    expect(await db.taskLabel.count({ where: { taskId } })).toBe(0);
  } finally {
    await db.$disconnect();
  }
});

test("archiving a label takes it off every task, frees its slot, and is for an owner or admin", async () => {
  const { db, run, make, show, principals, refusal } = await setup();
  try {
    const workspaceId = principals.alice.workspaceId;
    const aliceId = principals.alice.userId!;
    const labels = new Labels(db);
    const names = ["One", "Two", "Three", "Four", "Five", "Six"];
    const created = [];
    for (const name of names) created.push(await labels.create(workspaceId, aliceId, { name }));

    const [number] = await make("alice", 1, { labels: names.slice(0, 5) });
    const taskId = (await show(number!)).tasks[0]!.id;
    const labelNames = async () =>
      ((await show(number!)).tasks[0]!.labels ?? []).map((label) => label.name);

    expect(
      (
        await refusal(
          labels.update(workspaceId, principals.bob.userId!, created[0]!.id, { archived: true }),
        )
      ).code,
    ).toBe("ACCESS_DENIED");
    expect(await labelNames()).toContain("One");

    await labels.update(workspaceId, aliceId, created[0]!.id, { archived: true });
    expect(await labelNames()).toEqual(["Five", "Four", "Three", "Two"]);
    // The row stays, so restoring the label brings it back.
    expect(await db.taskLabel.count({ where: { taskId } })).toBe(5);

    // The archived label no longer counts towards the five, so a fifth active one fits.
    await run("alice", { operation: "amend", number: number!, labels: ["Six"] });
    expect(await labelNames()).toEqual(["Five", "Four", "Six", "Three", "Two"]);
    // `list --label` on an archived label matches no Task, and `--label none` counts a Task whose
    // only label was archived as having none.
    const listed = async (...names: string[]) =>
      (await run("alice", { operation: "list", labels: names })).tasks.map((task) => task.number);
    expect(await listed("One")).toEqual([]);
    await labels.create(workspaceId, aliceId, { name: "Solo" });
    const [solo] = await make("alice", 1, { labels: ["Solo"] });
    expect(await listed("none")).not.toContain(solo);
    await labels.update(
      workspaceId,
      aliceId,
      (await db.label.findFirstOrThrow({ where: { workspaceId, name: "Solo" } })).id,
      { archived: true },
    );
    expect(await listed("none")).toContain(solo);
    // An archived label cannot be attached again.
    expect((await refusal(make("alice", 1, { labels: ["One"] }))).code).toBe("INVALID_INPUT");
  } finally {
    await db.$disconnect();
  }
});

test("an Agent creates a label; only an owner or admin Agent renames, archives or restores one", async () => {
  const { db, principals, refusal } = await setup();
  try {
    const workspaceId = principals.alice.workspaceId;
    const memberAgent = { agentId: principals.one.agentId! };
    const adminAgent = { agentId: principals.two.agentId! };
    await db.agent.update({ where: { id: adminAgent.agentId }, data: { role: "admin" } });
    const labels = new Labels(db);

    const made = await labels.create(workspaceId, memberAgent, {
      name: "Infra",
      description: "Servers and deploys",
    });
    expect(made.description).toBe("Servers and deploys");
    expect(
      (await db.label.findUniqueOrThrow({ where: { id: made.id } })).createdByUserId,
    ).toBeNull();

    const denied = await refusal(labels.update(workspaceId, memberAgent, made.id, { name: "Ops" }));
    expect(denied.code).toBe("ACCESS_DENIED");

    const renamed = await labels.update(workspaceId, adminAgent, made.id, { name: "Ops" });
    expect(renamed.name).toBe("Ops");
    const archived = await labels.update(workspaceId, adminAgent, made.id, { archived: true });
    expect(archived.archivedAt).not.toBeNull();
    const restored = await labels.update(workspaceId, adminAgent, made.id, { archived: false });
    expect(restored.archivedAt).toBeNull();

    // A deleted Agent is no longer one of the Workspace's actors.
    await db.agent.update({ where: { id: memberAgent.agentId }, data: { deletedAt: new Date() } });
    const gone = await refusal(labels.create(workspaceId, memberAgent, { name: "Late" }));
    expect(gone.code).toBe("ACCESS_DENIED");
  } finally {
    await db.$disconnect();
  }
});
