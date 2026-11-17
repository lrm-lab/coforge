import { expect, test } from "bun:test";
import { isTaskWriteStatus, type TaskCommand, type TaskWriteStatus } from "./tasks";

type MustBeNever<Value extends never> = Value;
export type BacklogIsNotWritable = MustBeNever<Extract<TaskWriteStatus, "backlog">>;
export type BacklogUpdateIsNotACommand = MustBeNever<
  Extract<
    {
      operation: "update";
      idempotencyKey: string;
      status: "backlog";
    },
    TaskCommand
  >
>;
export type BacklogCreateIsNotACommand = MustBeNever<
  Extract<
    {
      operation: "create";
      idempotencyKey: string;
      title: string;
      status: "backlog";
    },
    TaskCommand
  >
>;

test("the write-state guard excludes Backlog", () => {
  expect(isTaskWriteStatus("backlog")).toBe(false);
  expect(isTaskWriteStatus("todo")).toBe(true);
});
