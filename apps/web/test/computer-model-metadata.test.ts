import { expect, test } from "bun:test";
import { modelMetadata } from "#src/features/computers/computer-model-metadata";

/** The catalog a Computer reports for each runtime provider's models. */
const model = {
  id: "gpt-example",
  displayName: "GPT Example",
  description: "Example model",
  modelProvider: "",
  reasoningEfforts: ["low", "high"],
  defaultReasoning: "low",
  recommended: true,
};

test("an entry an older daemon stored with supportsFastMode reads without it", () => {
  const [entry] = modelMetadata([{ ...model, supportsFastMode: true }]) ?? [];
  expect(entry).toEqual(model);
});

test("an otherwise invalid entry still yields undefined", () => {
  expect(modelMetadata([{ ...model, displayName: 3 }])).toBeUndefined();
  expect(modelMetadata("not-a-list")).toBeUndefined();
});
