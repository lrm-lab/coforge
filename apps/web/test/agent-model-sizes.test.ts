import { expect, test } from "bun:test";
import {
  initialModelSizes,
  modelSizeInvalid,
  modelSizesDirty,
  submittedModelSize,
} from "#src/features/agents/agent-model-sizes";

test("the fields open with what the saved config filled in, and empty when it filled none", () => {
  expect(initialModelSizes({ contextWindow: 200_000, maxOutputTokens: 64_000 })).toEqual({
    contextWindow: "200000",
    maxOutputTokens: "64000",
  });
  expect(initialModelSizes({})).toEqual({ contextWindow: "", maxOutputTokens: "" });
  expect(initialModelSizes()).toEqual({ contextWindow: "", maxOutputTokens: "" });
});

test("an empty field submits nothing, and a nonsense number submits nothing either", () => {
  expect(submittedModelSize("")).toBeUndefined();
  expect(submittedModelSize("   ")).toBeUndefined();
  expect(submittedModelSize("200000")).toBe(200_000);
  for (const nonsense of ["0", "-1", "1.5", "abc", "20000001"])
    expect(submittedModelSize(nonsense)).toBeUndefined();
});

test("the dialog flags a size that is not a size, never an empty field", () => {
  expect(modelSizeInvalid("")).toBe(false);
  expect(modelSizeInvalid("200000")).toBe(false);
  expect(modelSizeInvalid("abc")).toBe(true);
});

test("sizes alone make the form dirty, and empty equals the config that filled none in", () => {
  const empty = { contextWindow: "", maxOutputTokens: "" };
  expect(modelSizesDirty(empty, {})).toBe(false);
  expect(modelSizesDirty({ contextWindow: "200000", maxOutputTokens: "" }, {})).toBe(true);
  expect(modelSizesDirty(empty, { contextWindow: 200_000, maxOutputTokens: 64_000 })).toBe(true);
  expect(
    modelSizesDirty(
      { contextWindow: "200000", maxOutputTokens: "64000" },
      { contextWindow: 200_000, maxOutputTokens: 64_000 },
    ),
  ).toBe(false);
});
