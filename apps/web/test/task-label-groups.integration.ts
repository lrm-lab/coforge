import { expect, test } from "bun:test";
import { LabelGroups } from "#src/server/tasks/label-groups.server";
import { Labels } from "#src/server/tasks/labels.server";
import { setup } from "./fixtures/task-dependencies";

/**
 * Label groups and the label module against real PostgreSQL: the single default, group and label
 * names, counts, archiving, and a merge that drops a second label of one single group.
 */

test("groups and labels: names, counts, archiving, and the single-group default", async () => {
  const { db, run, make, principals, refusal } = await setup();
  try {
    const workspaceId = principals.alice.workspaceId;
    const aliceId = principals.alice.userId!;
    const groups = new LabelGroups(db);
    const labels = new Labels(db);

    const kind = await groups.create(workspaceId, aliceId, { name: "Kind" });
    expect(kind.selection).toBe("single");
    expect((await groups.create(workspaceId, aliceId, { name: "kind" })).id).toBe(kind.id);

    const bug = await labels.create(workspaceId, aliceId, {
      name: "Bug",
      description: "Something is broken",
      group: "Kind",
    });
    expect(bug.group?.name).toBe("Kind");
    expect((await labels.create(workspaceId, aliceId, { name: "bug" })).id).toBe(bug.id);
    for (const name of ["none", "a/b", "-bad", "priority"])
      expect((await refusal(labels.create(workspaceId, aliceId, { name }))).code).toBe(
        "INVALID_INPUT",
      );

    const [number] = await make("alice", 1, { labels: ["Kind/Bug"] });
    const summary = (await labels.list(workspaceId, aliceId)).find((label) => label.id === bug.id)!;
    expect(summary.openCount).toBe(1);
    expect(summary.taskCount).toBe(1);
    expect(summary.lastUsedAt).not.toBeNull();

    // Archived: it stays on the Task it is on, but cannot be attached again.
    await labels.update(workspaceId, aliceId, bug.id, { archived: true });
    expect((await labels.list(workspaceId, aliceId)).some((label) => label.id === bug.id)).toBe(
      false,
    );
    expect(
      (await labels.list(workspaceId, aliceId, { archived: true })).some(
        (label) => label.id === bug.id,
      ),
    ).toBe(true);
    const archived = await refusal(
      run("alice", { operation: "amend", number: number!, labels: ["Kind/Bug"] }),
    );
    expect(archived.code).toBe("INVALID_INPUT");
    expect(archived.hint).toContain("archived");
  } finally {
    await db.$disconnect();
  }
});

test("a merge moves Tasks to the target and drops a second label of its single group", async () => {
  const { db, make, show, principals, refusal } = await setup();
  try {
    const workspaceId = principals.alice.workspaceId;
    const aliceId = principals.alice.userId!;
    const groups = new LabelGroups(db);
    const labels = new Labels(db);
    await groups.create(workspaceId, aliceId, { name: "Kind", selection: "single" });
    const alpha = await labels.create(workspaceId, aliceId, { name: "Alpha", group: "Kind" });
    const beta = await labels.create(workspaceId, aliceId, { name: "Beta", group: "Kind" });
    const gamma = await labels.create(workspaceId, aliceId, { name: "Gamma", group: "Kind" });
    const [one] = await make("alice", 1, { labels: ["Alpha"] });
    const [two] = await make("alice", 1, { labels: ["Alpha", "Gamma"] });

    // A member may not merge; an owner may.
    expect(
      (await refusal(labels.merge(workspaceId, principals.bob.userId!, alpha.id, beta.id))).code,
    ).toBe("ACCESS_DENIED");
    const result = await labels.merge(workspaceId, aliceId, alpha.id, beta.id);
    expect(result.moved).toBe(2);
    expect(result.dropped).toBe(1);

    expect((await show(one!)).tasks[0]!.labels!.map((label) => label.name)).toEqual(["Beta"]);
    // Beta stayed, Gamma (the other label of the single group) went, and history says so.
    expect((await show(two!)).tasks[0]!.labels!.map((label) => label.name)).toEqual(["Beta"]);
    const history = await db.taskHistoryEvent.findFirst({
      where: { task: { number: two! }, eventType: "labels_changed", actorType: "system" },
      orderBy: { seq: "desc" },
    });
    expect(history).not.toBeNull();
    expect(await db.label.count({ where: { workspaceId, name: "Alpha" } })).toBe(0);
    expect(beta.id).toBeTruthy();
    expect(gamma.id).toBeTruthy();
  } finally {
    await db.$disconnect();
  }
});

test("switching a group to single reports the Tasks that now carry several of its labels", async () => {
  const { db, make, principals } = await setup();
  try {
    const workspaceId = principals.alice.workspaceId;
    const aliceId = principals.alice.userId!;
    const groups = new LabelGroups(db);
    const labels = new Labels(db);
    const kind = await groups.create(workspaceId, aliceId, {
      name: "Kind",
      selection: "multiple",
    });
    await labels.create(workspaceId, aliceId, { name: "Alpha", group: "Kind" });
    await labels.create(workspaceId, aliceId, { name: "Beta", group: "Kind" });
    await make("alice", 1, { labels: ["Alpha", "Beta"] });
    // Existing Tasks are not rewritten; the switch only reports them.
    const switched = await groups.update(workspaceId, aliceId, kind.id, { selection: "single" });
    expect(switched.group.selection).toBe("single");
    expect(switched.nonConforming).toBe(1);
    expect(await db.taskLabel.count({ where: { task: { workspaceId } } })).toBe(2);
  } finally {
    await db.$disconnect();
  }
});
