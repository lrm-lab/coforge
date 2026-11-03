import { expect, test } from "bun:test";

import {
  conflictProgress,
  ownDraft,
  resolutionOf,
  resolvedSettings,
  resolvedText,
  type DocumentConflict,
} from "#src/features/artifacts/artifact-conflict-model";

const answer = (theirs = "B2\n"): DocumentConflict => ({
  currentVersion: 8,
  files: [
    {
      path: "document.md",
      chunks: [
        { ok: "# Plan\n" },
        { conflict: { base: "A\n", mine: "A1\n", theirs: "A2\n" } },
        { ok: "middle\n" },
        { conflict: { base: "B\n", mine: "B1\n", theirs } },
      ],
    },
  ],
  settings: [{ name: "title", base: "Plan", mine: "My plan", theirs: "Their plan" }],
});

test("nothing is resolved until every conflict and setting is picked", () => {
  const resolution = resolutionOf(answer(), "document.md");
  expect(conflictProgress(resolution)).toEqual({ count: 3, picked: 0, done: false });
  expect(resolvedText(resolution)).toBeNull();
  expect(resolvedSettings(resolution)).toBeNull();
});

test("the picks join the agreed text in order, an own rewrite included", () => {
  const resolution = {
    ...resolutionOf(answer(), "document.md"),
    textChoices: ["theirs", { own: "mixed\n" }] as const,
    settingChoices: { title: "mine" } as const,
  };
  const picked = { ...resolution, textChoices: [...resolution.textChoices] };
  expect(conflictProgress(picked).done).toBe(true);
  expect(resolvedText(picked)).toBe("# Plan\nA2\nmiddle\nmixed\n");
  expect(resolvedSettings(picked)).toEqual({ title: "My plan" });
});

test("a conflict that came back unchanged keeps its pick; a changed one asks again", () => {
  const first = {
    ...resolutionOf(answer(), "document.md"),
    textChoices: ["mine", "theirs"] as ("mine" | "theirs")[],
    settingChoices: { title: "theirs" as const },
  };
  // Someone saved again while the viewer was picking: the second place changed on their side.
  const again = resolutionOf(answer("B3\n"), "document.md", first);
  expect(again.textChoices).toEqual(["mine", undefined]);
  expect(again.settingChoices).toEqual({ title: "theirs" });
  expect(conflictProgress(again)).toEqual({ count: 3, picked: 2, done: false });
});

test("an own rewrite starts from both sides, the viewer's first", () => {
  expect(ownDraft({ mine: "a", theirs: "b\n" })).toBe("a\nb\n");
  expect(ownDraft({ mine: "", theirs: "b\n" })).toBe("b\n");
  expect(ownDraft({ mine: "a\n", theirs: " " })).toBe("a\n");
});
