import { describe, expect, test } from "bun:test";
import {
  filterTaskForest,
  parentIds,
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
});
