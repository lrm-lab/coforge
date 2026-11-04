import { describe, expect, test } from "bun:test";

import { nextSaveAttempt } from "#src/features/artifacts/artifact-save-attempt";

describe("a document save's idempotency key", () => {
  let n = 0;
  const newKey = () => `key-${++n}`;
  const first = nextSaveAttempt(null, { baseVersion: 3, text: "a" }, newKey);

  test("the retry of exactly the same save reuses its key, so it lands once", () => {
    expect(nextSaveAttempt(first, { baseVersion: 3, text: "a" }, newKey).key).toBe(first.key);
  });

  test("an edit after a failed save is a new save: the old key would answer the first one", () => {
    expect(nextSaveAttempt(first, { baseVersion: 3, text: "ab" }, newKey).key).not.toBe(first.key);
    expect(nextSaveAttempt(first, { baseVersion: 3, text: "a", title: "T" }, newKey).key).not.toBe(
      first.key,
    );
  });

  test("the same text over a newer base (a resolved conflict) is a new save", () => {
    expect(nextSaveAttempt(first, { baseVersion: 4, text: "a" }, newKey).key).not.toBe(first.key);
  });

  test("text and title are not confused", () => {
    const a = nextSaveAttempt(null, { baseVersion: 1, text: "x", title: "y" }, newKey);
    expect(nextSaveAttempt(a, { baseVersion: 1, text: "y", title: "x" }, newKey).key).not.toBe(
      a.key,
    );
  });
});
