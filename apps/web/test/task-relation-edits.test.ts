import { expect, test } from "bun:test";
import {
  MAX_TASK_BLOCKERS,
  type TaskLink,
  type TaskTreeNode,
  taskNameLabel,
} from "@lrm/coforge-sdk/internal";

import { AppError } from "#src/lib/app-error";
import {
  blockerPickerRules,
  blockerRefs,
  candidateLinks,
  canAddBlocker,
  canEditTaskRelations,
  canRemoveBlockers,
  parentPickerRules,
  pickable,
  relationRefusal,
  taskRefOf,
} from "#src/features/tasks/task-relation-edits";

const link = (number: number, channel: string | null = null, status = "todo"): TaskLink => ({
  hidden: false,
  number,
  channel,
  title: `Task ${number}`,
  status: status as "todo",
});
const hidden: TaskLink = { hidden: true, status: "todo" };
const visible = (task: TaskLink) => {
  if (task.hidden) throw new Error("hidden");
  return task;
};
const node = (number: number, children: TaskTreeNode[] = []): TaskTreeNode => ({
  ...visible(link(number)),
  owner: null,
  blocked: false,
  blockedBy: [],
  children,
});

test("a Task is named by a bare number in its own conversation and by channel elsewhere", () => {
  expect(taskRefOf(visible(link(7)))).toEqual({ number: 7 });
  expect(taskRefOf(visible(link(7, "design")))).toEqual({ number: 7, channel: "design" });
  expect(taskNameLabel(visible(link(7, "design")))).toBe("#design/7");
});

test("adding or removing a blocker amends to the whole new set, in both naming forms", () => {
  const current = [link(3), link(4, "design")];
  expect(blockerRefs(current, { add: visible(link(9)) })).toEqual([
    { number: 3 },
    { number: 4, channel: "design" },
    { number: 9 },
  ]);
  expect(blockerRefs(current, { remove: visible(link(4, "design")) })).toEqual([{ number: 3 }]);
  // The same Task in another channel is another Task.
  expect(blockerRefs(current, { remove: visible(link(4)) })).toEqual([
    { number: 3 },
    { number: 4, channel: "design" },
  ]);
  expect(blockerRefs(current, { add: visible(link(3)) })).toEqual([
    { number: 3 },
    { number: 4, channel: "design" },
  ]);
  expect(blockerRefs([link(3)], { remove: visible(link(3)) })).toEqual([]);
});

test("a set holding a blocker that cannot be named is never rewritten", () => {
  const current = [link(3), hidden];
  expect(blockerRefs(current, { add: visible(link(9)) })).toBeUndefined();
  expect(blockerRefs(current, { remove: visible(link(3)) })).toBeUndefined();
  expect(canRemoveBlockers(current)).toBe(false);
  expect(canAddBlocker(current)).toBe(false);
  expect(canRemoveBlockers([link(3)])).toBe(true);
});

test("a Task with the most blockers takes no more", () => {
  const full = Array.from({ length: MAX_TASK_BLOCKERS }, (_, index) => link(index + 1));
  expect(canAddBlocker(full)).toBe(false);
  expect(canAddBlocker(full.slice(1))).toBe(true);
  expect(canRemoveBlockers(full)).toBe(true);
});

test("the blocker picker leaves out the Task and its blockers, and refuses what would loop", () => {
  const rules = blockerPickerRules(
    { number: 5, blockedBy: [link(3), hidden] },
    { blocking: [link(8), link(9, "design"), hidden], subtree: [node(11, [node(12)])] },
  );
  expect([...rules.excluded].sort()).toEqual(["#3", "#5"]);
  expect([...rules.loops].sort()).toEqual(["#11", "#12", "#8", "#design/9"]);
});

test("the parent picker leaves out the Task and its parent, and refuses its own sub-tasks", () => {
  const rules = parentPickerRules(
    { number: 5, parent: link(2, "design") },
    { subtree: [node(11, [node(12)])] },
  );
  expect([...rules.excluded].sort()).toEqual(["#5", "#design/2"]);
  expect([...rules.loops].sort()).toEqual(["#11", "#12"]);
  expect(parentPickerRules({ number: 5, parent: hidden }, { subtree: [] }).excluded).toEqual(
    new Set(["#5"]),
  );
});

test("candidates are the unfinished Tasks, the conversation's first and the others by channel name", () => {
  const row = (conversationId: string, number: number, status: string) => ({
    conversationId,
    number,
    title: `T${number}`,
    status: status as "todo",
  });
  const found = candidateLinks(
    "here",
    [row("here", 2, "todo"), row("here", 1, "in_progress"), row("here", 3, "done")],
    [
      { ...row("there", 4, "todo"), source: { channelName: "design" } },
      // The Workspace read lists this conversation's Tasks too: no second copy.
      { ...row("here", 2, "todo"), source: { channelName: "general" } },
      { ...row("else", 1, "closed"), source: { channelName: "ops" } },
      { ...row("dm", 9, "todo"), source: { channelName: null } },
    ],
  );
  expect(found.map(taskNameLabel)).toEqual(["#1", "#2", "#design/4"]);
  const rules = blockerPickerRules(
    { number: 1, blockedBy: [link(2)] },
    { blocking: [], subtree: [] },
  );
  expect(pickable(found, rules).map(taskNameLabel)).toEqual(["#design/4"]);
});

test("an owner, a creator or a manager may change a Task's relations", () => {
  const person = (memberId: string) =>
    ({ memberId, kind: "user", id: memberId, name: memberId, handle: memberId }) as const;
  const task = { owner: person("owner"), creator: person("creator") };
  expect(canEditTaskRelations(task, "owner", false)).toBe(true);
  expect(canEditTaskRelations(task, "creator", false)).toBe(true);
  expect(canEditTaskRelations(task, "other", false)).toBe(false);
  expect(canEditTaskRelations(task, "other", true)).toBe(true);
  expect(canEditTaskRelations({ owner: null, creator: person("creator") }, null, false)).toBe(
    false,
  );
});

test("only a relation's own refusals are told apart", () => {
  expect(relationRefusal(new AppError("INVALID_INPUT", { errorId: "task_relation_invalid" }))).toBe(
    "invalid",
  );
  expect(relationRefusal(new AppError("ACCESS_DENIED", { errorId: "task_relation_denied" }))).toBe(
    "denied",
  );
  expect(relationRefusal(new AppError("INVALID_INPUT"))).toBeUndefined();
  expect(relationRefusal(new Error("offline"))).toBeUndefined();
});
