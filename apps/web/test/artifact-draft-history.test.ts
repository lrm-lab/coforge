import { expect, test } from "bun:test";
import {
  DRAFT_HISTORY_MAX,
  EMPTY_HISTORY,
  historyReducer,
  type DraftHistory,
  type DraftStep,
} from "#src/features/artifacts/artifact-draft-history";

const edit = (key: string, id = "d1"): DraftStep => ({ key, kind: "edit", id, from: "a", to: "b" });
const run = (history: DraftHistory, ...actions: Parameters<typeof historyReducer>[1][]) =>
  actions.reduce(historyReducer, history);
const keys = (steps: readonly DraftStep[]) => steps.map((step) => step.key);

test("a recorded step clears the redo stack and the stack keeps the newest sixty", () => {
  const undone = run(
    EMPTY_HISTORY,
    { type: "record", step: edit("a") },
    { type: "undone", key: "a" },
  );
  expect(keys(undone.future)).toEqual(["a"]);
  const recorded = historyReducer(undone, { type: "record", step: edit("b") });
  expect(recorded).toEqual({ past: [edit("b")], future: [] });
  const long = run(
    EMPTY_HISTORY,
    ...Array.from({ length: DRAFT_HISTORY_MAX + 5 }, (_, at) => ({
      type: "record" as const,
      step: edit(`s${at}`),
    })),
  );
  expect(long.past).toHaveLength(DRAFT_HISTORY_MAX);
  expect(long.past[0]!.key).toBe("s5");
});

test("a step moves between the stacks by key, and an unknown key changes nothing", () => {
  const held = run(
    EMPTY_HISTORY,
    { type: "record", step: edit("a") },
    { type: "record", step: edit("b") },
  );
  const undone = historyReducer(held, { type: "undone", key: "b" });
  expect([keys(undone.past), keys(undone.future)]).toEqual([["a"], ["b"]]);
  expect(historyReducer(undone, { type: "undone", key: "zzz" })).toBe(undone);
  const redone = historyReducer(undone, { type: "redone", key: "b" });
  expect([keys(redone.past), keys(redone.future)]).toEqual([["a", "b"], []]);
});

test("a dropped step leaves whichever stack held it, so older steps become reachable", () => {
  const held = run(
    EMPTY_HISTORY,
    { type: "record", step: edit("a") },
    { type: "record", step: edit("b") },
    { type: "record", step: edit("c") },
    { type: "undone", key: "c" },
  );
  expect(keys(historyReducer(held, { type: "drop", key: "b" }).past)).toEqual(["a"]);
  expect(keys(historyReducer(held, { type: "drop", key: "c" }).future)).toEqual([]);
});

test("a recreated draft's new id replaces the old one in every remaining step", () => {
  const held = run(
    EMPTY_HISTORY,
    { type: "record", step: edit("a", "old") },
    { type: "record", step: edit("b", "other") },
    { type: "record", step: edit("c", "old") },
    { type: "undone", key: "c" },
  );
  const rebound = historyReducer(held, { type: "rebind", from: "old", to: "new" });
  expect(rebound.past.map((step) => step.id)).toEqual(["new", "other"]);
  expect(rebound.future.map((step) => step.id)).toEqual(["new"]);
});
