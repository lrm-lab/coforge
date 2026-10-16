import { expect, test } from "bun:test";

import { UNNAMED_PERSON_NAME } from "#src/features/auth/name-prefill";
import { compareHumanLabels, humanLabel } from "#src/lib/human-label";

test("a person is named by their display name, trimmed", () => {
  expect(humanLabel({ displayName: "  Ada Lovelace " })).toBe("Ada Lovelace");
});

test("a person is never named by their username, even with no name to show", () => {
  expect(humanLabel({ displayName: null })).toBe(UNNAMED_PERSON_NAME);
  expect(humanLabel({ displayName: undefined })).toBe(UNNAMED_PERSON_NAME);
  expect(humanLabel({ displayName: "   " })).toBe(UNNAMED_PERSON_NAME);
});

test("a row that carries more than the naming fields can be passed as it is", () => {
  const row = {
    id: "user-1",
    username: "ada",
    displayName: "Ada",
    avatarObjectKey: null,
  };
  expect(humanLabel(row)).toBe("Ada");
});

test("people sort by the name they are shown by, not by their username", () => {
  const people = [
    { username: "amy", displayName: "Zoe" },
    { username: "zed", displayName: "Alice" },
    { username: "mia", displayName: "Mia" },
  ];
  expect([...people].sort(compareHumanLabels).map(humanLabel)).toEqual(["Alice", "Mia", "Zoe"]);
});

test("labels that differ only in case sort together, and the username settles a tie", () => {
  const people = [
    { username: "b-alex", displayName: "Alex" },
    { username: "a-alex", displayName: "alex" },
    { username: "aaron", displayName: "Aaron" },
  ];
  expect([...people].sort(compareHumanLabels).map((person) => person.username)).toEqual([
    "aaron",
    "a-alex",
    "b-alex",
  ]);
});
