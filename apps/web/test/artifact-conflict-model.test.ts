import { expect, test } from "bun:test";

import {
  keepingMine,
  type DocumentConflict,
} from "#src/features/artifacts/artifact-conflict-model";

const answer: DocumentConflict = {
  currentVersion: 8,
  files: [
    { path: "notes.md", chunks: [{ ok: "other file\n" }] },
    {
      path: "document.md",
      chunks: [
        { ok: "# Plan\n" },
        { conflict: { base: "A\n", mine: "A1\n", theirs: "A2\n" } },
        { ok: "middle\n" },
        { conflict: { base: "B\n", mine: "B1\n", theirs: "B2\n" } },
      ],
    },
  ],
  settings: [{ name: "title", base: "Plan", mine: "My plan", theirs: "Their plan" }],
};

test("a conflict saves again with the viewer's side, over the version that has the other", () => {
  expect(keepingMine(answer, "document.md")).toEqual({
    baseVersion: 8,
    text: "# Plan\nA1\nmiddle\nB1\n",
    settings: { title: "My plan" },
  });
});

test("a file the answer does not name falls back to its first", () => {
  expect(keepingMine(answer, "missing.md").text).toBe("other file\n");
});
