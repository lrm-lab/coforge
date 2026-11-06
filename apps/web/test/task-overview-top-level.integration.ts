import { expect, test } from "bun:test";
import { finishedWorkFixture } from "./fixtures/finished-work";

/**
 * The Workspace boards show top-level Tasks only (task #596): a sub-task is its parent's progress,
 * so it is neither a card nor a count — in the unfinished list, a finished page or the finished
 * summary. A sub-task whose parent is deleted is top-level again.
 */
test("the Workspace board's reads leave sub-tasks out of the cards and the counts", async () => {
  const f = await finishedWorkFixture();
  try {
    const parentOf = async (child: { id: string }, parent: { id: string }) => {
      await f.db.taskParent.create({
        data: {
          taskId: child.id,
          parentTaskId: parent.id,
          conversationId: f.channel.id,
          workspaceId: f.workspace.id,
        },
      });
    };
    const open = await f.task(f.channel, f.viewer.id, "Open parent", { status: "todo" });
    await parentOf(await f.task(f.channel, f.viewer.id, "Open step", { status: "todo" }), open);
    const done = await f.task(f.channel, f.viewer.id, "Done parent", { status: "done" });
    await parentOf(await f.task(f.channel, f.viewer.id, "Done step", { status: "done" }), done);
    // Its parent deleted, a sub-task is a card again.
    const gone = await f.task(f.channel, f.viewer.id, "Deleted parent", { status: "todo" });
    await parentOf(await f.task(f.channel, f.viewer.id, "Orphan step", { status: "todo" }), gone);
    await f.db.task.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

    const scope = { workspaceId: f.workspace.id, userId: f.viewer.id };
    const titles = (rows: { title: string }[]) => rows.map(({ title }) => title).sort();

    expect(titles((await f.board.overview(f.workspace.id, f.viewer.id)).tasks)).toEqual([
      "Open parent",
      "Orphan step",
    ]);
    expect(
      titles((await f.board.finishedPage(scope, { status: "done", window: "week" })).tasks),
    ).toEqual(["Done parent"]);
    const summary = await f.board.finishedSummary(scope, { window: "week" });
    expect(summary.groups.reduce((sum, group) => sum + group.count, 0)).toBe(1);
  } finally {
    await f.cleanup();
  }
});
