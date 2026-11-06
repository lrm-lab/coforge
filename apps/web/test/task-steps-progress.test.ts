import { expect, test } from "bun:test";

import { taskStepsProgressClass } from "#src/features/tasks/task-steps-progress";

test("a Task's step bar warms up to done: amber under half, blue past it, green when finished", () => {
  expect(taskStepsProgressClass(1, 4)).toBe("bg-warning-solid");
  expect(taskStepsProgressClass(2, 4)).toBe("bg-utility-blue-500");
  expect(taskStepsProgressClass(3, 4)).toBe("bg-utility-blue-500");
  expect(taskStepsProgressClass(4, 4)).toBe("bg-success-solid");
});
