import { expect, test } from "bun:test";

import { searchModelChoices } from "#src/features/agents/model-search";

const choices = [
  { id: "", label: "Default" },
  { id: "a", label: "SWE-2", keywords: ["swe-2", "Cognition's agent model"] },
  { id: "b", label: "Claude Opus 5.5", keywords: ["claude-opus-5-5", ""] },
  { id: "c", label: "Fusion (Claude Opus 5.5 Medium + SWE-2 Medium)", keywords: ["fusion-1"] },
  { id: "custom", label: "Custom…" },
];
const pinned = new Set(["", "custom"]);

test("an empty search shows every model in the runtime's order", () => {
  expect(searchModelChoices(choices, "  ", pinned).map((c) => c.id)).toEqual([
    "",
    "a",
    "b",
    "c",
    "custom",
  ]);
});

test("a search matches the name, id or description, ignoring case, and keeps the pinned entries", () => {
  expect(searchModelChoices(choices, "OPUS", pinned).map((c) => c.id)).toEqual([
    "",
    "b",
    "c",
    "custom",
  ]);
  expect(searchModelChoices(choices, "fusion-1", pinned).map((c) => c.id)).toEqual([
    "",
    "c",
    "custom",
  ]);
  expect(searchModelChoices(choices, "cognition", pinned).map((c) => c.id)).toEqual([
    "",
    "a",
    "custom",
  ]);
  expect(searchModelChoices(choices, "nothing", pinned).map((c) => c.id)).toEqual(["", "custom"]);
});
