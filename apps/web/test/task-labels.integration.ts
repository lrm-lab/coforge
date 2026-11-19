import { expect, test } from "bun:test";
import { Labels } from "#src/server/tasks/labels.server";
import { setup } from "./fixtures/task-dependencies";

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
    expect((await refusal(labels.create(workspaceId, aliceId, { name: "-Design" }))).code).toBe(
      "INVALID_INPUT",
    );
    expect(
      (await refusal(labels.update(workspaceId, aliceId, fromBob.id, { name: "-Clients" }))).code,
    ).toBe("INVALID_INPUT");

    const [number] = await make("alice", 1, { labels: ["Clients"] });
    const taskId = (await show(number!)).tasks[0]!.id;
    const live = await refusal(labels.delete(workspaceId, aliceId, fromBob.id));
    expect(live).toMatchObject({ code: "INVALID_INPUT", errorId: "task-label-not-archived" });
    expect(await db.taskLabel.count({ where: { taskId } })).toBe(1);
    await labels.update(workspaceId, aliceId, fromBob.id, { archived: true });
    expect((await refusal(labels.delete(workspaceId, bobId, fromBob.id))).code).toBe(
      "ACCESS_DENIED",
    );
    await labels.delete(workspaceId, aliceId, fromBob.id);
    expect(await db.taskLabel.count({ where: { taskId } })).toBe(0);
  } finally {
    await db.$disconnect();
  }
});

test("a member reads every label for Settings → Labels, the archived ones and their counts too", async () => {
  const { db, make, principals } = await setup();
  try {
    const workspaceId = principals.alice.workspaceId;
    const aliceId = principals.alice.userId!;
    const bobId = principals.bob.userId!;
    const labels = new Labels(db);
    const kept = await labels.create(workspaceId, aliceId, { name: "Kept" });
    const gone = await labels.create(workspaceId, aliceId, { name: "Gone" });
    await make("alice", 2, { labels: ["Gone"] });
    await labels.update(workspaceId, aliceId, gone.id, { archived: true });

    const all = await labels.list(workspaceId, bobId, { archived: true });
    expect(all.map((label) => [label.name, Boolean(label.archivedAt), label.taskCount])).toEqual([
      ["Gone", true, 2],
      ["Kept", false, 0],
    ]);
    expect(all.find((label) => label.id === gone.id)!.lastUsedAt).not.toBeNull();
    expect((await labels.list(workspaceId, bobId)).map((label) => label.id)).toEqual([kept.id]);
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
    expect(await db.taskLabel.count({ where: { taskId } })).toBe(5);

    await run("alice", { operation: "amend", number: number!, labels: ["Six"] });
    expect(await labelNames()).toEqual(["Five", "Four", "Six", "Three", "Two"]);
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

    await db.agent.update({ where: { id: memberAgent.agentId }, data: { deletedAt: new Date() } });
    const gone = await refusal(labels.create(workspaceId, memberAgent, { name: "Late" }));
    expect(gone.code).toBe("ACCESS_DENIED");
  } finally {
    await db.$disconnect();
  }
});

test("Settings → Labels: recolor and rename stick, a restore keeps the label out of a delete, and a delete takes it off every task (task #508)", async () => {
  const { db, make, show, principals, refusal } = await setup();
  try {
    const workspaceId = principals.alice.workspaceId;
    const aliceId = principals.alice.userId!;
    const labels = new Labels(db);
    const docs = await labels.create(workspaceId, aliceId, { name: "Docs" });
    const bug = await labels.create(workspaceId, aliceId, { name: "Bug" });
    const numbers = await make("alice", 2, { labels: ["Bug"] });

    const recolored = await labels.update(workspaceId, aliceId, docs.id, { color: "indigo" });
    expect(recolored).toMatchObject({ name: "Docs", color: "indigo" });
    const taken = await refusal(labels.update(workspaceId, aliceId, docs.id, { name: "bug" }));
    expect(taken).toMatchObject({ code: "CONFLICT", errorId: "task-label-name-taken" });
    await labels.update(workspaceId, aliceId, docs.id, { name: "Guides" });
    expect(await db.label.findUniqueOrThrow({ where: { id: docs.id } })).toMatchObject({
      name: "Guides",
      color: "indigo",
    });

    await labels.update(workspaceId, aliceId, bug.id, { archived: true });
    await labels.update(workspaceId, aliceId, bug.id, { archived: false });
    expect((await labels.list(workspaceId, aliceId)).find((l) => l.id === bug.id)).toMatchObject({
      taskCount: 2,
      archivedAt: null,
    });

    const meanwhile = await refusal(labels.delete(workspaceId, aliceId, bug.id));
    expect(meanwhile).toMatchObject({ code: "INVALID_INPUT", errorId: "task-label-not-archived" });
    expect(await db.label.findUnique({ where: { id: bug.id } })).not.toBeNull();

    await labels.update(workspaceId, aliceId, bug.id, { archived: true });
    await labels.delete(workspaceId, aliceId, bug.id);
    expect(await db.label.findUnique({ where: { id: bug.id } })).toBeNull();
    expect(await db.taskLabel.count({ where: { labelId: bug.id } })).toBe(0);
    for (const number of numbers) expect((await show(number)).tasks[0]!.labels ?? []).toEqual([]);
  } finally {
    await db.$disconnect();
  }
});
