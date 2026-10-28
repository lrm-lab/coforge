import { expect, test } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { devinEffortValues } from "#src/devin/efforts";

const select = (currentValue: string, values: string[]): SessionConfigOption => ({
  id: "thought_level",
  name: "Thinking",
  category: "thought_level",
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});

const model = (currentValue: string): SessionConfigOption => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue,
  options: [{ value: currentValue, name: currentValue }],
});

test("devinEffortValues reads the thought_level select, dropping provider default", () => {
  expect(
    devinEffortValues([model("swe-2-high"), select("high", ["medium", "high", "max", "default"])]),
  ).toEqual(["medium", "high", "max"]);
});

test("devinEffortValues is empty when the model has no effort select", () => {
  expect(devinEffortValues([model("adaptive")])).toEqual([]);
});

test("devinEffortValues keeps per-model sets as reported", () => {
  expect(
    devinEffortValues([model("deepseek-v4-pro-high"), select("high", ["high", "max"])]),
  ).toEqual(["high", "max"]);
  expect(
    devinEffortValues([
      model("gpt-6-sol-medium"),
      select("medium", ["none", "low", "medium", "high", "xhigh", "max"]),
    ]),
  ).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
});
