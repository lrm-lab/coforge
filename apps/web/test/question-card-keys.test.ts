import { describe, expect, test } from "bun:test";

import { dockKey, type DockKeyState } from "#src/features/conversations/question-card-keys";
import type { DockQuestion } from "#src/features/conversations/question-card-model";

const one: DockQuestion = {
  id: "one",
  prompt: "One?",
  select: "one",
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
  other: {},
};
const many: DockQuestion = {
  id: "many",
  prompt: "Many?",
  select: "many",
  options: [
    { id: "x", label: "X" },
    { id: "y", label: "Y" },
  ],
};

const state = (patch: Partial<DockKeyState> = {}): DockKeyState => ({
  questions: [one, many],
  drafts: {},
  tab: 0,
  hi: 0,
  kbd: true,
  readOnly: false,
  ...patch,
});
/** Going on from the first question: to the second, at its first option. */
const NEXT = { do: "view", tab: 1, hi: 0 } as const;
const key = (
  k: string,
  patch: { alt?: boolean; mod?: boolean; typing?: boolean; onControl?: boolean } = {},
) => ({
  key: k,
  alt: false,
  mod: false,
  typing: false,
  onControl: false,
  ...patch,
});

describe("the dock's keys (Frank, 11-12)", () => {
  test("Esc puts the card off for later; Alt+↑↓ turns to another waiting card", () => {
    expect(dockKey(state(), key("Escape"))).toEqual({ do: "close" });
    expect(dockKey(state(), key("ArrowDown", { alt: true }))).toEqual({ do: "switch", by: 1 });
    expect(dockKey(state(), key("ArrowUp", { alt: true }))).toEqual({ do: "switch", by: -1 });
  });

  test("the first arrow only shows where the keys stand; the next ones move, round the rows", () => {
    expect(dockKey(state({ kbd: false }), key("ArrowDown"))).toEqual({ do: "showKeys" });
    // Two options and the person's own words: three rows.
    expect(dockKey(state({ hi: 2 }), key("ArrowDown"))).toEqual({ do: "view", tab: 0, hi: 0 });
    expect(dockKey(state({ hi: 0 }), key("ArrowUp"))).toEqual({ do: "view", tab: 0, hi: 2 });
  });

  test("←→ turn the question, landing on its first pick; the last one is the review", () => {
    const drafts = { many: { selection: ["y"], text: "" } };
    expect(dockKey(state({ drafts }), key("ArrowRight"))).toEqual({ do: "view", tab: 1, hi: 1 });
    expect(dockKey(state({ tab: 1 }), key("ArrowRight"))).toEqual({ do: "view", tab: 2, hi: 0 });
    expect(dockKey(state({ tab: 2 }), key("ArrowRight"))).toEqual({ do: "stay" });
    expect(dockKey(state({ tab: 0 }), key("ArrowLeft"))).toEqual({ do: "stay" });
  });

  test("a digit picks its row; Space picks the highlighted one", () => {
    expect(dockKey(state(), key("2"))).toEqual({ do: "pick", row: 1 });
    expect(dockKey(state(), key("3"))).toEqual({ do: "pick", row: 2 });
    expect(dockKey(state(), key("4"))).toEqual({ do: "pass" });
    expect(dockKey(state({ hi: 1 }), key(" "))).toEqual({ do: "pick", row: 1 });
  });

  test("Enter on a one-pick question takes the highlighted option and goes on", () => {
    expect(dockKey(state({ hi: 1 }), key("Enter"))).toEqual({ do: "confirm", row: 1 });
    // On the own-words row, or a many-pick question, it only goes on.
    expect(dockKey(state({ hi: 2 }), key("Enter"))).toEqual(NEXT);
    expect(dockKey(state({ tab: 1 }), key("Enter"))).toEqual({ do: "view", tab: 2, hi: 0 });
  });

  test("Enter never takes a row the person cannot see highlighted", () => {
    expect(dockKey(state({ kbd: false }), key("Enter"))).toEqual({ do: "showKeys" });
    const drafts = { one: { selection: ["a"], text: "" } };
    expect(dockKey(state({ kbd: false, drafts }), key("Enter"))).toEqual(NEXT);
  });

  test("on the review, Enter sends, once something is answered", () => {
    expect(dockKey(state({ tab: 2 }), key("Enter"))).toEqual({ do: "stay" });
    const drafts = { one: { selection: ["a"], text: "" } };
    expect(dockKey(state({ tab: 2, drafts }), key("Enter"))).toEqual({ do: "submit" });
    expect(dockKey(state({ tab: 2, drafts }), key("1"))).toEqual({ do: "pass" });
  });

  test("typing the person's own words: keys are text, Enter goes on, arrows still move", () => {
    const typing = { typing: true };
    expect(dockKey(state({ hi: 2 }), key("1", typing))).toEqual({ do: "pass" });
    expect(dockKey(state({ hi: 2 }), key(" ", typing))).toEqual({ do: "pass" });
    expect(dockKey(state({ hi: 2 }), key("ArrowLeft", typing))).toEqual({ do: "pass" });
    expect(dockKey(state({ hi: 2 }), key("Enter", typing))).toEqual(NEXT);
    expect(dockKey(state({ hi: 2 }), key("ArrowUp", typing))).toEqual({
      do: "view",
      tab: 0,
      hi: 1,
    });
  });

  test("a focused button keeps Enter and Space; shortcuts with a modifier are the browser's", () => {
    expect(dockKey(state(), key("Enter", { onControl: true }))).toEqual({ do: "pass" });
    expect(dockKey(state(), key(" ", { onControl: true }))).toEqual({ do: "pass" });
    expect(dockKey(state(), key("1", { mod: true }))).toEqual({ do: "pass" });
  });

  test("someone else's card: look through it, pick nothing", () => {
    const ro = state({ readOnly: true });
    expect(dockKey(ro, key("1"))).toEqual({ do: "pass" });
    expect(dockKey(ro, key("Enter"))).toEqual({ do: "pass" });
    expect(dockKey(ro, key("ArrowRight"))).toEqual({ do: "view", tab: 1, hi: 0 });
    // No review to turn to.
    expect(dockKey(state({ readOnly: true, tab: 1 }), key("ArrowRight"))).toEqual({ do: "stay" });
  });

  test("a card of one question has no review: going on is sending, once answered", () => {
    const single = { questions: [one] };
    expect(dockKey(state({ ...single, hi: 2 }), key("Enter"))).toEqual({ do: "stay" });
    const drafts = { one: { selection: [], text: "mine" } };
    expect(dockKey(state({ ...single, hi: 2, drafts }), key("Enter"))).toEqual({ do: "submit" });
  });
});
