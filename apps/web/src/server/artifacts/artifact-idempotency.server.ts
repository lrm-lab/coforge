import { AppError } from "#src/lib/app-error";

/** The refusal of an idempotency key already used for a different request: a mistake, not a retry. */
export const idempotencyMismatch = () =>
  new AppError("CONFLICT", {
    errorId: "artifact-idempotency-mismatch",
    hint: "this idempotency key was used for a different request",
  });
