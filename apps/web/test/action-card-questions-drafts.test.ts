import { describe, expect, test } from "bun:test";

import {
  dropDrafts,
  keepDrafts,
  keptDrafts,
} from "#src/features/conversations/action-card-questions-drafts";

describe("a questions card's kept answers", () => {
  test("come back for the same card, and only for it", () => {
    keepDrafts("m1", { q1: { selection: ["a"], text: "" } });
    expect(keptDrafts("m1")).toEqual({ q1: { selection: ["a"], text: "" } });
    expect(keptDrafts("m2")).toEqual({});
    dropDrafts("m1");
  });

  test("are gone once the card is answered or nothing is left", () => {
    keepDrafts("m1", { q1: { selection: ["a"], text: "" } });
    dropDrafts("m1");
    expect(keptDrafts("m1")).toEqual({});
    keepDrafts("m2", { q1: { selection: ["a"], text: "" } });
    keepDrafts("m2", {});
    expect(keptDrafts("m2")).toEqual({});
  });
});
