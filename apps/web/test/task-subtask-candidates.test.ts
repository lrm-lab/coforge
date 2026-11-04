import { expect, test } from "bun:test";
import { taskNameLabel, type TaskLink, type TaskView } from "@lrm/coforge-sdk/internal";

import { subtaskCandidates } from "#src/features/tasks/task-relation-edits";

/** "Add existing sub-task" (task #505): which of the conversation's Tasks the picker offers. */

const person = (memberId: string) =>
  ({ memberId, kind: "user", id: memberId, name: memberId, handle: memberId }) as const;
const under = (number: number, channel: string | null = null): TaskLink => ({
  hidden: false,
  number,
  channel,
  title: `Task ${number}`,
  status: "todo",
});
type Row = Pick<TaskView, "number" | "title" | "status" | "owner" | "creator" | "parent">;
const row = (number: number, parts: Partial<Row> = {}): Row => ({
  number,
  title: `Task ${number}`,
  status: "todo",
  owner: null,
  creator: person("me"),
  parent: null,
  ...parts,
});
const me = { memberId: "me", manager: false };
const names = (rows: ReturnType<typeof subtaskCandidates>) => rows.map(taskNameLabel);

test("the Task itself, its own sub-tasks and finished Tasks are not offered", () => {
  const offered = subtaskCandidates(
    { number: 1, parent: null },
    [
      row(1),
      row(2, { parent: under(1) }),
      row(3, { status: "done" }),
      row(4, { status: "closed" }),
      row(5),
    ],
    me,
  );
  expect(names(offered)).toEqual(["#5"]);
});

test("the Tasks above it are listed but refused, all the way up the conversation's chain", () => {
  // #1 → #2 → #3 (the Task); #4 sits beside them.
  const offered = subtaskCandidates(
    { number: 3, parent: under(2) },
    [row(4), row(2, { parent: under(1) }), row(1), row(3, { parent: under(2) })],
    me,
  );
  expect(offered.map(({ number, refusal }) => [number, refusal])).toEqual([
    [1, "above"],
    [2, "above"],
    [4, null],
  ]);
});

test("a parent in another channel ends the chain here: the server judges what is beyond", () => {
  const offered = subtaskCandidates(
    { number: 3, parent: under(9, "design") },
    [row(9), row(3)],
    me,
  );
  // #9 here is not the #design:#9 above the Task.
  expect(offered.map(({ number, refusal }) => [number, refusal])).toEqual([[9, null]]);
});

test("a Task the viewer may not move is refused; its owner, creator or a manager may", () => {
  const others = row(2, { creator: person("someone"), owner: person("else") });
  const owned = row(3, { creator: person("someone"), owner: person("me") });
  const task = { number: 1, parent: null };
  expect(
    subtaskCandidates(task, [others, owned], me).map(({ number, refusal }) => [number, refusal]),
  ).toEqual([
    [2, "denied"],
    [3, null],
  ]);
  expect(
    subtaskCandidates(task, [others], { memberId: "me", manager: true }).map((c) => c.refusal),
  ).toEqual([null]);
  // Not a member of the conversation: only a manager may move anything.
  expect(
    subtaskCandidates(task, [row(2)], { memberId: null, manager: false }).map((c) => c.refusal),
  ).toEqual(["denied"]);
});

test("a Task under another parent says which, so the move can be confirmed", () => {
  const [moved, free] = subtaskCandidates(
    { number: 1, parent: null },
    [row(2, { parent: under(7) }), row(3)],
    me,
  );
  expect(moved!.from && taskNameLabel(moved!.from)).toBe("#7");
  expect(free!.from).toBeNull();
});

test("a parent the viewer cannot see still counts: the move is confirmed, without its name", () => {
  const [moved] = subtaskCandidates(
    { number: 1, parent: null },
    [row(2, { parent: { hidden: true, status: "todo" } })],
    me,
  );
  // Not null, so the picker says it is under a Task and asks before moving it.
  expect(moved!.from).toEqual({ hidden: true, status: "todo" });
});
