import { describe, expect, test } from "bun:test";
import {
  filterTaskForest,
  parentIds,
  taskForest,
  type FilteredNode,
} from "#src/features/projects/project-task-tree-model";

type Task = { id: string; owner: string };
type Node = { task: Task; children: Node[] };
const node = (id: string, owner: string, children: Node[] = []): Node => ({
  task: { id, owner },
  children,
});

// launch (ada) ├ copy (bo) │ └ review (ada) └ assets (bo); notes (cy)
const forest = [
  node("launch", "ada", [node("copy", "bo", [node("review", "ada")]), node("assets", "bo")]),
  node("notes", "cy"),
];
const shape = (nodes: FilteredNode<Task>[]): unknown =>
  nodes.map((each) => [each.task.id, each.matched, shape(each.children)]);

describe("a Project's task tree under a filter (task #462)", () => {
  test("no filter keeps the whole tree, every node passing", () => {
    expect(shape(filterTaskForest<Task>(forest, () => true))).toEqual([
      [
        "launch",
        true,
        [
          ["copy", true, [["review", true, []]]],
          ["assets", true, []],
        ],
      ],
      ["notes", true, []],
    ]);
  });

  test("a passing sub-task keeps its ancestors, marked as not passing", () => {
    expect(shape(filterTaskForest<Task>(forest, (task) => task.id === "review"))).toEqual([
      ["launch", false, [["copy", false, [["review", true, []]]]]],
    ]);
  });

  test("a passing parent keeps only what passes below it", () => {
    expect(shape(filterTaskForest<Task>(forest, (task) => task.owner === "ada"))).toEqual([
      ["launch", true, [["copy", false, [["review", true, []]]]]],
    ]);
  });

  test("nothing passing leaves nothing", () => {
    expect(filterTaskForest<Task>(forest, () => false)).toEqual([]);
  });

  test("the parents to unfold are every node with children, at any depth", () => {
    expect(parentIds(filterTaskForest<Task>(forest, () => true))).toEqual(["launch", "copy"]);
  });

  test("a parent loop lifts its Tasks to the top rather than hiding them", () => {
    // a → b → a, with c under b; d alone.
    const tasks = [
      { id: "a", parentTaskId: "b" },
      { id: "b", parentTaskId: "a" },
      { id: "c", parentTaskId: "b" },
      { id: "d", parentTaskId: null },
    ];
    const ids = (nodes: ReturnType<typeof taskForest<(typeof tasks)[number]>>): unknown =>
      nodes.map((node) => [node.task.id, ids(node.children)]);
    expect(ids(taskForest(tasks))).toEqual([
      ["d", []],
      ["a", [["b", [["c", []]]]]],
    ]);
  });

  test("a parent not listed puts its sub-task at the top", () => {
    const ids = taskForest([
      { id: "x", parentTaskId: "gone" },
      { id: "y", parentTaskId: "x" },
    ]).map((node) => [node.task.id, node.children.map((child) => child.task.id)]);
    expect(ids).toEqual([["x", ["y"]]]);
  });
});
