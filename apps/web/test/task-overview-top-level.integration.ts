import { expect, test } from "bun:test";
import { finishedWorkFixture } from "./fixtures/finished-work";

/**
 * On the Workspace boards a sub-task is its parent's progress, not a card, only when the parent is
 * on the same board (task #596): a live Task the viewer may read, within the board's Project pick.
 * Done and Closed apply it on the server, pages and counts alike; the unfinished list gives each
 * such sub-task its parent's Project so the board applies the same pick.
 */
test("a sub-task is a card unless its parent is on the same board, in pages and counts alike", async () => {
  const f = await finishedWorkFixture();
  try {
    const link = async (child: { id: string; conversationId: string }, parent: { id: string }) => {
      await f.db.taskParent.create({
        data: {
          taskId: child.id,
          parentTaskId: parent.id,
          conversationId: child.conversationId,
          workspaceId: f.workspace.id,
        },
      });
    };
    // A channel's new Tasks inherit its last Project, so a Task without one is cleared explicitly.
    const done = async (title: string, projectSlug?: string) => {
      const row = await f.task(f.channel, f.viewer.id, title, {
        status: "done",
        ...(projectSlug && { projectSlug }),
      });
      if (!projectSlug)
        await f.db.task.update({ where: { id: row.id }, data: { projectId: null } });
      return row;
    };

    // Under a parent the viewer sees, in no Project: under its card.
    await link(await done("Step under a seen parent"), await done("Seen parent"));
    // Under a parent in someone else's DM: a card of its own.
    await link(
      await done("Step under a hidden parent"),
      await f.task(f.otherDm, f.peer.id, "Hidden parent", { status: "done" }),
    );
    // In the Project, under a parent outside it: a card on the Project's board, not on All tasks.
    await link(await done("Step in Launch", f.project.slug), await done("Parent outside Launch"));
    // Its parent deleted: a card again.
    const gone = await done("Deleted parent");
    await link(await done("Step under a deleted parent"), gone);
    await f.db.task.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

    const scope = { workspaceId: f.workspace.id, userId: f.viewer.id };
    const page = async (projects?: string[]) =>
      (await f.board.finishedPage(scope, { status: "done", window: "week", projects })).tasks
        .map(({ title }) => title)
        .sort();
    const count = async (projects?: string[]) =>
      (await f.board.finishedSummary(scope, { window: "week", projects })).groups
        .filter((group) => !projects || group.project?.id === projects[0])
        .reduce((sum, group) => sum + group.count, 0);

    expect(await page()).toEqual([
      "Parent outside Launch",
      "Seen parent",
      "Step under a deleted parent",
      "Step under a hidden parent",
    ]);
    expect(await count()).toBe(4);
    expect(await page([f.project.id])).toEqual(["Step in Launch"]);
    expect(await count([f.project.id])).toBe(1);

    // The unfinished list names the parent's Project on a sub-task whose parent is shown.
    const open = await f.task(f.channel, f.viewer.id, "Open parent", {
      status: "todo",
      projectSlug: f.project.slug,
    });
    const step = await f.task(f.channel, f.viewer.id, "Open step", { status: "todo" });
    await link(step, open);
    const hiddenStep = await f.task(f.channel, f.viewer.id, "Open step, hidden parent", {
      status: "todo",
    });
    await link(hiddenStep, await f.task(f.otherDm, f.peer.id, "Open hidden", { status: "todo" }));
    const rows = (await f.board.overview(f.workspace.id, f.viewer.id)).tasks;
    const row = (title: string) => rows.find((each) => each.title === title)!;
    expect(row("Open step").parentProjectId).toBe(f.project.id);
    expect("parentProjectId" in row("Open step, hidden parent")).toBe(false);
    expect("parentProjectId" in row("Open parent")).toBe(false);
  } finally {
    await f.cleanup();
  }
});
