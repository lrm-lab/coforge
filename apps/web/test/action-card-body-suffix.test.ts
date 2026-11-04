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
