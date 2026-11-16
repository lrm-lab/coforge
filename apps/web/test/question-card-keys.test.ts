import { describe, expect, test } from "bun:test";

import { cardKey, type CardKeyState } from "#src/features/conversations/question-card-keys";
import type { CardQuestion } from "#src/features/conversations/question-card-model";

const one: CardQuestion = {
  id: "one",
  prompt: "One?",
  select: "one",
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
  other: {},
};
const many: CardQuestion = {
  id: "many",
  prompt: "Many?",
  select: "many",
  options: [
    { id: "x", label: "X" },
    { id: "y", label: "Y" },
  ],
};

const state = (patch: Partial<CardKeyState> = {}): CardKeyState => ({
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

describe("a question card's keys (Frank, 11-16: the dock's keys, in the card)", () => {
  test("Esc leaves the card for the composer; Alt+↑↓ goes to another waiting card", () => {
    expect(cardKey(state(), key("Escape"))).toEqual({ do: "leave" });
    expect(cardKey(state(), key("ArrowDown", { alt: true }))).toEqual({ do: "switch", by: 1 });
    expect(cardKey(state(), key("ArrowUp", { alt: true }))).toEqual({ do: "switch", by: -1 });
  });

  test("the first arrow only shows where the keys stand; the next ones move, round the rows", () => {
    expect(cardKey(state({ kbd: false }), key("ArrowDown"))).toEqual({ do: "showKeys" });
    // Two options and the person's own words: three rows.
    expect(cardKey(state({ hi: 2 }), key("ArrowDown"))).toEqual({ do: "view", tab: 0, hi: 0 });
    expect(cardKey(state({ hi: 0 }), key("ArrowUp"))).toEqual({ do: "view", tab: 0, hi: 2 });
  });

  test("←→ turn the question, landing on its first pick; there is nothing after the last", () => {
    const drafts = { many: { selection: ["y"], text: "" } };
    expect(cardKey(state({ drafts }), key("ArrowRight"))).toEqual({ do: "view", tab: 1, hi: 1 });
    expect(cardKey(state({ tab: 1 }), key("ArrowRight"))).toEqual({ do: "stay" });
    expect(cardKey(state({ tab: 0 }), key("ArrowLeft"))).toEqual({ do: "stay" });
  });

  test("a digit picks its row; Space picks the highlighted one", () => {
    expect(cardKey(state(), key("2"))).toEqual({ do: "pick", row: 1 });
    expect(cardKey(state(), key("3"))).toEqual({ do: "pick", row: 2 });
    expect(cardKey(state(), key("4"))).toEqual({ do: "pass" });
    expect(cardKey(state({ hi: 1 }), key(" "))).toEqual({ do: "pick", row: 1 });
  });

  test("Enter on a one-pick question takes the highlighted option and goes on", () => {
    expect(cardKey(state({ hi: 1 }), key("Enter"))).toEqual({ do: "confirm", row: 1 });
    // On the own-words row, or a many-pick question, it only goes on.
    expect(cardKey(state({ hi: 2 }), key("Enter"))).toEqual(NEXT);
    // The last question's Enter sends, once something is answered.
    expect(cardKey(state({ tab: 1 }), key("Enter"))).toEqual({ do: "stay" });
  });

  test("Enter never takes a row the person cannot see highlighted", () => {
    expect(cardKey(state({ kbd: false }), key("Enter"))).toEqual({ do: "showKeys" });
    const drafts = { one: { selection: ["a"], text: "" } };
    expect(cardKey(state({ kbd: false, drafts }), key("Enter"))).toEqual(NEXT);
  });

  test("on the last question, Enter sends, once any question is answered", () => {
    const drafts = { one: { selection: ["a"], text: "" } };
    expect(cardKey(state({ tab: 1, drafts }), key("Enter"))).toEqual({ do: "submit" });
    // A one-pick last question takes the highlighted option and sends with it.
    const last = { questions: [many, one], tab: 1 };
    expect(cardKey(state({ ...last, hi: 1 }), key("Enter"))).toEqual({ do: "confirm", row: 1 });
  });

  test("typing the person's own words: keys are text, Enter goes on, arrows still move", () => {
    const typing = { typing: true };
    expect(cardKey(state({ hi: 2 }), key("1", typing))).toEqual({ do: "pass" });
    expect(cardKey(state({ hi: 2 }), key(" ", typing))).toEqual({ do: "pass" });
    expect(cardKey(state({ hi: 2 }), key("ArrowLeft", typing))).toEqual({ do: "pass" });
    expect(cardKey(state({ hi: 2 }), key("Enter", typing))).toEqual(NEXT);
    expect(cardKey(state({ hi: 2 }), key("ArrowUp", typing))).toEqual({
      do: "view",
      tab: 0,
      hi: 1,
    });
  });

  test("a focused button keeps Enter and Space; shortcuts with a modifier are the browser's", () => {
    expect(cardKey(state(), key("Enter", { onControl: true }))).toEqual({ do: "pass" });
    expect(cardKey(state(), key(" ", { onControl: true }))).toEqual({ do: "pass" });
    expect(cardKey(state(), key("1", { mod: true }))).toEqual({ do: "pass" });
  });

  test("someone else's card: look through it, pick nothing", () => {
    const ro = state({ readOnly: true });
    expect(cardKey(ro, key("1"))).toEqual({ do: "pass" });
    expect(cardKey(ro, key("Enter"))).toEqual({ do: "pass" });
    expect(cardKey(ro, key("ArrowRight"))).toEqual({ do: "view", tab: 1, hi: 0 });
    expect(cardKey(state({ readOnly: true, tab: 1 }), key("ArrowRight"))).toEqual({ do: "stay" });
  });

  test("a card of one question: going on is sending, once answered", () => {
    const single = { questions: [one] };
    expect(cardKey(state({ ...single, hi: 2 }), key("Enter"))).toEqual({ do: "stay" });
    const drafts = { one: { selection: [], text: "mine" } };
    expect(cardKey(state({ ...single, hi: 2, drafts }), key("Enter"))).toEqual({ do: "submit" });
  });
});
