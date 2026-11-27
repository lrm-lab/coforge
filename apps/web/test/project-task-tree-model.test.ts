import { describe, expect, test } from "bun:test";
import { taskForest } from "#src/features/projects/project-task-tree-model";

describe("project task forest", () => {
  test("a parent loop lifts its Tasks to the top rather than hiding them", () => {
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
