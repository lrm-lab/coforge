import { expect, test } from "bun:test";
import type { TaskView } from "@lrm/coforge-sdk/internal";

import { filterConversationBoardTasks } from "#src/features/tasks/conversation-task-board";

type Row = Pick<TaskView, "number" | "parent" | "project">;

const launch = { id: "proj-launch", name: "Launch", slug: "launch" };
const infra = { id: "proj-infra", name: "Infra", slug: "infra" };

test("conversation board hides subtasks whose parent is on the board within the project filter", () => {
  const parent: Row = { number: 1, parent: null, project: launch };
  const localChild: Row = {
    number: 2,
    parent: { hidden: false, number: 1, channel: null, title: "Parent", status: "todo" },
    project: infra,
  };
  const crossChannelChild: Row = {
    number: 3,
    parent: { hidden: false, number: 1, channel: "design", title: "Other", status: "todo" },
    project: launch,
  };
  const missingParentChild: Row = {
    number: 4,
    parent: { hidden: false, number: 99, channel: null, title: "Finished", status: "done" },
    project: launch,
  };

  expect(
    filterConversationBoardTasks(
      [parent, localChild, crossChannelChild, missingParentChild],
      [],
    ).map((row) => row.number),
  ).toEqual([1, 3, 4]);

  expect(
    filterConversationBoardTasks([parent, localChild], [infra.id]).map((row) => row.number),
  ).toEqual([1, 2]);
});
