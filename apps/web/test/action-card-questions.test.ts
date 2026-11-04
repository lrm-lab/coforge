import { expect, test } from "bun:test";

import { questionsAnswers } from "#src/features/conversations/action-card-questions";
import {
  actionCardTitle,
  type ToolActionCardView,
} from "#src/features/conversations/action-card-labels";

const questions = [
  { id: "one", prompt: "One?", select: "one", options: [{ id: "a", label: "A" }], other: {} },
  { id: "many", prompt: "Many?", select: "many", options: [{ id: "x", label: "X" }] },
] as const satisfies Parameters<typeof questionsAnswers>[0];

test("a question left unanswered is left out of the submit, blank words too (Frank, 11-04)", () => {
  expect(questionsAnswers([...questions], {})).toEqual([]);
  expect(
    questionsAnswers([...questions], {
      one: { selection: [], text: "  " },
      many: { selection: ["x"], text: "" },
    }),
  ).toEqual([{ questionId: "many", selection: ["x"] }]);
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
