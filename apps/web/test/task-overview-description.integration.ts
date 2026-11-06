import { expect, test } from "bun:test";
import { finishedWorkFixture } from "./fixtures/finished-work";

test("TaskBoard card reads carry no description; the single-Task read keeps it", async () => {
  const f = await finishedWorkFixture();
  try {
    const open = await f.task(f.channel, f.viewer.id, "Open with details", {
      status: "todo",
      projectSlug: f.project.slug,
      description: "Shown only in the popup",
    });
    const done = await f.task(f.channel, f.viewer.id, "Done with details", {
      status: "done",
      description: "Finished details",
    });
    const scope = { workspaceId: f.workspace.id, userId: f.viewer.id };

    const overview = await f.board.overview(f.workspace.id, f.viewer.id);
    expect(overview.tasks.find((task) => task.number === open.number)).not.toHaveProperty(
      "description",
    );
    const finished = await f.board.finishedPage(scope, { status: "done", window: "week" });
    expect(finished.tasks.find((task) => task.number === done.number)).not.toHaveProperty(
      "description",
    );
    const project = await f.board.projectTasks(scope, f.project.id);
    expect(project.tasks.find((task) => task.number === open.number)).not.toHaveProperty(
      "description",
    );

    expect(
      await f.board.overviewTask(scope, { conversationId: f.channel.id, number: open.number }),
    ).toMatchObject({ description: "Shown only in the popup" });
    expect(
      await f.board.overviewTask(scope, { conversationId: f.channel.id, number: done.number }),
    ).toMatchObject({ description: "Finished details" });
  } finally {
    await f.cleanup();
  }
});
