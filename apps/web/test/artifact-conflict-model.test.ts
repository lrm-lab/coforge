import { expect, test } from "bun:test";

import {
  conflictProgress,
  ownDraft,
  resolutionOf,
  choose,
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

test("a save of the picks that conflicts again keeps them where they came back", () => {
  // The viewer picked their side, wrote one place themself, and took their title.
  const first = {
    ...resolutionOf(answer(), "document.md"),
    textChoices: ["mine", { own: "mixed\n" }] as ("mine" | { own: string })[],
    settingChoices: { title: "mine" as const },
  };
  expect(resolvedText(first)).toBe("# Plan\nA1\nmiddle\nmixed\n");
  // Saved over version 8 while version 9 changed the same places: the server's answer has the
  // picks as the viewer's side and version 8 as the base.
  const again = resolutionOf(
    {
      currentVersion: 9,
      files: [
        {
          path: "document.md",
          chunks: [
            { ok: "# Plan\n" },
            { conflict: { base: "A2\n", mine: "A1\n", theirs: "A3\n" } },
            { ok: "middle\n" },
            { conflict: { base: "B2\n", mine: "mixed\n", theirs: "B3\n" } },
            { ok: "end\n" },
            { conflict: { base: "C\n", mine: "C1\n", theirs: "C2\n" } },
          ],
        },
      ],
      settings: [{ name: "title", base: "Their plan", mine: "My plan", theirs: "New plan" }],
    },
    "document.md",
    first,
  );
  expect(again.textChoices).toEqual(["mine", { own: "mixed\n" }, undefined]);
  expect(again.settingChoices).toEqual({ title: "mine" });
  // The other side changed those places again (N3): the picks show, but count once confirmed,
  // so kept picks alone cannot write over what the viewer has not seen.
  expect(again.again).toEqual(["text:0", "text:1", "setting:title"]);
  expect(conflictProgress(again)).toEqual({ count: 4, picked: 0, done: false });
  const confirmed = choose(choose(choose(again, 0, "mine"), "title", "mine"), 2, "theirs");
  expect(conflictProgress(confirmed)).toEqual({ count: 4, picked: 3, done: false });
  const done = choose(confirmed, 1, { own: "mixed\n" });
  expect(done.again).toEqual([]);
  expect(conflictProgress(done)).toEqual({ count: 4, picked: 4, done: true });
});

test("a pick claims one place only, and none whose side is not its text", () => {
  const first = {
    ...resolutionOf(answer(), "document.md"),
    textChoices: ["theirs", undefined] as ("theirs" | undefined)[],
    settingChoices: {},
  };
  const again = resolutionOf(
    {
      currentVersion: 9,
      files: [
        {
          path: "document.md",
          chunks: [
            { conflict: { base: "x\n", mine: "A2\n", theirs: "y\n" } },
            { conflict: { base: "x\n", mine: "A2\n", theirs: "z\n" } },
            { conflict: { base: "x\n", mine: "B1\n", theirs: "w\n" } },
          ],
        },
      ],
      settings: [],
    },
    "document.md",
    first,
  );
  expect(again.textChoices).toEqual(["mine", undefined, undefined]);
});

test("an own rewrite starts from both sides, the viewer's first", () => {
  expect(ownDraft({ mine: "a", theirs: "b\n" })).toBe("a\nb\n");
  expect(ownDraft({ mine: "", theirs: "b\n" })).toBe("b\n");
  expect(ownDraft({ mine: "a\n", theirs: " " })).toBe("a\n");
});
