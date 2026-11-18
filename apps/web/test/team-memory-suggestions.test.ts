import { expect, test } from "bun:test";
import {
  taskMemorySuggestion,
  duplicateMemorySuggestions,
} from "#src/server/team-memory/suggestions";

const task = {
  id: "00000000-0000-4000-8000-000000000001",
  revision: 2,
  status: "done",
  title: "Production rollout",
  description: "The rollout was accepted after the smoke checks.",
  projectId: null,
};

test("task acceptance is a sourced draft tied to the accepted revision", () => {
  expect(taskMemorySuggestion(task)).toMatchObject({
    key: `task:${task.id}:2`,
    draft: { title: task.title, evidence: [{ kind: "task", id: task.id, revision: 2 }] },
  });
  expect(taskMemorySuggestion({ ...task, status: "in_review" })).toBeUndefined();
});

test("duplicate suggestions preserve scope and fixed records", () => {
  const entry = {
    id: "one",
    title: "Deployment",
    content: "  The rollout passed. ",
    kind: "fact",
    applicability: "production",
    revision: 4,
    projectId: null,
    pinned: false,
  };
  expect(
    duplicateMemorySuggestions([
      entry,
      { ...entry, id: "staging", applicability: "staging" },
      { ...entry, id: "fixed", pinned: true },
      { ...entry, id: "two", content: "The rollout passed." },
    ]),
  ).toEqual([
    {
      key: "duplicate:one:4:two:4",
      keep: { id: "one", revision: 4 },
      duplicate: { id: "two", revision: 4 },
    },
  ]);
});
