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
