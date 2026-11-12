import { expect, test } from "bun:test";
import { modelWithSizes } from "#src/model-size-override";

const model = {
  id: "claude-sonnet-4-6",
  provider: "anthropic",
  contextWindow: 200_000,
  maxTokens: 8_192,
};

test("the form's sizes win over the model's own, and one absent keeps the model's", () => {
  expect(modelWithSizes(model, { contextWindow: 400_000, maxOutputTokens: 64_000 })).toEqual({
    ...model,
    contextWindow: 400_000,
    maxTokens: 64_000,
  });
  // A number the person left empty is not a number: the model entry keeps its own.
  expect(modelWithSizes(model, { contextWindow: 400_000 })).toEqual({
    ...model,
    contextWindow: 400_000,
  });
});

test("with nothing filled in the launch keeps the very model it resolved", () => {
  expect(modelWithSizes(model, {})).toBe(model);
});
