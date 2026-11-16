import { describe, expect, test } from "bun:test";
import { CHOICE_OTHER_OPTION_ID } from "@lrm/coforge-sdk/agent";

import {
  answerText,
  cardQuestions,
  fitDrafts,
  givenAnswers,
  submission,
  type ChoiceView,
  type QuestionsView,
} from "#src/features/conversations/question-card-model";

const base = {
  messageId: "m1",
  state: "pending",
  canCommit: true,
  canCancel: true,
} as const;

const choice: ChoiceView = {
  ...base,
  kind: "choice",
  prompt: "Ship it?",
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  other: { label: "Something else" },
};

const questions: QuestionsView = {
  ...base,
  kind: "questions",
  prompt: "Before sign-up goes live",
  questions: [
    { id: "one", prompt: "One?", select: "one", options: [{ id: "a", label: "A" }], other: {} },
    {
      id: "many",
      prompt: "Many?",
      select: "many",
      options: [
        { id: "x", label: "X" },
        { id: "y", label: "Y" },
      ],
    },
  ],
};

describe("one card answers both kinds", () => {
  test("a choice card is one single-pick question, under its own prompt", () => {
    expect(cardQuestions(choice)).toEqual([
      {
        id: "choice",
        prompt: "Ship it?",
        select: "one",
        options: choice.options,
        other: { label: "Something else" },
      },
    ]);
    expect(cardQuestions(questions)).toBe(questions.questions);
  });

  test("a choice card sends its one pick, or the person's own words", () => {
    expect(submission(choice, {})).toBeUndefined();
    expect(submission(choice, { choice: { selection: ["no"], text: "" } })).toEqual({
      kind: "choice",
      optionId: "no",
    });
    expect(submission(choice, { choice: { selection: [], text: " later " } })).toEqual({
      kind: "choice",
      optionId: CHOICE_OTHER_OPTION_ID,
      text: "later",
    });
  });

  test("a questions card sends what was answered, nothing when nothing was", () => {
    expect(submission(questions, {})).toBeUndefined();
    expect(
      submission(questions, {
        one: { selection: [], text: "  " },
        many: { selection: ["y", "x"], text: "" },
      }),
    ).toEqual({ kind: "questions", answers: [{ questionId: "many", selection: ["y", "x"] }] });
  });
});

test("kept answers the card no longer offers are left behind", () => {
  expect(
    fitDrafts(cardQuestions(questions), {
      one: { selection: ["a", "gone"], text: "mine" },
      many: { selection: ["y"], text: "words nobody asked for" },
      dropped: { selection: ["a"], text: "" },
    }),
  ).toEqual({
    one: { selection: ["a"], text: "mine" },
    many: { selection: ["y"], text: "" },
  });
});

test("an answer reads as its labels, then the person's own words", () => {
  const [, many] = cardQuestions(questions);
  expect(answerText(many!, { selection: ["y", "x"], text: "" })).toEqual(["Y", "X"]);
  expect(answerText(many!, undefined)).toEqual([]);
  const [one] = cardQuestions(questions);
  expect(answerText(one!, { selection: [], text: " mine " })).toEqual(["mine"]);
});

describe("the answers a card was given, to show in the stream", () => {
  test("a choice card's pick, or words", () => {
    expect(
      givenAnswers({ ...choice, state: "executed", result: { optionId: "no", label: "No" } }),
    ).toEqual({ choice: { selection: ["no"], text: "" } });
    expect(
      givenAnswers({
        ...choice,
        state: "executed",
        result: { optionId: CHOICE_OTHER_OPTION_ID, label: "Something else", text: "later" },
      }),
    ).toEqual({ choice: { selection: [], text: "later" } });
    expect(givenAnswers(choice)).toEqual({});
  });

  test("a questions card's answers, a skipped one absent", () => {
    expect(
      givenAnswers({
        ...questions,
        state: "executed",
        result: {
          answers: [
            {
              questionId: "one",
              prompt: "One?",
              selection: [{ optionId: CHOICE_OTHER_OPTION_ID, label: "Other", text: "mine" }],
            },
          ],
        },
      }),
    ).toEqual({ one: { selection: [], text: "mine" } });
  });
});
