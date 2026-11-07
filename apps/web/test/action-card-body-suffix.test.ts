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

test("a settled card names who settled it (task #691)", () => {
  expect(
    actionCardBodySuffix({ state: "cancelled", committedByUser: { username: "frankan" } }),
  ).toBe("[action card: cancelled by @frankan]");
  expect(
    actionCardBodySuffix({
      state: "executed",
      kind: "choice",
      result: { optionId: "a", label: "A" },
      committedByUser: { username: "andong3" },
    }),
  ).toBe("[action card: executed; choice=a by @andong3]");
  // A recommended pick keeps its marker ahead of the actor.
  expect(
    actionCardBodySuffix({
      state: "executed",
      kind: "choice",
      result: { optionId: "green", label: "Green", recommended: true },
      committedByUser: { username: "andong3" },
    }),
  ).toBe("[action card: executed; choice=green (recommended) by @andong3]");
  // Answered in their own words: the actor rides the state line, the words stay fenced.
  expect(
    actionCardBodySuffix({
      state: "executed",
      kind: "choice",
      result: { optionId: "_other", label: "Other", text: "ask Dana" },
      committedByUser: { username: "andong3" },
    }),
  ).toBe("[action card: executed; choice=_other by @andong3]\n  │ ask Dana");
  expect(
    actionCardBodySuffix({
      state: "executed",
      kind: "questions",
      result: {
        answers: [{ questionId: "q", selection: [{ optionId: "a", label: "A" }] }],
      },
      committedByUser: { username: "andong3" },
    }),
  ).toBe("[action card: executed; q=a by @andong3]");
  // No settled-by user — pending, expired, or a row read without the relation — is unchanged.
  expect(actionCardBodySuffix({ state: "cancelled" })).toBe("[action card: cancelled]");
  expect(actionCardBodySuffix({ state: "expired" })).toBe("[action card: expired]");
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
