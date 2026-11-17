import { expect, test } from "bun:test";

import {
  parseHiddenColumns,
  serializeHiddenColumns,
} from "#src/features/settings/task-hidden-columns";

/** The board's hidden columns are a per-device choice; every column shows until one is hidden. */
test("nothing stored, or nothing readable, hides no column", () => {
  expect([...parseHiddenColumns(null)]).toEqual([]);
  expect([...parseHiddenColumns("future_state,,")]).toEqual([]);
});

test("hidden columns round-trip in board order, unknown names ignored", () => {
  const hidden = parseHiddenColumns("closed,in_review,priority");
  expect([...hidden]).toEqual(["in_review", "closed"]);
  expect(serializeHiddenColumns(hidden)).toBe("in_review,closed");
});

test("an existing Backlog column can be hidden and restored", () => {
  expect(serializeHiddenColumns(parseHiddenColumns("backlog,todo"))).toBe("backlog,todo");
});
