import { expect, test } from "bun:test";
import type { CommentDraftView } from "#src/features/artifacts/artifact-comment-drafts-queries";
import {
  DRAFT_HISTORY_MAX,
  EMPTY_HISTORY,
  historyReducer,
  snapshotOf,
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

test("an edit step retains optional anchor and path transitions across undo, redo, and rebind", () => {
  const step: DraftStep = {
    key: "k1",
    kind: "edit",
    id: "d1",
    from: "old",
    to: "{{<use> svg > use}} new",
    fromAnchor: null,
    toAnchor: { type: "element", data: { selector: "svg > use", quote: "<use>" } },
    fromPath: null,
    toPath: "index.html",
  };
  const undone = run(EMPTY_HISTORY, { type: "record", step }, { type: "undone", key: "k1" });
  const redone = historyReducer(undone, { type: "redone", key: "k1" });
  const rebound = historyReducer(redone, { type: "rebind", from: "d1", to: "d2" });
  expect(rebound.past[0]).toEqual({ ...step, id: "d2" });
});

test("snapshotOf omits null optionals, keeps present ones, and delete/rebind/clear preserve order", () => {
  const createdAt = new Date("2026-11-28T08:00:00.000Z");
  const expiresAt = new Date("2026-12-28T08:00:00.000Z");
  const bareDraft: CommentDraftView = {
    id: "d-bare",
    version: 2,
    path: null,
    anchor: null,
    replyTo: null,
    body: "Whole note",
    images: [],
    createdAt,
    expiresAt,
  };
  expect(snapshotOf(bareDraft)).toEqual({ version: 2, body: "Whole note", createdAt });

  const anchoredDraft: CommentDraftView = {
    id: "d-anchored",
    version: 3,
    path: "index.md",
    anchor: { type: "text", data: { quote: "Launch plan" } },
    replyTo: "root-1",
    body: "Check heading",
    images: [],
    createdAt,
    expiresAt,
  };
  const snapshot = snapshotOf(anchoredDraft);
  expect(snapshot).toEqual({
    version: 3,
    path: "index.md",
    anchor: { type: "text", data: { quote: "Launch plan" } },
    replyTo: "root-1",
    body: "Check heading",
    createdAt,
  });

  const deleted: DraftStep = { key: "del-1", kind: "delete", id: "d-anchored", snapshot };
  const undone = run(
    EMPTY_HISTORY,
    { type: "record", step: deleted },
    { type: "undone", key: "del-1" },
  );
  const reboundAfterUndo = historyReducer(undone, {
    type: "rebind",
    from: "d-anchored",
    to: "d-restored-1",
  });
  expect(reboundAfterUndo.future[0]?.id).toBe("d-restored-1");

  const redone = historyReducer(reboundAfterUndo, { type: "redone", key: "del-1" });
  expect(redone.past[0]?.id).toBe("d-restored-1");
  const undoneAgain = historyReducer(redone, { type: "undone", key: "del-1" });
  const reboundAgain = historyReducer(undoneAgain, {
    type: "rebind",
    from: "d-restored-1",
    to: "d-restored-2",
  });
  expect(reboundAgain.future[0]?.id).toBe("d-restored-2");
  expect(historyReducer(reboundAgain, { type: "clear" })).toEqual(EMPTY_HISTORY);
});
