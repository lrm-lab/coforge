import { expect, test } from "bun:test";
import { unsentGuidance } from "#src/features/conversations/unsent-guidance";
import { unsentReason } from "#src/features/conversations/composer-outbox";
import { AppError } from "#src/lib/app-error";

test("a send refused with a known errorId says what to do, and offers to connect a Computer", () => {
  const guidance = unsentGuidance("workspace-assistant-computer-required");
  expect(guidance?.action).toBe("connect-computer");
  expect(guidance?.message()).toContain("Computer");
});

test("any other or missing errorId keeps the generic failure sentence", () => {
  expect(unsentGuidance("something-else")).toBeUndefined();
  expect(unsentGuidance(undefined)).toBeUndefined();
});

test("the refusal stays retryable, so sending again after adding a Computer works", () => {
  const cause = new AppError("TEMPORARILY_UNAVAILABLE", {
    errorId: "workspace-assistant-computer-required",
  });
  expect(unsentReason(cause)).toBe("unavailable");
});
