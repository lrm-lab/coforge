import { expect, test } from "bun:test";

import {
  questionsAnswers,
  questionsComplete,
} from "#src/features/conversations/action-card-questions";
import {
  actionCardTitle,
  type ToolActionCardView,
} from "#src/features/conversations/action-card-labels";

const questions = [
  { id: "one", prompt: "One?", select: "one", options: [{ id: "a", label: "A" }], other: {} },
  { id: "many", prompt: "Many?", select: "many", options: [{ id: "x", label: "X" }] },
] as const satisfies Parameters<typeof questionsAnswers>[0];

test("a questions card can be sent only once every question has an answer (task #515)", () => {
  expect(questionsComplete([...questions], {})).toBe(false);
  expect(questionsComplete([...questions], { one: { selection: ["a"], text: "" } })).toBe(false);
  // Blank words are no answer.
  expect(
    questionsComplete([...questions], {
      one: { selection: [], text: "  " },
      many: { selection: ["x"], text: "" },
    }),
  ).toBe(false);
  expect(
    questionsComplete([...questions], {
      one: { selection: [], text: "mine" },
      many: { selection: ["x"], text: "" },
    }),
  ).toBe(true);
});

test("the person's own words go as `_other` with their text, only when there are some", () => {
  expect(
    questionsAnswers([...questions], {
      one: { selection: [], text: " mine " },
      many: { selection: ["x"], text: "" },
    }),
  ).toEqual([
    { questionId: "one", selection: ["_other"], text: "mine" },
    { questionId: "many", selection: ["x"] },
  ]);
});

test("every tool card kind has a title of its own, none falls back to another's", () => {
  const kinds: ToolActionCardView["kind"][] = [
    "channel:create",
    "channel:add_member",
    "agent:create",
    "app:grant_agent",
    "app:register",
    "app:recover_owner",
    "page:fill",
    "desktop:takeover",
  ];
  const titles = kinds.map((kind) => actionCardTitle({ kind } as ToolActionCardView));
  expect(new Set(titles).size).toBe(kinds.length);
  expect(() => actionCardTitle({ kind: "questions" } as unknown as ToolActionCardView)).toThrow();
});
