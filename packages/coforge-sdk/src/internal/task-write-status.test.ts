import { expect, test } from "bun:test";
import {
  isTaskCreateStatus,
  isTaskWriteStatus,
  normalizeTaskWriteStatus,
  taskStatusNeedsOwner,
  type TaskWriteStatus,
} from "./tasks";

type MustBeNever<Value extends never> = Value;
export type InReviewIsNotWritable = MustBeNever<Extract<TaskWriteStatus, "in_review">>;

test("write-state guard includes backlog and excludes in_review", () => {
  expect(isTaskWriteStatus("backlog")).toBe(true);
  expect(isTaskWriteStatus("todo")).toBe(true);
  expect(isTaskWriteStatus("in_progress")).toBe(true);
  expect(isTaskWriteStatus("done")).toBe(true);
  expect(isTaskWriteStatus("closed")).toBe(true);
  expect(isTaskWriteStatus("in_review")).toBe(false);
  expect(isTaskCreateStatus("backlog")).toBe(true);
  expect(isTaskCreateStatus("todo")).toBe(true);
  expect(isTaskCreateStatus("in_progress")).toBe(true);
  expect(isTaskCreateStatus("in_review")).toBe(false);
  expect(isTaskCreateStatus("done")).toBe(false);
  expect(isTaskCreateStatus("closed")).toBe(false);
  expect(normalizeTaskWriteStatus("in_review")).toBe("in_progress");
  expect(normalizeTaskWriteStatus("backlog")).toBe("backlog");
  expect(taskStatusNeedsOwner("in_progress")).toBe(false);
  expect(taskStatusNeedsOwner("done")).toBe(false);
});
