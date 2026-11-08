import { expect, test } from "bun:test";

import { isVisibleTemplateSubmission } from "#src/server/records/template-submission-visibility.server";

test("draft template submissions stay hidden under the parent", () => {
  expect(isVisibleTemplateSubmission("draft")).toBe(false);
});

test("submitted template submissions are visible under the parent", () => {
  expect(isVisibleTemplateSubmission("submitted")).toBe(true);
});
