import { expect, test } from "bun:test";
import { modelMetadata } from "#src/features/computers/computer-model-metadata";

/** The catalog a Computer reports for each runtime provider's models; `supportsFastMode` is the
 * optional third-state field that tells the Agent runtime form whether the Fast switch applies. */
const model = {
  id: "gpt-example",
  displayName: "GPT Example",
  description: "Example model",
  modelProvider: "",
  reasoningEfforts: ["low", "high"],
  defaultReasoning: "low",
  recommended: true,
};

test("passes a boolean supportsFastMode through, true and false alike", () => {
  expect(
    modelMetadata([
      { ...model, supportsFastMode: true },
      { ...model, id: "other", supportsFastMode: false },
    ]),
  ).toEqual([
    { ...model, supportsFastMode: true },
    { ...model, id: "other", supportsFastMode: false },
  ]);
});

test("leaves an absent supportsFastMode absent", () => {
  const [entry] = modelMetadata([model]) ?? [];
  expect(entry).toEqual(model);
  expect(entry).not.toHaveProperty("supportsFastMode");
});

test("drops a non-boolean supportsFastMode and keeps the rest of the entry", () => {
  const [entry] = modelMetadata([{ ...model, supportsFastMode: "yes" }]) ?? [];
  expect(entry).toEqual(model);
  expect(entry).not.toHaveProperty("supportsFastMode");
});

test("an otherwise invalid entry still yields undefined", () => {
  expect(modelMetadata([{ ...model, displayName: 3, supportsFastMode: true }])).toBeUndefined();
  expect(modelMetadata("not-a-list")).toBeUndefined();
});
