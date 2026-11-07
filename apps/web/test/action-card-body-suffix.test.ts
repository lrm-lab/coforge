import { expect, test } from "bun:test";
import { actionCardBodySuffix } from "#src/server/conversations/agent-message-view.server";

test("choice executed includes the option id", () => {
  expect(
    actionCardBodySuffix({
      state: "executed",
      kind: "choice",
      result: { optionId: "password", label: "Password" },
    }),
  ).toBe("[action card: executed; choice=password]");
});

test("a person's own answer reads under the state, fenced", () => {
  expect(
    actionCardBodySuffix({
      state: "executed",
      kind: "choice",
      result: { optionId: "_other", label: "Something else", text: "first\nsecond" },
    }),
  ).toBe("[action card: executed; choice=_other]\n  │ first\n  │ second");
  expect(
    actionCardBodySuffix({
      state: "executed",
      kind: "questions",
      result: {
        answers: [
          { questionId: "webhook", selection: [{ optionId: "keep", label: "Keep it manual" }] },
          {
            questionId: "notify",
            selection: [{ optionId: "_other", label: "Something else", text: "ask Dana" }],
          },
        ],
      },
    }),
  ).toBe("[action card: executed; webhook=keep; notify=_other]\n  │ notify: ask Dana");
});

test("own words read beside picks and across several questions", () => {
  expect(
    actionCardBodySuffix({
      state: "executed",
      kind: "questions",
      result: {
        answers: [
          {
            questionId: "notify",
            selection: [
              { optionId: "ops", label: "Ops" },
              { optionId: "_other", label: "Something else", text: "and Dana" },
            ],
          },
          { questionId: "skip", selection: [], skipped: true },
          {
            questionId: "when",
            selection: [{ optionId: "_other", label: "Something else", text: "Friday\nmorning" }],
          },
        ],
      },
    }),
  ).toBe(
    "[action card: executed; notify=ops,_other; skip=(skipped); when=_other]" +
      "\n  │ notify: and Dana\n  │ when: Friday\n  │ morning",
  );
});

test("other cards keep the plain state suffix", () => {
  expect(actionCardBodySuffix({ state: "pending" })).toBe("[action card: pending]");
  expect(
    actionCardBodySuffix({
      state: "executed",
      kind: "page:fill",
      result: { filled: ["password"] },
    }),
  ).toBe("[action card: executed]");
  expect(
    actionCardBodySuffix({
      state: "executed",
      kind: "choice",
      result: { optionId: "BAD ID", label: "x" },
    }),
  ).toBe("[action card: executed]");
});

test("questions executed names each question's picks, a skipped one as skipped (task #515)", () => {
  expect(
    actionCardBodySuffix({
      state: "executed",
      kind: "questions",
      result: {
        answers: [
          { questionId: "webhook", selection: [{ optionId: "keep", label: "Keep it manual" }] },
          { questionId: "agent", selection: [], skipped: true },
          {
            questionId: "notify",
            selection: [
              { optionId: "ops", label: "Ops" },
              { optionId: "owner", label: "Owner" },
            ],
          },
        ],
      },
    }),
  ).toBe("[action card: executed; webhook=keep; agent=(skipped); notify=ops,owner]");
});
