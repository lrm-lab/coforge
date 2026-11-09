import { expect, test } from "bun:test";
import {
  RESET_CREDIT_ATTEMPT_TTL_MS,
  clearResetCreditAttempt,
  resetCreditAttemptKey,
} from "#src/features/computers/reset-credit-attempt";

const MINUTE = 60_000;
let computer = 0;
/** A Computer no other test touched: the key store is shared by the module. */
const fresh = () => `computer-${++computer}`;

test("a retry within the window reuses the attempt's key", () => {
  const computerId = fresh();
  const first = resetCreditAttemptKey(computerId, "codex", "a****@example.com", 0);
  expect(resetCreditAttemptKey(computerId, "codex", "a****@example.com", 5 * MINUTE)).toBe(first);
  expect(resetCreditAttemptKey(computerId, "codex", "a****@example.com", 9 * MINUTE)).toBe(first);
});

test("an abandoned key expires after ten minutes, so a later reset is a new attempt", () => {
  const computerId = fresh();
  const first = resetCreditAttemptKey(computerId, "codex", "a****@example.com", 0);
  const later = resetCreditAttemptKey(
    computerId,
    "codex",
    "a****@example.com",
    RESET_CREDIT_ATTEMPT_TTL_MS + 1,
  );
  expect(later).not.toBe(first);
  // The new key is the attempt now, and its own window runs from when it was made.
  expect(
    resetCreditAttemptKey(
      computerId,
      "codex",
      "a****@example.com",
      RESET_CREDIT_ATTEMPT_TTL_MS + MINUTE,
    ),
  ).toBe(later);
});

test("the window outlasts the 100 second poll and the 300 second result", () => {
  expect(RESET_CREDIT_ATTEMPT_TTL_MS).toBe(10 * MINUTE);
});

test("another account on the same runtime gets its own key", () => {
  const computerId = fresh();
  const first = resetCreditAttemptKey(computerId, "codex", "a****@example.com", 0);
  const other = resetCreditAttemptKey(computerId, "codex", "b****@example.com", MINUTE);
  expect(other).not.toBe(first);
  // Each account keeps its own attempt.
  expect(resetCreditAttemptKey(computerId, "codex", "a****@example.com", 2 * MINUTE)).toBe(first);
});

test("another Computer or runtime gets its own key", () => {
  const a = resetCreditAttemptKey(fresh(), "codex", "", 0);
  const b = resetCreditAttemptKey(fresh(), "codex", "", 0);
  expect(a).not.toBe(b);
});

test("a settled attempt is ended, and the next one is new", () => {
  const computerId = fresh();
  const first = resetCreditAttemptKey(computerId, "codex", "", 0);
  clearResetCreditAttempt(computerId, "codex", "");
  expect(resetCreditAttemptKey(computerId, "codex", "", MINUTE)).not.toBe(first);
});
