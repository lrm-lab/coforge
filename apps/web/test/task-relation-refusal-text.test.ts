import { expect, test } from "bun:test";

import { errorText } from "#src/features/tasks/task-section";

/** A refused relation change names the Task it picked (task #525); without one, the sentence is
 * the general one it was. */

test("a refusal names the picked Task when there is one", () => {
  expect(errorText("denied", "#7")).toStartWith("Couldn't link #7: only the owner or creator");
  expect(errorText("invalid", "#design:#3")).toStartWith(
    "Couldn't link #design:#3: that would loop back",
  );
});

test("without a picked Task the sentence is the general one", () => {
  expect(errorText("denied")).toStartWith("Only the owner or creator");
  expect(errorText("invalid")).toStartWith("These tasks can't be linked");
});
