import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  QUESTION_DRAFT_TTL_MS,
  pruneQuestionDrafts,
  readQuestionDrafts,
  subscribeQuestionDrafts,
  writeQuestionDrafts,
} from "#src/features/conversations/question-drafts";

let items: Map<string, string>;
let blocked: boolean;
const hadStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const hadWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const storageHandlers = new Set<(event: { key: string | null }) => void>();

beforeEach(() => {
  items = new Map();
  blocked = false;
  storageHandlers.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      if (blocked) throw new Error("SecurityError");
      return {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
        removeItem: (key: string) => void items.delete(key),
        get length() {
          return items.size;
        },
        key: (index: number) => [...items.keys()][index] ?? null,
      };
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: (type: string, handler: (event: { key: string | null }) => void) => {
        if (type === "storage") storageHandlers.add(handler);
      },
      removeEventListener: (type: string, handler: (event: { key: string | null }) => void) => {
        if (type === "storage") storageHandlers.delete(handler);
      },
    },
  });
});

afterEach(() => {
  if (hadWindow) Object.defineProperty(globalThis, "window", hadWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (hadStorage) Object.defineProperty(globalThis, "localStorage", hadStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const PICKED = { q1: { selection: ["a"], text: "" } };

test("a card's half-given answers stay on this device, for that card only (Frank, 11-12)", () => {
  writeQuestionDrafts("m1", PICKED);
  expect(readQuestionDrafts("m1")).toEqual(PICKED);
  expect(readQuestionDrafts("m2")).toEqual({});
  // Kept in storage, so a reload finds them.
  expect([...items.keys()]).toEqual(["coforge.question-draft:m1"]);
});

test("nothing left to keep removes the card's entry", () => {
  writeQuestionDrafts("m1", PICKED);
  writeQuestionDrafts("m1", {});
  expect(readQuestionDrafts("m1")).toEqual({});
  expect(items.size).toBe(0);
});

test("an unreadable entry or blocked storage reads as no answers, and never throws", () => {
  items.set("coforge.question-draft:m1", "{not json");
  expect(readQuestionDrafts("m1")).toEqual({});
  items.set(
    "coforge.question-draft:m2",
    JSON.stringify({ at: 1, drafts: { q1: { selection: 3 } } }),
  );
  expect(readQuestionDrafts("m2")).toEqual({});
  blocked = true;
  expect(readQuestionDrafts("m3")).toEqual({});
  expect(() => writeQuestionDrafts("m3", PICKED)).not.toThrow();
});

test("the same answers read twice are the same object, until they change", () => {
  writeQuestionDrafts("m1", PICKED);
  const first = readQuestionDrafts("m1");
  expect(readQuestionDrafts("m1")).toBe(first);
  writeQuestionDrafts("m1", { q1: { selection: ["b"], text: "" } });
  expect(readQuestionDrafts("m1")).not.toBe(first);
});

test("a write here and another tab's write are both heard, by card", () => {
  const heard: string[] = [];
  const stops = ["m1", "m2", "m3"].map((id) => subscribeQuestionDrafts(id, () => heard.push(id)));
  writeQuestionDrafts("m1", PICKED);
  items.set(
    "coforge.question-draft:m2",
    JSON.stringify({ at: Date.now(), drafts: { q1: { selection: ["z"], text: "" } } }),
  );
  for (const handler of storageHandlers) handler({ key: "coforge.question-draft:m2" });
  for (const handler of storageHandlers) handler({ key: "coforge.composer-draft:c1" });
  // Each card hears only its own: m3 heard nothing, and a composer draft is no card's.
  expect(heard).toEqual(["m1", "m2"]);
  expect(readQuestionDrafts("m2")).toEqual({ q1: { selection: ["z"], text: "" } });
  for (const stop of stops) stop();
  expect(storageHandlers.size).toBe(0);
});

test("answers no card can still take (past the longest a card waits) are cleared away", () => {
  const now = Date.UTC(2026, 10, 12);
  items.set(
    "coforge.question-draft:old",
    JSON.stringify({ at: now - QUESTION_DRAFT_TTL_MS - 1, drafts: PICKED }),
  );
  items.set("coforge.question-draft:new", JSON.stringify({ at: now - 1_000, drafts: PICKED }));
  items.set("coforge.composer-draft:c1", "hello");
  pruneQuestionDrafts(now);
  expect([...items.keys()].sort()).toEqual([
    "coforge.composer-draft:c1",
    "coforge.question-draft:new",
  ]);
});
